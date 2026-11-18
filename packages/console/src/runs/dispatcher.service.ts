/**
 * 软删立场（本文件通篇适用）：读 Run 时不按 deletedAt 过滤。
 *
 * 这里的查询几乎都在恢复或推进一个**已经启动**的状态机，而不是在挑新活干。一个
 * 被软删、但后端仍然在跑的 run 必须被驱动到终态；把它从这些查询里滤掉，它会永远
 * 停在 running，而并发计数与 per-book 单飞检查——两者都正确地仍然看得见它——会
 * 因此挡住这本 book 之后的每一次运行。文件内 `dispatcher start lease expired`
 * 一段把这个取舍展开写过一次。
 *
 * 面向用户的列表 / 详情不在本文件，它们在 runs.service.ts，并且都过滤。
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service.js";
import { BackendClient } from "../backend-client/backend-client.service.js";
import { executeDelivery, normalizeReportPath, type DeliveryContext } from "./delivery-executor.js";
import { normalizeDelivery, parseConsoleDeliveries, runProductSource, desktopAfterActivation, desktopRuntimeActive } from "@bcp/shared";
import { describeOutputs } from "./output-type.js";
import { StepResultsService } from './step-results.service.js';
import type { ResolvedDelivery } from "@bcp/shared";
import { claimDelivery } from "./delivery-claims.js";
import { DeliveryIngestService } from "./delivery-ingest.service.js";
import { OutputLandingService } from "./output-landing.service.js";

/** Max delivery attempts before a DeliveryRun is left as "error" (no more
 * redelivery). Bounded so a permanently-broken webhook doesn't retry forever. */
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_START_ATTEMPTS = 5;
const START_LEASE_MS = 60_000;
/** How many runs may be underway at once, across every trigger source.
 *
 *  Until now the only limit was per-book: two schedules firing different books
 *  in the same minute both started, and both drove the browser. Chrome stops
 *  rendering a window that is minimised or fully occluded, so concurrent book
 *  runs are how a deterministic run becomes an intermittent one — the default
 *  is therefore 1. Raise it only for a setup where the runs genuinely cannot
 *  contend. */
const MAX_CONCURRENT_RUNS = Math.max(1, Number(process.env.BCP_MAX_CONCURRENT_RUNS ?? 1) || 1);
const DELIVERY_LEASE_MS = 60_000;
const PAUSED_RUN_STATUSES = new Set(["needsConfirm", "needsJudge", "noAction"]);
const TERMINAL_RUN_STATUSES = new Set(["success", "failed", "escalated", "cancelled"]);

export function failedStepOf(live: {
  status?: unknown;
  ranSteps?: unknown;
  totalSteps?: unknown;
  stepHistory?: unknown;
}): number | null {
  if (live.status !== 'failed' && live.status !== 'escalated') return null;
  const valid = (index: unknown): index is number => typeof index === 'number' &&
    Number.isInteger(index) && index >= 0 &&
    (typeof live.totalSteps !== 'number' || index < live.totalSteps);
  if (Array.isArray(live.stepHistory)) {
    for (let i = live.stepHistory.length - 1; i >= 0; i--) {
      const entry = live.stepHistory[i];
      if (entry?.status === 'failed' && valid(entry.stepIndex)) return entry.stepIndex;
    }
  }
  // 本地动作不产生浏览器历史行，终态游标仍能定位它们的失败步骤。
  return valid(live.ranSteps) ? live.ranSteps : null;
}


/**
 * Which of the candidate rows may actually start this tick.
 *
 * The cap governs how many NEW runs begin. A row already in `starting` is a
 * claim being retried after its lease expired, so it is always let through —
 * counting it against the budget would let one stuck run block its own
 * recovery, which is the opposite of what a limit is for.
 *
 * Pure and exported so the limit is testable without a database: this is the
 * only thing standing between two schedules firing in the same minute and two
 * browser sessions fighting over the same window.
 */
export function selectStartable<T extends { status: string }>(candidates: T[], runningCount: number, cap: number): T[] {
  let budget = cap - runningCount;
  return candidates.filter((run) => {
    if (run.status === "starting") return true;
    if (budget <= 0) return false;
    budget--;
    return true;
  });
}

/** One entry of the backend's /internal/run/:planId stepHistory. */
interface InternalStepRow {
  stepIndex: number;
  goal: string;
  method: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
  valuePreview?: string;
  resultId?: string;
  resultChars?: number;
  upstreamTruncated?: boolean;
  error?: string;
}

/** Background loop that picks up `pending` runs and starts them on the
 *  backend; after a run finishes, promotes the next `queued` run for the
 *  same book to `pending`. This is the consumer side of the per-book
 *  serialization set up by EnqueueService. */
@Injectable()
export class DispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DispatcherService.name);
  private timer: NodeJS.Timeout | null = null;
  private kickedAt = 0;
  /** Tracks which planIds we're currently watching so we don't double-poll. */
  private watched = new Set<string>();
  private tickInFlight = false;
  private reconcilePromise: Promise<void> | null = null;
  /** planId -> last-synced live-progress signature (see syncLiveProgress).
   * Only a changed signature rewrites StepRun rows, so a 200ms poll doesn't
   * churn the DB. Cleared at terminal exit. */
  private stepSignatures = new Map<string, string>();
  /** Extra work to run each tick, registered by other modules.
   *
   *  The flow runner needs this loop but also needs EnqueueService, which lives
   *  here — injecting it the other way round would make the two modules
   *  circular. An extension point keeps the dependency one-directional: flows
   *  know about runs, runs know nothing about flows. */
  private tickSteps: Array<{ name: string; run: () => Promise<void> }> = [];

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BackendClient) private readonly backend: BackendClient,
    @Inject(DeliveryIngestService) private readonly deliveryIngest: DeliveryIngestService,
    @Inject(OutputLandingService) private readonly outputLanding: OutputLandingService,
    @Inject(StepResultsService) private readonly stepResults: StepResultsService,
  ) {}

  private cancelActivation?: () => void;

  onModuleInit(): void {
    this.cancelActivation = desktopAfterActivation(() => this.activate());
  }

  private activate(): void {
    this.reconcilePromise = this.reconcileStaleState().catch((e) => {
      this.logger.error(`delivery state reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    this.timer = setInterval(() => this.tick().catch((e) => this.logger.error(e)), 200);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.cancelActivation?.();
    if (this.timer) clearInterval(this.timer);
  }

  /** Add a step to every tick. Registered during module init; failures are
   *  contained so an extension cannot stop runs from being dispatched. */
  registerTickStep(name: string, run: () => Promise<void>): void {
    this.tickSteps.push({ name, run });
  }

  /** Wake the loop sooner (e.g. right after a manual trigger), debounced to one
   *  wake per 100ms so a burst of triggers cannot stampede the dispatcher.
   *
   *  The debounce is on the KICK. It used to be on the TICK, which inverted the
   *  whole point of this method: `kick()` only stamped `kickedAt`, nothing
   *  started a tick, and `tick()` opened with `if (now - kickedAt < 100)
   *  return`. So calling it did not wake the loop — it SUPPRESSED the next
   *  200ms tick, and a manual trigger reached the dispatcher later than if
   *  nobody had kicked at all. Its one caller (`runs.service.ts`) asks for it
   *  precisely so a manual run "doesn't sit in pending for up to the 200ms
   *  polling tick".
   *
   *  Firing the tick here is safe against the interval that is also calling it:
   *  `tick()` returns immediately when `tickInFlight` is set, which is the same
   *  guard that already protects two interval ticks from overlapping. */
  kick(): void {
    const now = Date.now();
    if (now - this.kickedAt < 100) return;
    this.kickedAt = now;
    void this.tick().catch((e) => this.logger.error(e));
  }

  private async tick(): Promise<void> {
    if (!desktopRuntimeActive()) return;
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      await this.reconcilePromise;
      await this.startPending();
      await this.pollWatched();
      await this.promoteQueued();
      await this.retryDeliveries();
      for (const step of this.tickSteps) {
        try {
          await step.run();
        } catch (e) {
          this.logger.error(`tick step "${step.name}" failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  /** Pick up runs in `pending` and start them on the backend. */
  private async startPending(): Promise<void> {
    const candidates = await this.prisma.run.findMany({
      where: {
        // Picking up work is where soft delete has to bite: a deleted run must
        // never be handed to the backend, and neither must a live run whose
        // book was deleted out from under it.
        deletedAt: null,
        book: { deletedAt: null },
        status: { in: ["pending", "starting"] },
        OR: [{ startNextAttemptAt: null }, { startNextAttemptAt: { lte: new Date() } }],
      },
      orderBy: { queuedAt: "asc" },
      take: 5,
      include: { book: true },
    });
    // NOT filtered, on purpose. This number is the concurrency budget, and what
    // it has to measure is how many browsers are actually busy. A soft-deleted
    // run that is still `running` is still driving Chrome; excluding it would
    // let the dispatcher start a second run into the same window, which is the
    // exact failure MAX_CONCURRENT_RUNS exists to prevent.
    const running = await this.prisma.run.count({ where: { status: "running" } });
    const pending = selectStartable(candidates, running, MAX_CONCURRENT_RUNS);
    for (const run of pending) {
      // Two-phase start: first reserve the run in the DB, THEN call backend.
      // This avoids the "backend succeeded but DB update failed" inconsistency:
      // if the backend call fails, the run stays in "starting" and the next
      // tick will try again (re-reserve).
      const token = randomUUID();
      const now = new Date();
      const claimed = await this.prisma.run.updateMany({
        where: {
          id: run.id,
          OR: [
            { status: "pending", OR: [{ startNextAttemptAt: null }, { startNextAttemptAt: { lte: now } }] },
            { status: "starting", OR: [{ startClaimUntil: null }, { startClaimUntil: { lt: now } }], startNextAttemptAt: null },
            { status: "starting", OR: [{ startClaimUntil: null }, { startClaimUntil: { lt: now } }], startNextAttemptAt: { lte: now } },
          ],
        },
        data: { status: "starting", startClaimToken: token, startClaimUntil: new Date(Date.now() + START_LEASE_MS), startAttempts: { increment: 1 } },
      });
      if (claimed.count !== 1) continue;

      let reserved: { id: string; paramsJson: string; deliveryOverridesJson: string | null; deliverySnapshotJson: string | null; mode: string; trigger: string; bookName: string; playbookJson: string | null } | null = null;
      try {
        const fresh = await this.prisma.run.findUnique({ where: { id: run.id }, include: { book: { select: { name: true, playbookJson: true } } } });
        if (fresh?.status === "starting" && fresh.startClaimToken === token && fresh.book) {
          reserved = { id: fresh.id, paramsJson: fresh.paramsJson, deliveryOverridesJson: fresh.deliveryOverridesJson, deliverySnapshotJson: fresh.deliverySnapshotJson, mode: fresh.mode, trigger: fresh.trigger, bookName: fresh.book.name, playbookJson: fresh.book.playbookJson };
        }
      } catch (e) {
        this.logger.error(
          `reserve run ${run.id} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }

      if (!reserved) continue; // status changed between read and update

      // Phase 2: call the backend (outside the transaction so a slow
      // backend call doesn't hold the DB write lock).
      try {
        const params = JSON.parse(reserved.paramsJson) as Record<string, unknown>;
        let playbookJson = reserved.playbookJson ?? undefined;
        const deliveryJson = reserved.deliverySnapshotJson ?? reserved.deliveryOverridesJson;
        if (playbookJson && deliveryJson) {
          const playbook = JSON.parse(playbookJson) as Record<string, unknown>;
          playbook.deliveries = JSON.parse(deliveryJson);
          playbookJson = JSON.stringify(playbook);
        }
        const started = await this.backend.startRun({
          name: reserved.bookName,
          params,
          mode: reserved.mode as "assisted" | "auto",
          trigger: reserved.trigger === "schedule" ? "schedule" : "manual",
          runId: reserved.id,
          planId: `plan_${reserved.id}`,
          playbookJson,
        });

        // Phase 3: record the success in the DB.
        const startedUpdate = await this.prisma.run.updateMany({
          where: { id: reserved.id, startClaimToken: token },
          data: {
            status: started.status === "pending" ? "pending" : "running",
            planId: started.planId,
            startedAt: new Date(),
            startClaimToken: null,
            startClaimUntil: null,
            startNextAttemptAt: null,
          },
        });
        if (startedUpdate.count !== 1) continue;
        this.watched.add(started.planId);
        this.logger.log(`run ${run.id} started on backend (planId=${started.planId})`);
      } catch (e) {
        // Backend call failed (or DB update failed). Revert to "pending"
        // so the next tick can retry, or mark as "failed" if the error
        // is clearly terminal.
        const isTerminal =
          e instanceof Error &&
          (e.message.includes("not found") ||
            e.message.includes("already exists") ||
            e.message.includes("invalid"));
        const attempt = (await this.prisma.run.findUnique({ where: { id: reserved.id }, select: { startAttempts: true } }))?.startAttempts ?? MAX_START_ATTEMPTS;
        const terminalFailure = isTerminal || attempt >= MAX_START_ATTEMPTS;
        await this.prisma.run.updateMany({
          where: { id: reserved.id, startClaimToken: token },
          data: {
            status: terminalFailure ? "failed" : "pending",
            finishedAt: terminalFailure ? new Date() : null,
            errorMessage: terminalFailure ? (e instanceof Error ? e.message : String(e)) : null,
            startClaimToken: null,
            startClaimUntil: null,
            startNextAttemptAt: terminalFailure ? null : backoff(attempt),
          },
        });
        if (terminalFailure) {
          await this.deliveryIngest.enqueueTerminal(reserved.id, "failed", e instanceof Error ? e.message : String(e));
        }
        if (isTerminal) {
          this.logger.error(
            `failed to start run ${run.id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        } else {
          this.logger.warn(
            `start run ${run.id} transient failure, will retry: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
  }

  /** Poll the backend for the runs we're currently watching. */
  private async pollWatched(): Promise<void> {
    if (this.watched.size === 0) return;
    const planIds = [...this.watched];
    for (const planId of planIds) {
      let live: Record<string, unknown> & {
        status?: string;
        name?: string;
        ranSteps?: number;
        totalSteps?: number;
        error?: string;
        stepHistory?: unknown;
        deliveries?: unknown;
        artifacts?: unknown;
        outputs?: unknown;
      };
      try {
        live = (await this.backend.getRun(planId)) as typeof live;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes("HTTP 404") || message.includes("not found")) {
          const run = await this.prisma.run.findFirst({ where: { planId } });
          if (run) await this.reconcileLostBackend(run.id, message);
          this.watched.delete(planId);
        } else {
          this.logger.warn(`poll ${planId} transient backend failure: ${message}`);
        }
        continue;
      }
      const status = String(live.status);
      if (status === "pending" || status === "running") {
        // LIVE SYNC: the run is still active — mirror its step progress into
        // the DB so the UI updates in real time (previously steps only
        // appeared at the terminal exit). Throttled by a signature: rows are
        // only rewritten when something actually changed.
        await this.syncLiveProgress(planId, live);
        continue;
      }

      if (PAUSED_RUN_STATUSES.has(status)) {
        await this.prisma.run.updateMany({
          where: { planId, status: { in: ["starting", "running", "pending"] }, finishedAt: null },
          data: { status, finishedAt: null },
        });
        // Pauses are resumable observations, not terminal delivery events.
        this.watched.delete(planId);
        continue;
      }
      if (!TERMINAL_RUN_STATUSES.has(status)) {
        this.logger.warn(`backend returned unsupported run status ${status} for ${planId}`);
        continue;
      }

      // Terminal — sync our DB to the backend's final state and stop watching.
      const finishedAt = new Date();
      const run = await this.prisma.run.findFirst({ where: { planId }, include: { book: { select: { outputSchema: true, outputSchemaRef: true } } } });
      // pollWatched only ever watches runs this dispatcher STARTED, which are
      // book runs (script/flow targets have their own runners). A run whose book
      // went away is no longer deliverable — skip it rather than crash.
      if (run && run.book) {
        // **Guard against cancel race**: if the user cancelled the run
        // while the backend was still running, the DB status is already
        // "cancelled". Don't overwrite it with the backend's terminal
        // status — the user's intent wins.
        if (run.status === "cancelled") {
          // Cancellation wins for Run status, but it must not discard the
          // delivery snapshot: on:cancelled and on:any are still eligible.
          await this.deliverRun(run.id, planId, live);
          this.watched.delete(planId);
          this.logger.log(`run ${run.id} was cancelled by user — backend status ignored`);
          if (run.scheduleId) {
            await this.touchScheduleFinish(run.scheduleId, "cancelled");
          }
          continue;
        }

        const wasActive = run.status === "running" || run.status === "starting";
        const startedAt = run.startedAt ?? run.queuedAt;
        const described = live.outputs !== undefined ? describeOutputs(live.outputs, run.book.outputSchema) : null;
        // 节点看到终态后会立即消费结果，检查点必须先于终态可见。
        if (described || run.flowNodeRunId) {
          await this.outputLanding.landRunOutput(run, described ?? describeOutputs(undefined, run.book.outputSchema), run.book.outputSchemaRef);
        }
        await this.prisma.run.update({
          where: { id: run.id },
          data: {
            status,
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            errorMessage: typeof live.error === "string" ? live.error : run.errorMessage,
            failedStep: failedStepOf(live),
            ranSteps: typeof live.ranSteps === "number" ? live.ranSteps : run.ranSteps,
            totalSteps: typeof live.totalSteps === "number" ? live.totalSteps : run.totalSteps,
          },
        });
        // Update the schedule's denormalized stats (lastFiredStatus +
        // totalSuccess). Guarded by wasActive so a re-poll after a crash (run
        // already terminal) can't double-increment.
        if (wasActive && run.scheduleId) {
          await this.touchScheduleFinish(run.scheduleId, status);
        }
        // Hydrate StepRun rows from the backend's stepHistory so the UI has
        // per-step rows to render. FULL REPLACE, not upsert-by-stepIndex: the
        // backend's stepHistory may hold several rows for one step (a retried
        // action), and stepIndex alone isn't unique — deduping on it let later
        // rows overwrite earlier ones (a failed run ended up showing only its
        // last cleanup closeTab). We only write this once per run
        // (watched.delete below), so replace is safe. Terminal = backfill the
        // un-executed steps as skipped (the run is over — they were skipped).
        await this.replaceStepRows(run.id, run.bookId!, Array.isArray(live.stepHistory) ? live.stepHistory : [], true);

        // Execute the run's deliveries (console layer, SQLite-backed). Each is
        // persisted as a DeliveryRun row (pending) before execution, so a crash
        // between "finished" and "delivered" leaves a row the redelivery loop
        // picks up next tick.
        await this.deliverRun(run.id, planId, live);
      }
      this.watched.delete(planId);
      this.stepSignatures.delete(planId);
    }
  }

  /** Live-progress mirror: while a run is active, copy its backend
   * stepHistory (+ totalSteps / error) into the DB so RunDetail shows steps in
   * REAL TIME instead of only after the run terminates. Rewrites are gated on
   * a signature (stepVersion + history length + last entry state) so a 200ms
   * poll never churns the DB. */
  private async syncLiveProgress(
    planId: string,
    live: { stepHistory?: unknown; totalSteps?: number; error?: string; stepVersion?: number },
  ): Promise<void> {
    const run = await this.prisma.run.findFirst({ where: { planId } });
    if (!run || !run.bookId) return; // dispatcher-watched runs are book runs
    const history = Array.isArray(live.stepHistory) ? (live.stepHistory as Array<InternalStepRow>) : [];
    const last = history.at(-1);
    const sig = `${live.stepVersion ?? 0}|${history.length}|${last ? `${last.stepIndex}:${last.status}:${last.startedAt}:${last.finishedAt ?? ""}` : ""}`;
    if (this.stepSignatures.get(planId) === sig) return;
    this.stepSignatures.set(planId, sig);

    const patch: { totalSteps?: number; errorMessage?: string; durationMs?: number } = {};
    if (typeof live.totalSteps === "number") patch.totalSteps = live.totalSteps;
    if (typeof live.error === "string" && live.error) patch.errorMessage = live.error;
    const startedAt = run.startedAt ?? run.queuedAt;
    patch.durationMs = Date.now() - startedAt.getTime();
    await this.prisma.run.update({ where: { id: run.id }, data: patch });

    // LIVE path: NO skipped backfill — steps beyond the current cursor simply
    // haven't run yet; marking them "skipped" while the run is still going
    // would be a lie (the run may still reach them).
    await this.replaceStepRows(run.id, run.bookId, history, false);
  }

  /** FULL-REPLACE StepRun rows for a run from the backend's stepHistory, and
   * (when `backfillSkipped`) add rows for never-executed steps as `skipped` so
   * a TERMINAL run shows the whole book with the skipped phases marked instead
   * of a partial list. NEVER upsert by stepIndex — retried actions legitimately
   * produce several rows per stepIndex, and deduping would drop history. */
  private async replaceStepRows(runId: string, bookId: string, history: unknown[], backfillSkipped: boolean): Promise<void> {
    this.stepResults.enqueue(runId, history as InternalStepRow[]);
    const rows: Array<{
      id?: string;
      runId: string;
      stepIndex: number;
      goal: string;
      actionMethod: string | null;
      status: string;
      startedAt: Date | null;
      finishedAt: Date | null;
      durationMs: number | null;
      valuePreview: string | null;
      errorMessage: string | null;
    }> = (history as InternalStepRow[]).map((s) => ({
      id: s.resultId,
      runId,
      stepIndex: s.stepIndex,
      goal: s.goal ?? "",
      actionMethod: s.method ?? null,
      status: s.status ?? "unknown",
      startedAt: s.startedAt ? new Date(s.startedAt) : null,
      finishedAt: s.finishedAt ? new Date(s.finishedAt) : null,
      durationMs: s.finishedAt && s.startedAt ? s.finishedAt - s.startedAt : null,
      valuePreview: this.stepResults.preview(s),
      errorMessage: s.error ?? null,
    }));
    if (rows.length === 0) return;
    // Backfill skipped steps (terminal only): indexes with no executed row
    // were never reached — the run ended early. Mark them skipped using the
    // book's declared steps so the UI shows the full book.
    if (backfillSkipped) {
      const executed = new Set(rows.map((r) => r.stepIndex));
      try {
        const book = await this.prisma.book.findUnique({ where: { id: bookId }, select: { playbookJson: true } });
        if (book?.playbookJson) {
          const steps = (JSON.parse(book.playbookJson) as { steps: Array<{ goal?: string }> }).steps;
          for (let i = 0; i < steps.length; i++) {
            if (executed.has(i)) continue;
            rows.push({
              runId,
              stepIndex: i,
              goal: steps[i]?.goal ?? "",
              actionMethod: null,
              status: "skipped",
              startedAt: null,
              finishedAt: null,
              durationMs: null,
              valuePreview: null,
              errorMessage: null,
            });
          }
          rows.sort((a, b) => a.stepIndex - b.stepIndex);
        }
      } catch (e) {
        this.logger.warn(`skipped-step backfill failed for run ${runId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // HARD delete, and it must stay one. This is not a user removing
    // something — it is the replace half of a full replace, and it runs on
    // EVERY live-progress sync (syncLiveProgress calls in with
    // backfillSkipped=false each time the step signature moves), not just once
    // per run. Soft-deleting here would leave one hidden copy of the step list
    // per sync; the run detail page filters them out, so the rows would
    // accumulate invisibly until someone queried the table and found a
    // finished run carrying dozens of duplicate histories. Withdrawing a run
    // is expressed on the Run row and cascaded from there.
    await this.prisma.$transaction(async (tx) => {
      await tx.stepRun.deleteMany({ where: { runId } });
      for (const data of rows) await tx.stepRun.create({ data });
    });
  }

  /** Scan for queued runs and promote the oldest one of each idle book to
   *  `pending` (the dispatcher will start it on the next tick).
   *
   *  Runs on EVERY 200ms tick, not only after a run finishes — `tick()` calls it
   *  unconditionally, because "a book went idle" has no event to hang off: a run
   *  can also end by crashing, by being withdrawn, or via the reconcile pass.
   *
   *  NO `take`, deliberately. The rows are one global queue ordered by
   *  `queuedAt`, but the decision is per book, so a limit does not shorten a
   *  page — it hides the queued run of every idle book sorting behind a busy
   *  book's, and those never start at all. Cost is bounded anyway: `queued` is a
   *  transient status a run leaves the moment it is promoted, so the row count
   *  tracks outstanding queue depth rather than history, and `Run_status_idx`
   *  keeps the scan proportional to that depth. (A census figure stood here and
   *  was removed: a number measured once is a claim that decays, and this
   *  argument rests on the STATUS being transient, which does not.) `dispatcher.service.test.ts` pins the fairness half. */
  private async promoteQueued(): Promise<void> {
    // Find any book with no active run but at least one queued. Filtered for
    // the same reason as startPending: promoting a deleted run to `pending`
    // only sets up work that must never be started.
    const queued = await this.prisma.run.findMany({
      where: { status: "queued", deletedAt: null, book: { deletedAt: null } },
      orderBy: { queuedAt: "asc" },
      include: { book: { select: { id: true, name: true } } },
    });
    for (const r of queued) {
      try {
        await this.prisma.$transaction(
          async (tx) => {
            // NOT filtered: this is the per-book single-flight invariant, and
            // like the concurrency count it has to reflect what is really
            // occupying the book. A soft-deleted run still in flight must
            // still hold the slot.
            const active = await tx.run.findFirst({
              where: {
                bookId: r.bookId,
                status: { in: ["pending", "starting", "running"] },
              },
            });
            if (active) return; // someone else still running; leave queued.
            await tx.run.update({ where: { id: r.id }, data: { status: "pending" } });
          },
          { timeout: 5_000 },
        );
      } catch (e) {
        this.logger.warn(`promoteQueued failed for run ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Persist + execute a run's deliveries (from the terminal snapshot). Each is
   * written as a pending DeliveryRun BEFORE execution so a crash leaves a row
   * for the redelivery loop. Idempotent: skips an index already present. */
  private async deliverRun(
    runId: string,
    planId: string,
    live: { deliveries?: unknown; artifacts?: unknown },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.run.findUnique({ where: { id: runId }, select: { deliverySnapshotJson: true } });
      let deliveries: ResolvedDelivery[];
      try {
        if (current?.deliverySnapshotJson) {
          deliveries = JSON.parse(current.deliverySnapshotJson).map(normalizeDelivery);
        } else {
          deliveries = Array.isArray(live.deliveries) ? live.deliveries.map(normalizeDelivery) : [];
        }
      } catch (e) {
        this.logger.error(`run ${runId} has invalid delivery snapshot: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (!current?.deliverySnapshotJson) {
        await tx.run.update({ where: { id: runId }, data: { deliverySnapshotJson: safeJson(deliveries) } });
      }
      for (const [i, d] of deliveries.entries()) {
        const key = { runId, deliveryIndex: i };
        const existing = await tx.deliveryRun.findUnique({ where: { runId_deliveryIndex: key } });
        if (existing) continue;
        await tx.deliveryRun.create({ data: { runId, deliveryIndex: i, kind: d.kind, on: d.on, status: "pending", idempotencyKey: `${planId}:${i}` } });
      }
      // The files this run wrote land as their own rows. They have to exist
      // before the deliveries run: `verifyFile` refuses a file the run does not
      // own, and these rows are the only surviving record of which files those
      // were.
      for (const p of artifactPaths(live.artifacts)) {
        await this.outputLanding.landArtifact(runId, p, tx);
      }
    });
  }

  /** Re-run pending/errored DeliveryRun rows (redelivery loop) — the durability
   * backstop for a crash between "run finished" and "delivered". Bounded by
   * MAX_DELIVERY_ATTEMPTS so a permanently-broken webhook stops retrying. */
  private async retryDeliveries(): Promise<void> {
    const due = await this.prisma.deliveryRun.findMany({
      where: {
        // A delivery has side effects outside this database — it posts
        // webhooks and writes files. Withdrawing the run has to stop that,
        // so both the delivery row and its run are checked.
        deletedAt: null,
        run: { deletedAt: null },
        deadLettered: false,
        attempts: { lt: MAX_DELIVERY_ATTEMPTS },
        OR: [
          { status: { in: ["pending", "error"] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
          { status: "running", OR: [{ claimUntil: null }, { claimUntil: { lt: new Date() } }] },
        ],
      },
      take: 10,
    });
    for (const dr of due) {
      const claimToken = randomUUID();
      if (!await claimDelivery(this.prisma.deliveryRun, dr.id, new Date(), claimToken, DELIVERY_LEASE_MS, MAX_DELIVERY_ATTEMPTS)) continue;
      const ctx = await this.buildContext(dr.runId);
      if (!ctx) {
        await this.finalizeDeliveryClaim(dr.id, claimToken, { status: "error", detail: "run no longer exists" }, dr.attempts);
        continue;
      }
      const d = await this.resolveDelivery(dr.runId, dr.deliveryIndex);
      if (!d) {
        // Graceful, and terminal: rows written before `deliverySnapshotJson`
        // existed have no reconstructable payload and never will. Dead-lettering
        // says so once instead of failing the same way five more times.
        await this.prisma.deliveryRun.updateMany({
          where: { id: dr.id, claimToken },
          data: {
            status: "error",
            detail: "delivery payload is not reconstructable: this run predates deliverySnapshotJson",
            lastError: "no delivery snapshot",
            attempts: dr.attempts + 1,
            deadLettered: true,
            claimToken: null,
            claimUntil: null,
            nextAttemptAt: null,
            finishedAt: new Date(),
          },
        });
        continue;
      }
      await this.prisma.deliveryRun.updateMany({
        where: { id: dr.id, claimToken },
        data: { kind: d.kind, on: d.on },
      });
      const result = await executeDelivery(d, ctx, dr.deliveryIndex);
      await this.finalizeDeliveryClaim(dr.id, claimToken, result, dr.attempts);
    }
  }

  private async finalizeDeliveryClaim(
    id: string,
    claimToken: string,
    result: { status: "ok" | "skipped" | "error"; detail?: string },
    previousAttempts: number,
  ): Promise<void> {
    const attempts = previousAttempts + 1;
    const failed = result.status === "error";
    const deadLettered = failed && attempts >= MAX_DELIVERY_ATTEMPTS;
    await this.prisma.deliveryRun.updateMany({
      where: { id, claimToken },
      data: {
        status: result.status,
        detail: result.detail ?? null,
        attempts,
        lastError: failed ? result.detail ?? "delivery failed" : null,
        deadLettered,
        claimToken: null,
        claimUntil: null,
        nextAttemptAt: failed && !deadLettered ? backoff(attempts) : null,
        finishedAt: !failed || deadLettered ? new Date() : null,
      },
    });
  }

  /**
   * The delivery this row stands for, read back from the run's IMMUTABLE
   * delivery snapshot rather than from a second copy on the row itself.
   *
   * `Book.deliveriesJson` is deliberately not a fallback: filesync rewrites it
   * on every scan, so reading history out of it would let editing a playbook
   * change what a past delivery was. Null means the payload is genuinely
   * unrecoverable, which the caller reports rather than guessing at.
   */
  private async resolveDelivery(runId: string, deliveryIndex: number): Promise<ResolvedDelivery | null> {
    const run = await this.prisma.run.findUnique({ where: { id: runId }, select: { deliverySnapshotJson: true } });
    if (!run?.deliverySnapshotJson) return null;
    try {
      return parseConsoleDeliveries(run.deliverySnapshotJson)[deliveryIndex] ?? null;
    } catch (e) {
      this.logger.error(`run ${runId} has an unreadable delivery snapshot: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** Rebuild a DeliveryContext from the DB (so redelivery works after the
   * backend has GC'd the run). Returns null if the run is gone. */
  private async buildContext(runId: string): Promise<DeliveryContext | null> {
    const run = await this.prisma.run.findUnique({
      where: { id: runId },
      include: { book: { select: { name: true } } },
    });
    if (!run || !run.book) return null; // deliveries are book-scoped
    // The produced value comes back from the run's landed row — the only place
    // it is now kept.
    //
    // An unreadable product degrades to `undefined`, which is what the deleted
    // `outputsJson` column did when it failed to parse; a `file` delivery does
    // not touch outputs at all and must still be able to run. Note the flow
    // runner takes the OPPOSITE line on the same read (it fails the node),
    // because there the value is about to be fed to another endpoint rather
    // than rendered. Logged either way — this is a degradation, not a non-event.
    let outputs: unknown;
    try {
      outputs = await this.outputLanding.readLandedValue(runProductSource(runId));
    } catch (e) {
      this.logger.warn(`run ${runId} product could not be read back: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {
      runId,
      planId: run.planId ?? "",
      bookName: run.book.name,
      status: run.status,
      ranSteps: run.ranSteps ?? 0,
      totalSteps: run.totalSteps ?? 0,
      durationMs: run.durationMs ?? 0,
      error: run.errorMessage ?? undefined,
      outputs,
      paramsJson: run.paramsJson,
      artifacts: (await this.outputLanding.listRunArtifactPaths(runId)).map((path) => ({ path })),
    };
  }

  private async reconcileStaleState(): Promise<void> {
    const now = new Date();
    await this.prisma.deliveryRun.updateMany({
      where: { status: "running", OR: [{ claimUntil: null }, { claimUntil: { lt: now } }] },
      data: { status: "error", claimToken: null, claimUntil: null, nextAttemptAt: now, lastError: "dispatcher lease expired; reclaimed after restart" },
    });
    await this.prisma.run.updateMany({
      where: { status: "starting", OR: [{ startClaimUntil: null }, { startClaimUntil: { lt: now } }] },
      data: { status: "pending", startClaimToken: null, startClaimUntil: null, startNextAttemptAt: now, errorMessage: "dispatcher start lease expired; reclaimed after restart" },
    });
    // NOT filtered. Re-establishing the watch on runs that were ALREADY
    // started is resuming a state machine, not picking up new work. A
    // soft-deleted run that is genuinely still running on the backend has to
    // be driven to a terminal status; dropping it here would strand it as
    // `running` forever, and — because the concurrency count and the per-book
    // single-flight check above both (correctly) still see it — that stranded
    // row would block every future run of its book.
    const active = await this.prisma.run.findMany({ where: { status: "running", planId: { not: null } }, select: { id: true, planId: true } });
    for (const run of active) if (run.planId) this.watched.add(run.planId);
  }

  private async reconcileLostBackend(runId: string, reason: string): Promise<void> {
    const run = await this.prisma.run.findUnique({ where: { id: runId } });
    if (!run || run.status === "cancelled" || run.status === "success" || run.status === "failed" || run.status === "escalated") return;
    if (run.startAttempts >= MAX_START_ATTEMPTS) {
      await this.prisma.run.update({ where: { id: runId }, data: { status: "failed", finishedAt: new Date(), errorMessage: `backend run unavailable after ${MAX_START_ATTEMPTS} attempts: ${reason}` } });
      await this.deliveryIngest.enqueueTerminal(runId, "failed", reason);
      return;
    }
    await this.prisma.run.update({ where: { id: runId }, data: { status: "pending", planId: null, startNextAttemptAt: backoff(run.startAttempts), errorMessage: reason } });
  }

  /** Denormalized schedule stats: set lastFiredStatus to the run's terminal
   * status, and bump totalSuccess when it succeeded. Called once per run at its
   * terminal exit (guarded by `wasActive` at the call site so a re-poll after a
   * crash can't double-increment totalSuccess). */
  private async touchScheduleFinish(scheduleId: string, status: string): Promise<void> {
    await this.prisma.schedule.update({
      where: { id: scheduleId },
      data: {
        lastFiredStatus: status,
        ...(status === "success" ? { totalSuccess: { increment: 1 } } : {}),
      },
    });
  }
}

function backoff(attempt: number): Date {
  const delayMs = Math.min(60_000, 250 * (2 ** Math.max(0, attempt - 1)));
  return new Date(Date.now() + delayMs);
}

/** JSON-stringify that can't throw (used for the delivery snapshot). */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "null";
  } catch {
    return "null";
  }
}

/** Report-relative paths out of a backend snapshot's `artifacts`. Anything that
 *  escapes reports/ is dropped, same rule `normalizeReportPath` enforces for
 *  the delivery itself. `size`/`mimeType` from the snapshot are ignored on
 *  purpose — `extractArtifacts` hard-codes `size: 0`, and the landing stats the
 *  file instead. */
function artifactPaths(raw: unknown): string[] {
  const out: string[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== "object") continue;
    const p = (entry as { path?: unknown }).path;
    if (typeof p !== "string") continue;
    try { out.push(normalizeReportPath(p)); } catch { /* escapes reports/ */ }
  }
  return out;
}
