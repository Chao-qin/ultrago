import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { DispatcherService } from "./dispatcher.service.js";

test('live step replacement preserves result identities and only queues archival', async () => {
  const ids: unknown[] = [];
  let enqueued = 0;
  const tx = { stepRun: { deleteMany: async () => {}, create: async ({ data }: { data: { id?: string } }) => { ids.push(data.id); } } };
  const prisma = { $transaction: async (work: (client: typeof tx) => Promise<void>) => work(tx) };
  const results = { enqueue: () => { enqueued++; }, preview: () => 'preview' };
  const service = new DispatcherService(prisma as never, undefined as never, undefined as never, undefined as never, results as never);
  const internal = service as unknown as { replaceStepRows(run: string, book: string, history: unknown[], backfill: boolean): Promise<void> };
  const history = [{ resultId: '11111111-1111-4111-8111-111111111111', stepIndex: 0, status: 'success' }];
  await internal.replaceStepRows('run', 'book', history, false);
  await internal.replaceStepRows('run', 'book', history, false);
  assert.deepEqual(ids, [history[0].resultId, history[0].resultId]);
  assert.equal(enqueued, 2);
});

/**
 * Who `promoteQueued()` is allowed to wake up.
 *
 * The dispatcher's tick promotes the oldest `queued` run of any idle book to
 * `pending`, and the query that picks the candidates carries two soft-delete
 * predicates — `deletedAt: null` on the run and `book: { deletedAt: null }` on
 * its book. Neither was pinned by anything: deleting them left the console
 * suite at 181 passing while a deleted run, or a run whose book was deleted,
 * would be promoted to `pending` — and `startPending()` (which does filter)
 * then leaves it stuck there forever, occupying its book's single-flight slot
 * against work nobody asked for.
 *
 * `dispatcher-cap.test.ts` next door covers the concurrency arithmetic, which
 * is a pure function; this one needs the query, so it goes through a double.
 */

/** Match a Run row against the `where` shapes `promoteQueued` builds: scalars,
 *  `deletedAt: null`, `{ in: [...] }`, and the one-level relation filter
 *  `book: { deletedAt: null }`.
 *
 *  Unknown filters THROW. A double that shrugs at a filter it does not know is
 *  how a query silently stops filtering with every assertion still green —
 *  which is the exact defect this file exists to catch. */
function matchesRun(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  if (Object.keys(where).length === 0) {
    throw new Error("test double: findMany with no filter — the where clause was dropped");
  }
  return Object.entries(where).every(([key, cond]) => {
    if (cond === null) return row[key] === null || row[key] === undefined;
    if (cond !== null && typeof cond === "object") {
      const c = cond as Record<string, unknown>;
      if (Array.isArray(c.in)) return c.in.includes(row[key]);
      // A relation filter — recurse into the joined row.
      const related = row[key];
      if (related === null || typeof related !== "object") {
        throw new Error(`test double: relation filter on ${key}, but the row has no ${key}`);
      }
      return matchesRun(related as Record<string, unknown>, c);
    }
    return row[key] === cond;
  });
}

function serviceOver(seed: Array<Record<string, unknown>>) {
  const rows = seed.map((r) => ({ ...r }));
  const promoted: string[] = [];

  const runClient = {
    // `take` is honoured rather than ignored, for the same reason `matchesRun`
    // THROWS on an unknown filter: a double that shrugs at a clause is how the
    // query silently changes meaning with every assertion still green. Adding
    // `take: 1` to `promoteQueued` passed all eight tests in this file before
    // this line existed. Rows come back in seed order; the fairness test below
    // seeds them in `queuedAt` order, which is what the real `orderBy` produces.
    findMany: async ({ where, take }: { where?: Record<string, unknown>; take?: number }) => {
      const hits = rows.filter((r) => matchesRun(r, where));
      return typeof take === "number" ? hits.slice(0, take) : hits;
    },
    findFirst: async ({ where }: { where?: Record<string, unknown> }) =>
      rows.find((r) => matchesRun(r, where)) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw Object.assign(new Error(`test double: update() on missing row ${where.id}`), { code: "P2025" });
      promoted.push(where.id);
      Object.assign(row, data);
      return row;
    },
  };
  const prisma = {
    run: runClient,
    $transaction: async <T>(fn: (tx: { run: typeof runClient }) => Promise<T>): Promise<T> => fn({ run: runClient }),
  };
  const svc = new DispatcherService(prisma as never, undefined as never, undefined as never, undefined as never, undefined as never);
  // `promoteQueued` is private and reached from the tick loop; calling it
  // directly keeps the timers, the backend client and the reconcile pass out
  // of a test that is only about which rows the query returns.
  const promoteQueued = () => (svc as unknown as { promoteQueued(): Promise<void> })["promoteQueued"]();
  return { promoteQueued, rows, promoted };
}

const LIVE_BOOK = { id: "bk", name: "nightly", deletedAt: null };
const queuedRun = (over: Record<string, unknown> = {}) => ({
  id: "r1", status: "queued", deletedAt: null, bookId: "bk", book: LIVE_BOOK,
  queuedAt: new Date("2026-08-01"), ...over,
});

test("a live queued run is promoted to pending", async () => {
  // The positive control. A predicate that promotes nothing would satisfy
  // every other assertion in this file.
  const { promoteQueued, promoted, rows } = serviceOver([queuedRun()]);
  await promoteQueued();
  assert.deepEqual(promoted, ["r1"]);
  assert.equal(rows[0].status, "pending");
});

test("a soft-deleted queued run is never promoted", async () => {
  const { promoteQueued, promoted, rows } = serviceOver([queuedRun({ id: "gone", deletedAt: new Date("2026-08-02") })]);
  await promoteQueued();
  assert.deepEqual(promoted, [], "promoting a deleted run only sets up work that must never be started");
  assert.equal(rows[0].status, "queued");
});

test("a queued run whose BOOK was deleted is never promoted", async () => {
  // The half that a `deletedAt: null` on the run alone does not cover:
  // deleting a book soft-deletes its runs, but a run queued against a book
  // that is deleted afterwards is still live on its own row.
  const { promoteQueued, promoted } = serviceOver([
    queuedRun({ id: "orphan", book: { id: "bk", name: "nightly", deletedAt: new Date("2026-08-02") } }),
  ]);
  await promoteQueued();
  assert.deepEqual(promoted, []);
});

test("the deleted ones are skipped while the live one still goes through", async () => {
  // Together, so a fix that simply stopped promoting anything cannot pass.
  const { promoteQueued, promoted } = serviceOver([
    queuedRun({ id: "gone", bookId: "b1", book: { id: "b1", name: "a", deletedAt: null }, deletedAt: new Date() }),
    queuedRun({ id: "orphan", bookId: "b2", book: { id: "b2", name: "b", deletedAt: new Date() } }),
    queuedRun({ id: "ok", bookId: "b3", book: { id: "b3", name: "c", deletedAt: null } }),
  ]);
  await promoteQueued();
  assert.deepEqual(promoted, ["ok"]);
});

test("a soft-deleted run that is still RUNNING keeps holding its book's slot", async () => {
  // The opposite mistake, and the reason the single-flight probe inside the
  // transaction is deliberately NOT filtered on `deletedAt`: a deleted run in
  // flight is still driving a browser. Filtering it out here would promote a
  // second run into the same window.
  const { promoteQueued, promoted } = serviceOver([
    queuedRun({ id: "waiting" }),
    { id: "busy", status: "running", deletedAt: new Date("2026-08-02"), bookId: "bk", book: LIVE_BOOK, queuedAt: new Date("2026-07-01") },
  ]);
  await promoteQueued();
  assert.deepEqual(promoted, [], "the book is still occupied, deleted or not");
});

test("an idle book's queued run is promoted past an older one behind a busy book", async () => {
  // Why `promoteQueued` reads EVERY queued row instead of taking the first few.
  // The query is one global queue ordered by `queuedAt`, but the decision is per
  // book: `b1` is occupied, so its queued run cannot be promoted on this tick,
  // and any `take` short enough to stop there starves `b2` for as long as `b1`
  // stays busy. That is a run that never starts, not a run that starts later —
  // which is why the unbounded `findMany` is the correct shape and not an
  // oversight waiting for a limit.
  const { promoteQueued, promoted } = serviceOver([
    { id: "busy", status: "running", deletedAt: null, bookId: "b1", book: { id: "b1", name: "a", deletedAt: null }, queuedAt: new Date("2026-07-01") },
    queuedRun({ id: "blocked", bookId: "b1", book: { id: "b1", name: "a", deletedAt: null }, queuedAt: new Date("2026-08-01") }),
    queuedRun({ id: "idle", bookId: "b2", book: { id: "b2", name: "b", deletedAt: null }, queuedAt: new Date("2026-08-02") }),
  ]);
  await promoteQueued();
  assert.deepEqual(promoted, ["idle"], "a `take: 1` would return only `blocked` and promote nothing");
});

/* ------------------------------------------------------------------ *
 * kick() — "wake the loop sooner than the 200ms interval would".
 *
 * It did the opposite until 2026-08-29. `kick()` only stamped `kickedAt`,
 * nothing started a tick, and `tick()` opened with
 * `if (Date.now() - this.kickedAt < 100) return`. So the debounce sat on the
 * TICK: calling `kick()` SUPPRESSED the next scheduled tick for 100ms, and a
 * manual trigger — whose only reason for calling this is to not "sit in pending
 * for up to the 200ms polling tick" (runs.service.ts) — reached the dispatcher
 * later than if nobody had kicked at all. Three usages of `kickedAt` in the
 * whole file and nothing testing any of them, so the doc comment went
 * uncontradicted.
 * ------------------------------------------------------------------ */

/** Enough of the four injected collaborators to construct the service.
 *  `run.findMany` exists for the one test that runs the real tick body. */
function kickServiceOver() {
  const queries: string[] = [];
  const prisma = {
    run: {
      findMany: async () => {
        queries.push("run.findMany");
        return [];
      },
    },
  };
  const svc = new DispatcherService(prisma as never, undefined as never, undefined as never, undefined as never, undefined as never);
  return { svc, queries };
}

/** Replaces the collaborator `kick()` is supposed to invoke. `tick` is private,
 *  which TypeScript enforces at compile time only — and "does kick start a
 *  tick" is exactly the boundary under test, so this is the seam to observe. */
function countTicks(svc: DispatcherService) {
  const counter = { ticks: 0 };
  (svc as unknown as { tick: () => Promise<void> }).tick = async () => {
    counter.ticks += 1;
  };
  return counter;
}

test("kick() starts a tick instead of suppressing one", () => {
  const { svc } = kickServiceOver();
  const counter = countTicks(svc);
  svc.kick();
  assert.equal(counter.ticks, 1, "the whole purpose of the method");
});

test("a burst of kicks is debounced to one wake", () => {
  // The "bounded by 100ms minimum gap to avoid stampeding" half of the
  // contract. It has to bound the KICK — bounding the tick is what produced
  // the inverted behaviour.
  const { svc } = kickServiceOver();
  const counter = countTicks(svc);
  svc.kick();
  svc.kick();
  svc.kick();
  assert.equal(counter.ticks, 1, "three triggers in the same instant are one wake");
});

test("a kick after the debounce window wakes the loop again", async () => {
  // The counterpart: "debounced" must not be satisfiable by a kick that only
  // ever works once per process.
  const { svc } = kickServiceOver();
  const counter = countTicks(svc);
  svc.kick();
  await sleep(110);
  svc.kick();
  assert.equal(counter.ticks, 2);
});

test("a kick does not stop the next real tick from doing work", async () => {
  // The regression itself, asserted against the real `tick` body rather than a
  // replacement: under the old code this ran zero queries, because `tick()`
  // returned early for 100ms after any kick.
  //
  // `startPending` issues the first query and is the only step these stubs
  // satisfy; the later ones reach further into Prisma and throw. That is
  // deliberate rather than papered over — completing the whole tick would mean
  // stubbing four subsystems this test makes no claim about, and the claim it
  // does make is carried entirely by the assertion below: the tick RAN.
  const { svc, queries } = kickServiceOver();
  svc.kick();
  await sleep(0);
  await (svc as unknown as { tick: () => Promise<void> }).tick().catch(() => {});
  assert.ok(queries.includes("run.findMany"), `the tick must reach startPending; saw ${JSON.stringify(queries)}`);
});

test("reconcileStaleState re-watches EVERY running run, not a page of them", async () => {
  // The half of the no-`take` argument that nothing pinned. `promoteQueued`'s
  // fairness is covered above; this is the other one: on boot the dispatcher
  // rebuilds `watched` from the database, and a run it fails to re-watch is
  // never driven to a terminal status — it stays `running` forever, and because
  // the per-book single-flight check still sees it, it blocks every future run
  // of its book. A `take` here loses runs silently, which is why the query has
  // none. Mutation-verified: `take: 1` on that findMany leaves the rest of the
  // suite at 301 green, and turns this red.
  //
  // 40 rows, well past any plausible limit someone would reach for.
  const running = Array.from({ length: 40 }, (_, i) => ({
    id: `r${i}`, status: "running", planId: `plan_${i}`, deletedAt: null,
  }));
  const prisma = {
    run: {
      // HONOURS `take`. A double that ignores it absorbs the very defect this
      // test exists to catch: `take: 1` on the production query would change
      // nothing here and the test would pass while runs were being dropped.
      findMany: async ({ where, take }: { where?: Record<string, unknown>; take?: number }) => {
        const hits = running.filter((r) => r.status === (where?.status ?? r.status));
        return typeof take === "number" ? hits.slice(0, take) : hits;
      },
      updateMany: async () => ({ count: 0 }),
    },
    deliveryRun: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    stepRun: { updateMany: async () => ({ count: 0 }) },
  };
  const svc = new DispatcherService(prisma as never, undefined as never, undefined as never, undefined as never, undefined as never);
  await (svc as unknown as { reconcileStaleState(): Promise<void> }).reconcileStaleState();

  const watched = (svc as unknown as { watched: Set<string> }).watched;
  assert.equal(watched.size, 40, `every running run must be re-watched; got ${watched.size}`);
  for (const r of running) {
    assert.ok(watched.has(r.planId), `${r.planId} was dropped — it would stay running forever`);
  }
});

test('failure location uses the failed action instead of stale completed-step counts', async () => {
  const { failedStepOf } = await import('./dispatcher.service.js');
  assert.equal(failedStepOf({ status: 'failed', ranSteps: 0, totalSteps: 35, stepHistory: [{ stepIndex: 27, status: 'failed' }] }), 27);
  assert.equal(failedStepOf({ status: 'escalated', ranSteps: 20, totalSteps: 35 }), 20);
  assert.equal(failedStepOf({ status: 'success', ranSteps: 35, totalSteps: 35 }), null);
  assert.equal(failedStepOf({ status: 'failed', ranSteps: -1, totalSteps: 35 }), null);
});
