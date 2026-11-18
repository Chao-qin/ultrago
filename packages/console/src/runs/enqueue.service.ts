/**
 * 软删立场（本文件通篇适用）：去重与占位查询不按 deletedAt 过滤。
 *
 * 唯一索引是全量的——`uniq_book_active_dedupe` 建在 `Run(bookId, dedupeKey)` 上，
 * 不带 `WHERE deletedAt IS NULL`；全仓只有 `uniq_active_record_source`
 * （SchemaRecord）那一个是部分索引。所以软删的行仍然占着唯一键。去重若看不见
 * 它们，就会判定「没有重复」然后插入，撞上 P2002 —— 而那时已经没有可以让位的
 * 赢家，冲突无从恢复。
 */
import { BadRequestException, Injectable, Logger, NotFoundException, Inject, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service.js";
import { SchemasService } from "../schemas/schemas.service.js";
import { isParamMap, normalizeDelivery, normalizeParams as normalizeSharedParams, parseConsoleDeliveries, parseConsoleParamSchema, resolveParamDefaults, validateParams } from "@bcp/shared";
import type { DefaultContext, Delivery, ParamMap, ParamSchemaFragment, ParamSchemaResolver, ParamSpec, ResolvedDelivery } from "@bcp/shared";

/** Where a run came from.
 *
 * "flow" is a run started as a node inside a flow. It is its own value rather
 * than reusing "api" so the run list can tell orchestrated work apart from an
 * external caller. The backend has no such distinction and folds anything it
 * does not know onto "manual" (internal-runner.ts) — that is fine, because the
 * distinction only matters to this side. */
export type RunTrigger = "manual" | "schedule" | "api" | "flow";
export type RunMode = "assisted" | "auto";
export interface EnqueueInput {
  bookId: string;
  params: ParamMap;
  mode: RunMode;
  trigger: RunTrigger;
  timezone?: string;
  /** Optional caller-supplied idempotency key (preferred). The two triggers
   *  that don't pass one (`schedule`, `retry`) derive their own below. */
  dedupeKey?: string;
  /** Set when retrying an existing run — links them in the chain. */
  parentRunId?: string;
  /** Retry-chain attempt number. Fresh runs remain at Prisma's default 1. */
  attempt?: number;
  /** Set when triggered by a Schedule — linked to Schedule.id and used to
   *  update lastFired* / stats on the schedule after enqueue. */
  scheduleId?: string;
  flowNodeRunId?: string;
  deliveryOverrides?: Delivery[];
}

/** Outcome of an enqueue call. `deduped` means an earlier run for the same
 *  (bookId, dedupeKey) is still active and we just returned it — the new
 *  request was collapsed onto it. */
export interface EnqueueResult {
  run: {
    id: string;
    /** Nullable since the Run model is target-agnostic; a book enqueue always
     *  sets it. */
    bookId: string | null;
    status: string;
    trigger: string;
    mode: string;
    queuedAt: Date;
    dedupeKey: string | null;
  };
  /** True when the same book already has an active run and this one is
   *  sitting in the queue. The UI surfaces this as "queued — waiting for
   *  the previous run to finish". */
  queued: boolean;
  /** Position in the per-book queue (1 = first to run after the active one). */
  position: number;
  /** True when we matched an existing active run for the same dedupeKey
   *  and reused it (no new run was created). Pairs with `run` pointing at
   *  the EXISTING run. */
  deduped: boolean;
}

export function normalizeEnqueueParams(paramSchema: string, input: ParamMap, context: DefaultContext, resolveCitation?: ParamSchemaResolver): ParamMap {
  if (!isParamMap(input)) throw new BadRequestException("params must be a plain object map");
  let declared: ParamSpec[];
  try { declared = parseConsoleParamSchema(paramSchema); } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : String(error));
  }
  const values = resolveParamDefaults(declared, input, context, resolveCitation);
  const normalized = normalizeSharedParams(declared, values, resolveCitation);
  const errors = validateParams(declared, normalized, resolveCitation);
  if (errors.length) throw new BadRequestException(errors.join("; "));
  return normalized;
}

/** 5-second window for manual-trigger dedup: a double-clicked "Trigger"
 *  button collapses to one run. Anything longer is a deliberate second
 *  trigger and gets its own run. */
const MANUAL_DEDUPE_WINDOW_MS = 5_000;

@Injectable()
export class EnqueueService {
  private readonly logger = new Logger(EnqueueService.name);
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(SchemasService) private readonly schemas?: SchemasService,
  ) {}

  /**
   * Insert a new run while enforcing TWO invariants atomically:
   *
   *   1. The single-book-at-a-time invariant: no two pending/queued runs
   *      of the same book execute concurrently. New triggers on a busy
   *      book join the queue.
   *
   *   2. The dedupeKey invariant: two enqueues with the same (bookId,
   *      dedupeKey) collapse to one active run. The DB's
   *      `uniq_book_active_dedupe` unique index refuses the second insert;
   *      we catch the P2002 and re-read to return the original. This makes
   *      the manual "Trigger" button idempotent against double-clicks and
   *      a cron tick that re-evaluates the same window safe.
   *
   * Concurrency: the whole read-then-insert runs in a Prisma `$transaction`
   * (SQLite DEFERRED + WAL + busy_timeout=5s). When two triggers for the
   * SAME book race, one gets a write lock first; the second's INSERT
   * either waits (read-then-write) or hits the unique index (same dedupeKey)
   * and we return the winner. Prisma's transaction wrapper owns the
   * COMMIT/ROLLBACK — we don't try to layer our own `BEGIN IMMEDIATE` on
   * top (which fails with "cannot start a transaction within a
   * transaction" — Prisma already opened one).
   */
  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    // The single gate every trigger passes through — manual, schedule, api and
    // flow all arrive here. Refusing a deleted book once, in this one place,
    // is what stops new work being created for it by any route.
    const book = await this.prisma.book.findFirst({ where: { id: input.bookId, deletedAt: null } });
    if (!book) throw new NotFoundException(`book ${input.bookId} not found`);
    // Allocate the execution identity before resolving defaults. The plan id is
    // deterministic from the run id so a dispatcher retry can reuse the same
    // frozen context without adding a new state-machine field.
    const runId = randomUUID();
    const planId = `plan_${runId}`;
    const dedupeKey = this.deriveDedupeKey(input);
    let declared: ParamSpec[];
    try { declared = parseConsoleParamSchema(book.paramSchema); } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    const resolver = await this.paramResolver(declared);
    const normalizedParams = normalizeEnqueueParams(book.paramSchema, input.params, {
      bookName: book.name,
      runId,
      planId,
      uuid: randomUUID(),
      timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, resolver);
    if (input.deliveryOverrides !== undefined && !Array.isArray(input.deliveryOverrides)) {
      throw new BadRequestException("deliveryOverrides must be an array");
    }
    let bookDeliveries: ResolvedDelivery[];
    let deliveryOverrides: ResolvedDelivery[] | undefined;
    try {
      bookDeliveries = parseConsoleDeliveries(book.deliveriesJson, "book.deliveriesJson");
      deliveryOverrides = input.deliveryOverrides === undefined
        ? undefined
        : input.deliveryOverrides.map(normalizeDelivery);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    const deliverySnapshot = freezeDeliveries(deliveryOverrides ?? bookDeliveries, normalizedParams);
    const prepared = {
      ...input,
      params: normalizedParams,
      deliveryOverrides: deliveryOverrides ? freezeDeliveries(deliveryOverrides, normalizedParams) : undefined,
      deliverySnapshot,
    };

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // NONE of the lookups in this transaction filter `deletedAt`, and
          // that is load-bearing rather than an oversight.
          //
          // Step 1 has to agree with the `uniq_book_active_dedupe` index,
          // which knows nothing about soft deletes. Skipping a deleted row
          // here would send us to INSERT, hit P2002, and land in
          // dedupedResult() looking for a winner it had just agreed to ignore
          // — the "unique violation but no active winner found" throw below.
          //
          // Step 2 is the per-book single-flight invariant: an in-flight run
          // occupies its book whether or not someone withdrew it.
          //
          // 定时触发的唯一键永久对应一个计划时刻，终态也不能重复入队。
          if (dedupeKey) {
            const existing = await tx.run.findFirst({
              where: {
                bookId: prepared.bookId,
                dedupeKey,
                ...(prepared.trigger === 'schedule' ? {} : { status: { in: ['pending', 'queued', 'starting', 'running'] } }),
              },
            });
            if (existing) {
              if (prepared.flowNodeRunId) {
                if (existing.flowNodeRunId && existing.flowNodeRunId !== prepared.flowNodeRunId) throw new BadRequestException('run already belongs to another flow node');
                await this.linkFlowNode(tx, existing.id, prepared.flowNodeRunId);
                await tx.run.update({ where: { id: existing.id }, data: { flowNodeRunId: prepared.flowNodeRunId } });
              }
              const ahead = await tx.run.count({
                where: {
                  bookId: prepared.bookId,
                  status: "queued",
                  queuedAt: { lt: existing.queuedAt },
                },
              });
              return {
                run: existing,
                queued: existing.status === "queued",
                position: existing.status === "queued" ? ahead + 1 : 0,
                deduped: true,
              };
            }
          }

          // Step 2: per-book single-flight check. Active run on this book?
          const active = await tx.run.findFirst({
            where: {
              bookId: prepared.bookId,
              status: { in: ["pending", "running", "starting", "queued"] },
            },
            orderBy: { queuedAt: "asc" },
          });

          if (active) {
            // Same book is busy. The new run joins the queue. We compute
            // position so the UI can show "queued, position 2".
            const ahead = await tx.run.count({
              where: {
                bookId: prepared.bookId,
                status: "queued",
                queuedAt: { lt: new Date() },
              },
            });
            const run = await tx.run.create({
              data: {
                id: runId,
                bookId: prepared.bookId,
                targetType: "book",
                targetKey: `book:${prepared.bookId}`,
                trigger: prepared.trigger,
                mode: prepared.mode,
                status: "queued",
                paramsJson: JSON.stringify(prepared.params),
                paramSchemaRef: book.paramSchemaRef,
                deliveryOverridesJson: prepared.deliveryOverrides ? JSON.stringify(prepared.deliveryOverrides) : null,
                deliverySnapshotJson: JSON.stringify(prepared.deliverySnapshot),
                parentRunId: prepared.parentRunId,
                attempt: prepared.attempt,
                dedupeKey,
                scheduleId: prepared.scheduleId,
                flowNodeRunId: prepared.flowNodeRunId,
              },
            });
            await this.linkFlowNode(tx, run.id, prepared.flowNodeRunId);
            if (prepared.scheduleId) {
              await this.touchSchedule(tx, prepared.scheduleId, run.id, "queued");
            }
            return { run, queued: true, position: ahead + 1, deduped: false };
          }

          // No active run on this book — go straight to pending. The
          // DispatcherService will pick it up within ~200ms and POST to
          // backend's /internal/run.
          const run = await tx.run.create({
            data: {
              id: runId,
              bookId: prepared.bookId,
              targetType: "book",
              targetKey: `book:${prepared.bookId}`,
              trigger: prepared.trigger,
              mode: prepared.mode,
              status: "pending",
              paramsJson: JSON.stringify(prepared.params),
              // The registry pin, not the inline `Book.paramSchema` it replaced:
              // filesync rewrites that column on every scan, so recording it per
              // run would let editing a playbook rewrite what past runs meant.
              paramSchemaRef: book.paramSchemaRef,
              deliveryOverridesJson: prepared.deliveryOverrides ? JSON.stringify(prepared.deliveryOverrides) : null,
              deliverySnapshotJson: JSON.stringify(prepared.deliverySnapshot),
              parentRunId: prepared.parentRunId,
              attempt: prepared.attempt,
              dedupeKey,
              scheduleId: prepared.scheduleId,
              flowNodeRunId: prepared.flowNodeRunId,
            },
          });
          await this.linkFlowNode(tx, run.id, prepared.flowNodeRunId);
          if (prepared.scheduleId) {
            await this.touchSchedule(tx, prepared.scheduleId, run.id, "pending");
          }
          return { run, queued: false, position: 0, deduped: false };
        },
        { timeout: 10_000 },
      );
    } catch (e) {
      // Lost the dedupe race: another transaction inserted a row with the
      // same (bookId, dedupeKey) between our SELECT and INSERT. Re-read and
      // return the winner. This is the path hit when the user double-clicks
      // the "Trigger" button hard enough to slip past the application check
      // — the unique index is the final word.
      if (dedupeKey && this.isUniqueViolation(e)) {
        return this.dedupedResult(prepared.bookId, dedupeKey, prepared.trigger === 'schedule', prepared.flowNodeRunId);
      }
      throw e;
    }
  }

  private async paramResolver(specs: ParamSpec[]): Promise<ParamSchemaResolver | undefined> {
    if (!this.schemas) return undefined;
    const cache = new Map<string, ParamSchemaFragment | null>();
    for (const spec of specs) {
      if (!spec.schemaRef) continue;
      const ref = spec.schemaRef;
      try {
        const row = await this.schemas.resolve(ref.name, ref.version);
        const parsed = JSON.parse(row.jsonSchema);
        cache.set(`${ref.name}@${ref.version}`, parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ParamSchemaFragment : null);
      } catch {
        cache.set(`${ref.name}@${ref.version}`, null);
      }
    }
    return (ref) => cache.get(`${ref.name}@${ref.version}`) ?? null;
  }

  /** Update Schedule's denormalized lastFired* fields when one of its runs
   *  is created. `tx` is the same transaction as the run insert so a
   *  rollback on either side also undoes the schedule update. */
  private async touchSchedule(
    tx: Prisma.TransactionClient,
    scheduleId: string,
    runId: string,
    initialStatus: string,
  ): Promise<void> {
    await tx.schedule.update({
      where: { id: scheduleId },
      data: {
        lastFiredAt: new Date(),
        lastFiredRunId: runId,
        lastFiredStatus: initialStatus,
        totalFired: { increment: 1 },
      },
    });
  }

  private async linkFlowNode(tx: Prisma.TransactionClient, runId: string, nodeId?: string): Promise<void> {
    if (!nodeId) return;
    const linked = await tx.flowNodeRun.updateMany({
      where: { id: nodeId, OR: [{ runId: null }, { runId }] }, data: { runId },
    });
    if (linked.count !== 1) throw new BadRequestException('flow node is missing or already belongs to another run');
  }

  private async dedupedResult(
    bookId: string,
    dedupeKey: string,
    includeTerminal = false,
    flowNodeRunId?: string,
  ): Promise<EnqueueResult> {
    const readWinner = async (tx: Prisma.TransactionClient) => {
      const winner = await tx.run.findFirst({
        where: {
          bookId,
          dedupeKey,
          ...(includeTerminal ? {} : { status: { in: ['pending', 'queued', 'starting', 'running'] } }),
        },
      });
      if (winner) {
        if (flowNodeRunId) {
          if (winner.flowNodeRunId && winner.flowNodeRunId !== flowNodeRunId) throw new BadRequestException('run already belongs to another flow node');
          await this.linkFlowNode(tx, winner.id, flowNodeRunId);
          await tx.run.update({ where: { id: winner.id }, data: { flowNodeRunId } });
        }
        return { run: winner, queued: winner.status === "queued", position: 0, deduped: true };
      }
      throw new Error(
        `unique violation on (${bookId}, ${dedupeKey}) but no matching winner found`,
      );
    };
    return flowNodeRunId ? this.prisma.$transaction(readWinner) : readWinner(this.prisma);
  }

  /**
   * Build the dedupeKey for this enqueue if the caller didn't supply one.
   *
   *   - manual: `manual:<bookId>:<sha1(params)[:8]>:<windowStartMs>` —
   *     a double-click within MANUAL_DEDUPE_WINDOW_MS collapses. Anything
   *     past the window is a deliberate second trigger.
   *   - schedule: `schedule:<scheduleId>:<fireTimeMs>` — passed by
   *     SchedulerService. Scoped per SCHEDULE, not per book: two schedules on
   *     the same book firing at the same instant must stay two runs, and a
   *     `<bookId>:<fireTimeMs>` key would silently collapse them into one.
   *     ("cron" is not a RunTrigger value at all — see RunTrigger above.)
   *   - api: auto-derived fingerprint ending in `Date.now()`, so only calls
   *     landing in the SAME MILLISECOND with identical params coalesce. It is
   *     a race guard against a duplicated request, not a retry window.
   *   - retry: no dedupeKey — every retry should produce a new run.
   */
  private deriveDedupeKey(input: EnqueueInput): string | null {
    if (input.dedupeKey !== undefined) return input.dedupeKey;
    if (input.parentRunId) return null; // retries are always new runs
    if (input.trigger === "manual") {
      const paramsHash = createHash("sha1")
        .update(JSON.stringify(input.params ?? {}))
        .digest("hex")
        .slice(0, 8);
      const window = Math.floor(Date.now() / MANUAL_DEDUPE_WINDOW_MS);
      return `manual:${input.bookId}:${paramsHash}:${window}`;
    }
    // schedule / api / flow: the caller SHOULD pass dedupeKey explicitly, and
    // the two that matter do — SchedulerService sends
    // `schedule:<scheduleId>:<fireTimeMs>`, the flow runner sends
    // `flow:<flowRunId>:<nodeId>:0`. This fallback therefore only ever covers
    // an `api` caller that passed none. `Date.now()` makes it unique per
    // millisecond, so it collapses two calls landing in the same tick and
    // nothing wider.
    const paramsHash = createHash("sha1")
      .update(`${input.trigger}:${JSON.stringify(input.params ?? {})}`)
      .digest("hex")
      .slice(0, 8);
    return `${input.trigger}:${input.bookId}:${paramsHash}:${Date.now()}`;
  }

  private isUniqueViolation(e: unknown): boolean {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
    // P2002 = unique constraint failed (the only one we treat as "deduped").
    return e.code === "P2002";
  }
}

function freezeDeliveries(deliveries: ResolvedDelivery[], params: ParamMap): ResolvedDelivery[] {
  const replace = (value: string): string => value.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_, name: string) => {
    const replacement = params[name];
    return replacement === undefined || replacement === null ? `{{${name}}}` : String(replacement);
  });
  return deliveries.map((delivery) => {
    switch (delivery.kind) {
      case "file": return { ...delivery, artifact: replace(delivery.artifact) };
      case "message": return { ...delivery, template: replace(delivery.template) };
      case "webhook": return { ...delivery, url: replace(delivery.url) };
      default: return delivery;
    }
  });
}
