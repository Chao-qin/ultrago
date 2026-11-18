import { BadRequestException, Injectable, Inject, NotFoundException } from "@nestjs/common";
import { isParamMap, normalizeDelivery, parseConsoleDeliveries, type ResolvedDelivery } from "@bcp/shared";
import { describeOutputs } from "./output-type.js";
import { OutputLandingService } from "./output-landing.service.js";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service.js";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Monorepo root = 4 levels up from packages/console/src/runs/ (reports/ lives
// there). Anchored on __dirname, NOT process.cwd(): the sibling constant in
// delivery-executor.ts is __dirname-based, and under `pnpm dev:api` (cwd =
// packages/console) a cwd-based one would point somewhere else — artifact
// ownership would then be checked against a different directory than the one
// deliveries actually write to.
const REPORTS_DIR = process.env.BCP_DATA_ROOT ? resolve(process.env.BCP_DATA_ROOT, 'reports') : resolve(dirname(fileURLToPath(import.meta.url)), "../../../../reports");
const TERMINAL_RUN_STATUSES = new Set(["success", "failed", "escalated", "cancelled"]);
const ACCEPTED_RUN_STATUSES = new Set([...TERMINAL_RUN_STATUSES, "needsConfirm", "needsJudge", "noAction"]);

export interface DeliveryIngestArtifact {
  path: string;
  kind?: string;
  size?: number;
  mimeType?: string | null;
}

export interface DeliveryIngestInput {
  runId: string;
  planId: string;
  bookName: string;
  trigger?: string;
  mode?: string;
  status: string;
  ranSteps?: number;
  totalSteps?: number;
  durationMs?: number;
  error?: string;
  params?: Record<string, unknown>;
  outputs?: unknown;
  deliveries?: unknown[];
  artifacts?: DeliveryIngestArtifact[];
}

@Injectable()
export class DeliveryIngestService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OutputLandingService) private readonly outputLanding: OutputLandingService,
  ) {}

  async ingest(input: DeliveryIngestInput): Promise<{ runId: string; accepted: boolean; deliveryCount: number }> {
    this.validateInput(input);
    // `findFirst` + `deletedAt: null`, not `findUnique` on the name.
    //
    // This is a WRITE path: when `input.runId` is unknown it CREATES the run
    // row, and on a terminal status it queues that book's `deliveriesJson` as
    // DeliveryRun rows that then fire. `BooksService.delete` soft-deletes a
    // book and, in the same transaction, hand-cascades `deletedAt` onto its
    // runs, steps, deliveries and schedules — precisely so nothing of the book
    // is left live once the parent is gone. Looking the book up by name alone
    // let this endpoint mint fresh live children under that dead parent
    // immediately afterwards, undoing the cascade rather than tripping over it.
    //
    // Every sibling write-path book lookup already filters (books.service 107 /
    // 122 / 153 / 176, enqueue.service 111, schedules.service 131); this was
    // the only one that did not.
    const book = await this.prisma.book.findFirst({ where: { name: input.bookName, deletedAt: null } });
    if (!book) throw new NotFoundException(`book ${input.bookName} not found in console index`);

    let deliveries: ResolvedDelivery[];
    try {
      deliveries = input.deliveries === undefined
        ? parseConsoleDeliveries(book.deliveriesJson, "book.deliveriesJson")
        : input.deliveries.map(normalizeDelivery);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    const artifactPaths = (input.artifacts ?? []).map(normalizeArtifactPath);

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.run.findUnique({ where: { id: input.runId } });
      // Terminal snapshots are immutable. This makes retries and duplicate
      // HTTP delivery safe, and lets a user cancellation win a late backend
      // completion without relying on EventStore ordering.
      const existingTerminal = !!existing && TERMINAL_RUN_STATUSES.has(existing.status);
      const effectiveStatus = existingTerminal ? existing!.status : input.status;
      const terminal = TERMINAL_RUN_STATUSES.has(effectiveStatus);
      const described = input.outputs === undefined ? null : describeOutputs(input.outputs, book.outputSchema);
      const snapshotJson = existing?.deliverySnapshotJson ?? safeJson(deliveries);
      const queueDeliveries = existing?.deliverySnapshotJson
        ? parseConsoleDeliveries(existing.deliverySnapshotJson)
        : deliveries;
      const paramsJson = input.params === undefined ? existing?.paramsJson ?? "{}" : safeJson(input.params);
      const incomingRunData = {
          planId: input.planId,
          status: effectiveStatus,
          trigger: input.trigger ?? existing?.trigger ?? "mcp",
          mode: input.mode ?? existing?.mode ?? "auto",
          paramsJson,
          // The registry pin, not a copy of the book's inline schema: the
          // inline column is a filesync-owned cache, so a run that recorded it
          // would have its contract rewritten by the next playbook edit.
          paramSchemaRef: existing?.paramSchemaRef ?? book.paramSchemaRef,
          deliverySnapshotJson: snapshotJson,
          errorMessage: input.error ?? existing?.errorMessage ?? null,
          ranSteps: input.ranSteps ?? existing?.ranSteps ?? 0,
          totalSteps: input.totalSteps ?? existing?.totalSteps ?? book.stepsCount,
          durationMs: input.durationMs ?? existing?.durationMs ?? null,
          finishedAt: terminal ? existing?.finishedAt ?? new Date() : existing?.finishedAt ?? null,
          terminalIngestedAt: terminal ? existing?.terminalIngestedAt ?? new Date() : existing?.terminalIngestedAt ?? null,
        };
      const runData = existingTerminal ? {} : incomingRunData;

      const run = existing
        ? await tx.run.update({ where: { id: input.runId }, data: runData })
        : await tx.run.create({
          data: {
            id: input.runId,
            bookId: book.id,
            ...incomingRunData,
            queuedAt: new Date(),
            startedAt: new Date(),
            paramsJson,
          },
        });

      if (existing && existing.scheduleId && terminal && !TERMINAL_RUN_STATUSES.has(existing.status)) {
        await tx.schedule.update({
          where: { id: existing.scheduleId },
          data: { lastFiredStatus: effectiveStatus, ...(effectiveStatus === "success" ? { totalSuccess: { increment: 1 } } : {}) },
        });
      }

      // Paused states are observations, not conclusions. In particular, an
      // `on:any` delivery must wait for a later terminal snapshot.
      if (terminal) {
        for (const [deliveryIndex, delivery] of queueDeliveries.entries()) {
          const key = { runId: run.id, deliveryIndex };
          const prior = await tx.deliveryRun.findUnique({ where: { runId_deliveryIndex: key } });
          if (!prior) {
            await tx.deliveryRun.create({
              data: {
                runId: run.id,
                deliveryIndex,
                kind: delivery.kind,
                on: delivery.on,
                status: "pending",
                idempotencyKey: `${input.planId}:${deliveryIndex}`,
              },
            });
          }
        }
      }

      // 与终态同一事务提交，重试不能留下半份检查点或重写已接受的回执。
      if ((described || (terminal && run.flowNodeRunId)) && !existingTerminal) {
        await this.outputLanding.landRunOutput(run, described ?? describeOutputs(undefined, book.outputSchema), book.outputSchemaRef, tx);
      }

      // Files the run wrote get their own rows. They must exist before the
      // delivery rows above are executed: `verifyFile` refuses a file this run
      // does not own, and these rows are the record of which files those were.
      for (const artifactPath of artifactPaths) {
        await this.outputLanding.landArtifact(run.id, artifactPath, tx);
      }
      return { run, deliveryCount: terminal ? queueDeliveries.length : 0 };
    });

    return {
      runId: result.run.id,
      accepted: true,
      deliveryCount: result.deliveryCount,
    };
  }

  /** Materialize a terminal run's deliveries when the backend cannot emit its
   * own snapshot (user cancellation or bounded start failure). */
  async enqueueTerminal(runId: string, status: "success" | "failed" | "escalated" | "cancelled", error?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const run = await tx.run.findUnique({ where: { id: runId }, include: { book: { select: { deliveriesJson: true } } } });
      if (!run || !run.book) throw new NotFoundException(`run ${runId} not found`);
      const alreadyTerminal = TERMINAL_RUN_STATUSES.has(run.status);
      const alreadyIngested = !!run.terminalIngestedAt;
      const effectiveStatus = alreadyTerminal ? run.status : status;
      const source = run.deliverySnapshotJson ?? run.deliveryOverridesJson ?? run.book.deliveriesJson;
      const deliveries = source ? parseConsoleDeliveries(source) : [];
      await tx.run.update({
        where: { id: runId },
        data: {
          status: effectiveStatus,
          errorMessage: error ?? run.errorMessage,
          deliverySnapshotJson: run.deliverySnapshotJson ?? safeJson(deliveries),
          terminalIngestedAt: run.terminalIngestedAt ?? new Date(),
          finishedAt: run.finishedAt ?? new Date(),
        },
      });
      if (run.scheduleId && !alreadyIngested) {
        await tx.schedule.update({
          where: { id: run.scheduleId },
          data: { lastFiredStatus: effectiveStatus, ...(effectiveStatus === "success" ? { totalSuccess: { increment: 1 } } : {}) },
        });
      }
      for (const [deliveryIndex, delivery] of deliveries.entries()) {
        const prior = await tx.deliveryRun.findUnique({ where: { runId_deliveryIndex: { runId, deliveryIndex } } });
        if (!prior) {
          await tx.deliveryRun.create({
            data: { runId, deliveryIndex, kind: delivery.kind, on: delivery.on, status: "pending", idempotencyKey: `${run.planId ?? run.id}:${deliveryIndex}` },
          });
        }
      }
    });
  }

  async enqueueCancelled(runId: string): Promise<void> {
    return this.enqueueTerminal(runId, "cancelled", "cancelled by user");
  }

  private validateInput(input: DeliveryIngestInput): void {
    if (!input || typeof input !== "object") throw new BadRequestException("delivery ingest body must be an object");
    for (const key of ["runId", "planId", "bookName", "status"] as const) {
      if (typeof input[key] !== "string" || !input[key].trim()) throw new BadRequestException(`${key} is required`);
    }
    if (!ACCEPTED_RUN_STATUSES.has(input.status)) throw new BadRequestException(`unsupported run status ${input.status}`);
    if (input.deliveries !== undefined && !Array.isArray(input.deliveries)) throw new BadRequestException("deliveries must be an array");
    if (input.params !== undefined && !isParamMap(input.params)) throw new BadRequestException("params must be a plain object map");
  }
}

/** The report-relative path of one reported artifact. `size` / `mimeType` from
 *  the caller are discarded: the backend hard-codes `size: 0`, and the landing
 *  stats the file itself rather than repeat that lie. */
function normalizeArtifactPath(input: DeliveryIngestArtifact): string {
  if (!input || typeof input !== "object" || typeof input.path !== "string" || !input.path.trim()) throw new BadRequestException("artifact path is required");
  const raw = input.path.replaceAll("\\", "/");
  const candidate = raw.startsWith("reports/") ? raw.slice("reports/".length) : raw;
  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(REPORTS_DIR, candidate);
  const rel = relative(REPORTS_DIR, abs);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new BadRequestException(`artifact path escapes reports/: ${input.path}`);
  }
  return rel.replaceAll(sep, "/");
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? "null"; } catch { return "null"; }
}

export type DeliveryIngestTransaction = Prisma.TransactionClient;
