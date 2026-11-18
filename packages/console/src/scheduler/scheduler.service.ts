import { Injectable, Logger, OnModuleInit, Inject } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { hostname } from "node:os";
import parser from "cron-parser";
import { PrismaService } from "../prisma/prisma.service.js";
import { EnqueueService } from "../runs/enqueue.service.js";
import { DispatcherService } from "../runs/dispatcher.service.js";
import { ScriptsService } from "../scripts/scripts.service.js";
import { FlowsService } from "../flows/flows.service.js";
import { parseConsoleDeliveries, parseConsoleParams, desktopRuntimeActive } from "@bcp/shared";
import type { Delivery, ParamMap } from "@bcp/shared";

/** How long a scheduler-lease lives before another instance can grab it (ms).
 *  Tick is every 60s; 70s gives one tick of grace before the lock
 *  expires, so a slow tick doesn't cause a lock storm. */
const SCHEDULER_LEASE_TTL = 70_000;

/**
 * Tick once a minute. Uses a **DB-level distributed lock** so that in a
 * multi-instance deployment only one instance actually evaluates cron
 * expressions and enqueues runs. The other instances silently skip.
 *
 * As of the Schedule refactor (2026-08), the iteration source changed
 * from `Book.cronExpr` to the new `Schedule` table — schedules are
 * independent of books, support multiple per book, and carry their own
 * timezone / mode / params config.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);
  /** Last tick timestamp; we evaluate cron windows between lastTick and now. */
  private lastTick = Date.now();
  private ticking = false;
  /** Stable instance identifier for the scheduler lease. */
  private readonly instanceId: string;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EnqueueService) private readonly enqueue: EnqueueService,
    @Inject(DispatcherService) private readonly dispatcher: DispatcherService,
    @Inject(ScriptsService) private readonly scripts: ScriptsService,
    @Inject(FlowsService) private readonly flows: FlowsService,
  ) {
    this.instanceId = process.env.INSTANCE_ID || `${hostname()}-${process.pid}`;
  }

  onModuleInit(): void {
    this.lastTick = Date.now();
    this.logger.log(`scheduler ready (1-minute tick, instance=${this.instanceId})`);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (!desktopRuntimeActive()) return;
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickOnce();
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(): Promise<void> {
    // Step 1: try to acquire the distributed scheduler lock.
    const held = await this.acquireSchedulerLock();
    if (!held) {
      this.logger.debug("scheduler lock held by another instance — skipping tick");
      return;
    }

    // Step 2: we hold the lock — evaluate each enabled schedule.
    const now = Date.now();
    const windowStart = this.lastTick;
    const schedules = await this.prisma.schedule.findMany({
      // Three target kinds share this table (and its cron/timezone/enabled/
      // fired-stats columns) and fire through three different execution doors:
      //   book   → EnqueueService (browser book run)
      //   flow   → FlowsService.trigger (flow orchestration run)
      //   script → ScriptsService.runForSchedule (inline sandboxed script)
      //
      // `deletedAt: null` on BOTH the schedule and its target. A deleted target
      // is not merely paused, and a schedule that is still `enabled: true`
      // would otherwise keep firing runs for a resource the user removed.
      where: {
        enabled: true,
        deletedAt: null,
        OR: [
          { targetType: "book", book: { deletedAt: null } },
          { targetType: "flow", flow: { deletedAt: null } },
          { targetType: "script", script: { deletedAt: null } },
        ],
      },
      include: {
        book: { select: { id: true, name: true, enabled: true } },
        flow: { select: { id: true, name: true, enabled: true } },
        script: { select: { id: true, name: true, language: true, source: true, inputSchema: true, outputSchema: true } },
      },
    });
    this.lastTick = now;
    for (const s of schedules) {
      // Skip a target that is disabled or whose resource failed to resolve —
      // belt and braces against a row whose targetType disagrees with its
      // columns; skipping is right either way, since this loop cannot fire it.
      if (s.targetType === "book" && (!s.bookId || !s.book?.enabled)) continue;
      if (s.targetType === "flow" && (!s.flowId || !s.flow?.enabled)) continue;
      if (s.targetType === "script" && !s.scriptId) continue;

      let interval: parser.CronExpression;
      try {
        interval = parser.parseExpression(s.cronExpr, {
          currentDate: Math.max(windowStart, s.createdAt.getTime()),
          endDate: new Date(now),
          tz: s.timezone,
        });
      } catch (e) {
        this.logger.warn(
          `schedule ${s.id} (${s.name}) has invalid cron "${s.cronExpr}": ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        continue;
      }

      while (true) {
        let firedAt: Date;
        try {
          firedAt = interval.next().toDate();
        } catch {
          break;
        }
        if (firedAt.getTime() > now) break;
        try {
          const params = parseConsoleParams(s.paramsJson) as ParamMap;
          if (s.targetType === "book") {
            const r = await this.enqueue.enqueue({
              bookId: s.bookId!,
              params,
              mode: s.mode === "assisted" ? "assisted" : "auto",
              trigger: "schedule",
              scheduleId: s.id,
              timezone: s.timezone,
              deliveryOverrides: s.deliveryOverridesJson
                ? parseConsoleDeliveries(s.deliveryOverridesJson, "deliveryOverridesJson") as Delivery[]
                : undefined,
              // One key per (schedule, fireTime) — same-window re-evaluation is
              // a no-op, but distinct fires all enqueue.
              dedupeKey: `schedule:${s.id}:${firedAt.getTime()}`,
            });
            this.logger.log(`schedule ${s.name} (book) fired @ ${firedAt.toISOString()} → run ${r.run.id}`);
            this.dispatcher.kick();
          } else if (s.targetType === "flow") {
            const run = await this.flows.trigger(s.flowId!, params, 'schedule', s.mode, undefined, {
              scheduleId: s.id,
              dedupeKey: `schedule:${s.id}:${firedAt.getTime()}`,
            });
            await this.dispatcher.kick();
            this.logger.log(`schedule ${s.name} (flow) fired @ ${firedAt.toISOString()} → flowRun ${run.id}`);
          } else if (s.targetType === "script" && s.script && s.scriptId) {
            const timeoutMs = s.timeoutMs ?? 60_000;
            const { runId, status } = await this.scripts.runForSchedule(s.script, params, firedAt, timeoutMs, {
              scheduleId: s.id,
              dedupeKey: `schedule:${s.id}:${firedAt.getTime()}`,
            });
            this.logger.log(`schedule ${s.name} (script) fired @ ${firedAt.toISOString()} → run ${runId} (${status})`);
          }
        } catch (e) {
          this.logger.error(
            `schedule ${s.name} fire failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
  }

  /** Next N fire times for a schedule — surfaced via /api/schedules so
   *  the Schedules page can show a "next run" countdown. */
  async nextFires(cronExpr: string, timezone: string, n = 3): Promise<Date[]> {
    const interval = parser.parseExpression(cronExpr, {
      currentDate: new Date(),
      tz: timezone,
    });
    const out: Date[] = [];
    for (let i = 0; i < n; i++) out.push(interval.next().toDate());
    return out;
  }

  /**
   * Acquire the distributed scheduler lock. Returns `true` if THIS instance
   * holds the lock after the call (i.e. should proceed with the tick).
   *
   * Same shape as the old cron lock — just renamed since the lock is no
   * longer about cron specifically.
   */
  private async acquireSchedulerLock(): Promise<boolean> {
    try {
      const { sql, params } = buildLeaseAcquire(this.instanceId, Date.now(), SCHEDULER_LEASE_TTL);
      const changed = await this.prisma.$executeRawUnsafe(sql, ...params);
      if (changed > 0) {
        this.logger.debug(`scheduler lock acquired (instance=${this.instanceId})`);
        return true;
      }
      return false;
    } catch (e) {
      this.logger.warn(`scheduler lock acquire failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
}

/** Take (or renew) the singleton lease in ONE statement.
 *
 *  Every column is listed, `updatedAt` included. It is `NOT NULL` with no
 *  database default, and the previous `INSERT OR IGNORE` omitted it — and
 *  `OR IGNORE` turns a NOT NULL violation into a silently skipped row rather
 *  than an error. The insert therefore reported 0 rows affected, `result > 0`
 *  was never true, the holder lookup found the table still empty, and the
 *  tick returned false. The lock could not be acquired by anyone, by any
 *  instance, ever — the scheduler has fired nothing since the migration that
 *  added the column (20260828072126_payload_convergence). `CronLease` being
 *  empty in a database whose console has been running for days is the tell.
 *
 *  One statement rather than BEGIN IMMEDIATE / DELETE / INSERT / SELECT /
 *  COMMIT: each `$executeRaw*` issued outside `$transaction` is a
 *  self-contained operation that checks out its OWN pooled connection, so the
 *  `BEGIN IMMEDIATE` and the `COMMIT` meant to close it could land on
 *  different connections — stranding a connection in the pool with an open
 *  write transaction that nothing ever ends. That is what produced
 *  `database is locked` on subsequent ticks and `Operations timed out` 500s on
 *  unrelated writers (POST /api/schemas among them), recoverable only by
 *  restarting the process. enqueue.service.ts already carries this lesson in
 *  its doc comment; this was the last place that had not learned it. A bare
 *  statement runs inside SQLite's own implicit transaction, so there is
 *  nothing left open to leak.
 *
 *  The `WHERE` covers both reclaim paths the old sequence spelled out
 *  separately: a lease whose deadline has passed (what the `DELETE` did) and
 *  this instance renewing one it already holds (what the holder check did).
 *  A live lease held by someone else matches neither, updates no row, and
 *  reports 0 — which is the "another instance is ticking" answer.
 *
 *  Timestamps are milliseconds, matching the raw-SQL convention this table has
 *  always used. Nothing reads `CronLease` through the Prisma model API, so raw
 *  writes and raw comparisons only have to agree with each other.
 */
const ACQUIRE_LEASE_SQL = `
INSERT INTO "CronLease" ("id", "holder", "acquiredAt", "expiresAt", "createdAt", "updatedAt")
VALUES ('singleton', ?, ?, ?, ?, ?)
ON CONFLICT("id") DO UPDATE SET
  "holder"     = excluded."holder",
  "acquiredAt" = excluded."acquiredAt",
  "expiresAt"  = excluded."expiresAt",
  "updatedAt"  = excluded."updatedAt"
WHERE "CronLease"."expiresAt" < ? OR "CronLease"."holder" = excluded."holder"
`;

/** The statement and the values that fill it, built together.
 *
 *  Six positional placeholders of which FOUR are the same `now` is a footgun to
 *  bind by hand, and handing the bare SQL to a caller that binds its own values
 *  is worse than a footgun in a test: the test would re-declare the parameter
 *  order, and a swapped `now`/`expiresAt` in the service — which silently
 *  inverts the expiry comparison and so breaks mutual exclusion — would stay
 *  invisible to it. Returning both halves from one place is what makes the test
 *  exercise the same ordering the scheduler uses. */
export function buildLeaseAcquire(
  holder: string,
  now: number,
  ttlMs: number,
): { sql: string; params: Array<string | number> } {
  // Order matches ACQUIRE_LEASE_SQL's `?` left to right: holder, acquiredAt,
  // expiresAt, createdAt, updatedAt, then the `now` the expiry check compares
  // against.
  return { sql: ACQUIRE_LEASE_SQL, params: [holder, now, now + ttlMs, now, now, now] };
}
