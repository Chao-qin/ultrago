import { Inject, Injectable, Logger } from "@nestjs/common";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Prisma } from "@prisma/client";
import { classifyOutput, runArtifactSource, runArtifactSourcePrefix, runProductSource } from "@bcp/shared";
import { readNodeOutput, storeNodeOutput } from '../flows/flow-output-storage.js';
import { PrismaService } from "../prisma/prisma.service.js";
import { RecordsService } from "../records/records.service.js";
import { decodeLandedPayload, planOutputRecord, type DescribedOutputs } from "./output-type.js";

export { runProductSource, runArtifactSource, flowProductSource } from "@bcp/shared";

// Monorepo root = 4 levels up from packages/console/src/runs/ (reports/ lives
// there). __dirname-based for the same reason as the sibling constants in
// delivery-executor.ts / delivery-ingest.service.ts: under `pnpm dev:api` the
// cwd is packages/console, and a cwd-based root would read a different tree
// than the one deliveries write to.
const REPORTS_DIR = process.env.BCP_DATA_ROOT ? path.join(process.env.BCP_DATA_ROOT, 'reports') : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../reports");

/** Extension for a stored file body. Only the media types `classifyOutput` can
 *  produce are listed; anything else is bytes we cannot name. */
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "application/json": "json",
  "text/markdown": "md",
  "text/plain": "txt",
};

/** Just the delegate this service touches, so a `$transaction` client and the
 *  bare PrismaService are equally acceptable callers. */
type SchemaRecordClient = Pick<Prisma.TransactionClient, "schemaRecord">;

/** A landed payload, as much of it as a reader needs to get the value back. */
interface LandedRow {
  data: string | null;
  fileName: string | null;
  contentType: string;
}

/**
 * Lands a payload as the one `SchemaRecord` row that owns it, and reads one
 * back.
 *
 * WHY A SERVICE AND NOT `output-type.ts`: that module is a pure function of
 * (value, schema) — it is what keeps the dispatcher's terminal poll and the
 * durable ingest agreeing on how a product is described, and it can stay pure
 * precisely because it never writes anything. Landing a payload writes a file
 * and a row, so the decision stays there (`planOutputRecord`) and only the
 * effects live here.
 *
 * WHEN: at terminal ingest, for every run that produced outputs — not when a
 * delivery fires. A landing place that only exists for runs configured with a
 * `db` delivery covers a subset, and a subset cannot be a source of truth.
 * (That `db` delivery kind is gone for exactly this reason.)
 */
@Injectable()
export class OutputLandingService {
  private readonly logger = new Logger(OutputLandingService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RecordsService) private readonly records: RecordsService,
  ) {}

  async landRunOutput(
    run: { id: string; flowNodeRunId?: string | null },
    described: DescribedOutputs,
    outputSchemaRef: string | null | undefined,
    tx: Pick<Prisma.TransactionClient, 'schemaRecord' | 'flowNodeRun'> = this.prisma,
  ): Promise<void> {
    if (!run.flowNodeRunId) {
      await this.land(runProductSource(run.id), described, outputSchemaRef, tx);
      return;
    }
    const node = await tx.flowNodeRun.findUnique({ where: { id: run.flowNodeRunId } });
    if (!node || node.runId !== run.id) throw new Error(`run ${run.id}: flow node ownership mismatch`);
    if (['success', 'failed', 'cancelled', 'skipped'].includes(node.status)
      && Object.hasOwn(readNodeOutput(node.outputJson), 'outputSchemaErrors')) return;
    const value = decodeLandedPayload(described.outputsData, described.outputsContentType);
    const wrapped = value === null || typeof value !== 'object' || Array.isArray(value);
    const outputJson = storeNodeOutput({
      outputs: wrapped ? { value } : value,
      ...(wrapped ? { outputValueIsWrapped: true } : {}),
      outputSchemaErrors: described.outputsSchemaErrors,
    }, node, (message) => this.logger.warn(message));
    const updated = await tx.flowNodeRun.updateMany({
      where: { id: node.id, runId: run.id, status: node.status, outputJson: node.outputJson }, data: { outputJson },
    });
    if (updated.count !== 1) throw new Error(`run ${run.id}: flow node changed while saving output`);
  }

  /** Idempotent in `source`: re-ingesting a run rewrites its row instead of
   *  adding a second one. `tx` lets a caller that already holds a transaction
   *  commit the row together with the rest of the terminal snapshot. */
  async land(
    source: string,
    described: DescribedOutputs,
    outputSchemaRef: string | null | undefined,
    tx: SchemaRecordClient = this.prisma,
  ): Promise<void> {
    const plan = planOutputRecord(described, outputSchemaRef);
    // Written before the row, and deliberately outside any transaction the
    // caller holds: a file cannot be rolled back. Content-hashed naming makes
    // that safe — a rolled-back landing leaves a file the retry writes to the
    // same name, not a second copy.
    const stored = plan.inline
      ? null
      : this.records.save(Buffer.from(plan.payload, "utf8"), fileNameFor(source, plan.contentType), plan.contentType);
    await this.upsertBySource(tx, source, {
      contentType: plan.contentType,
      schemaName: plan.schemaName,
      schemaVersion: plan.schemaVersion,
      schemaErrors: plan.schemaErrors,
      data: plan.inline ? plan.payload : null,
      fileName: stored?.fileName ?? null,
      url: stored?.url ?? null,
      bytes: plan.bytes,
      source,
    });
  }

  /**
   * Land one file a run wrote under `reports/` as its own row, keyed
   * `run:<runId>:artifact:<path>`.
   *
   * This is what replaced the `Artifact` table, and it is not bookkeeping for
   * its own sake: the `file` delivery refuses to report success for a file this
   * run did not write (`verifyFile`), and these rows are the only record of
   * which files that was — a redelivery happens long after the backend has
   * forgotten the run. Deleting the table without moving the rows would have
   * turned a guard that fires today into a silent pass.
   *
   * Two things it fixes on the way across: the bytes are STATTED, not taken
   * from `extractArtifacts`, which hard-codes `size: 0` (every one of the 6
   * migrated `Artifact` rows recorded 0 for a non-empty file); and the file
   * gets a `/api/records/` URL, which `Artifact` never had.
   *
   * A file that cannot be read lands NO row, so the delivery reports "not owned
   * by this run" rather than a dead link claiming otherwise.
   */
  async landArtifact(runId: string, reportPath: string, tx: SchemaRecordClient = this.prisma): Promise<void> {
    const absolute = path.resolve(REPORTS_DIR, reportPath);
    let bytes: Buffer;
    try {
      // An empty file is skipped rather than special-cased: RecordsService
      // refuses an empty body, and the `data`/`url` CHECK leaves no third
      // branch to put it on.
      if (statSync(absolute).size === 0) throw new Error("file is empty");
      bytes = readFileSync(absolute);
    } catch (e) {
      this.logger.warn(
        `run ${runId} artifact "${reportPath}" not landed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    // Sniff before trusting the extension, and only for JSON: the migration of
    // the old table hit `1122askdjask.md` whose bytes are JSON. Anything the
    // sniff can't claim gets "" so RecordsService falls back to its own
    // extension table, which is the one that knows about .png and friends.
    const sniffed = classifyOutput(bytes.toString("utf8")).type === "json" ? "application/json" : "";
    const stored = this.records.save(bytes, reportPath, sniffed);
    await this.upsertBySource(tx, runArtifactSource(runId, reportPath), {
      contentType: stored.mimeType,
      schemaName: null,
      schemaVersion: null,
      // An artifact is a file, not a product checked against the book's
      // `outputSchema` — the check ran on the product and is recorded there.
      schemaErrors: null,
      data: null,
      fileName: stored.fileName,
      url: stored.url,
      bytes: stored.size,
      source: runArtifactSource(runId, reportPath),
    });
  }

  /** The report-relative paths a run is known to have written. The `file`
   *  delivery's ownership check reads this. */
  async listRunArtifactPaths(runId: string): Promise<string[]> {
    const prefix = runArtifactSourcePrefix(runId);
    const rows = await this.prisma.schemaRecord.findMany({
      where: { source: { startsWith: prefix }, deletedAt: null },
      select: { source: true },
    });
    return rows.map((r) => r.source!.slice(prefix.length));
  }

  /** The value a landed payload holds, or `undefined` when nothing was landed
   *  for that source. The file branch is read back from disk; a row pointing at
   *  bytes that are gone throws rather than reporting an empty product. */
  async readLandedValue(source: string): Promise<unknown> {
    const row = await this.prisma.schemaRecord.findFirst({
      where: { source, deletedAt: null },
      select: { data: true, fileName: true, contentType: true },
    });
    if (row) return this.decodeRow(row);
    const match = /^run:([^:]+)$/.exec(source);
    if (!match) return undefined;
    const node = await this.prisma.flowNodeRun.findFirst({
      where: { runId: match[1], deletedAt: null }, select: { outputJson: true },
    });
    const checkpoint = readNodeOutput(node?.outputJson);
    return checkpoint.outputValueIsWrapped === true
      ? (checkpoint.outputs as { value?: unknown } | undefined)?.value
      : checkpoint.outputs;
  }

  private decodeRow(row: LandedRow): unknown {
    const payload = row.data ?? readFileSync(this.records.resolveStored(row.fileName!), "utf8");
    return decodeLandedPayload(payload, row.contentType);
  }

  private async upsertBySource(
    tx: SchemaRecordClient,
    source: string,
    data: Prisma.SchemaRecordUncheckedCreateInput,
  ): Promise<void> {
    const existing = await tx.schemaRecord.findFirst({ where: { source, deletedAt: null }, select: { id: true } });
    if (existing) {
      await tx.schemaRecord.update({ where: { id: existing.id }, data });
      return;
    }
    try {
      await tx.schemaRecord.create({ data });
    } catch (error) {
      // `uniq_active_record_source` is a PARTIAL index (`WHERE source IS NOT
      // NULL AND deletedAt IS NULL`), which Prisma's schema language cannot
      // express — so `upsert({ where: { source } })` does not typecheck and the
      // read-then-write above IS the upsert. The index is what makes that safe:
      // the dispatcher's terminal poll and a durable ingest can reach here for
      // the same run at the same moment, and the loser gets a unique violation
      // instead of a second row. Re-read and update, which is what it would
      // have done had it read a moment later; anything else rethrows.
      const raced = await tx.schemaRecord.findFirst({ where: { source, deletedAt: null }, select: { id: true } });
      if (!raced) throw error;
      await tx.schemaRecord.update({ where: { id: raced.id }, data });
    }
  }
}

/** `<source with ':' as '-'>.<ext>`. The colon would be dropped outright by
 *  RecordsService's sanitizer, gluing the two halves together — `run-<id>` says
 *  what the file is; `run<id>` reads like a typo. */
function fileNameFor(source: string, contentType: string): string {
  return `${source.replaceAll(":", "-")}.${EXTENSION_BY_CONTENT_TYPE[contentType] ?? "bin"}`;
}
