import { test } from "node:test";
import assert from "node:assert/strict";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { SchedulesService } from "./schedules.service.js";

/**
 * What the Schedules list PROJECTS, not what it computes.
 *
 * The bug this file exists for: the page's Book column has to answer "is this
 * book still there, or is the link into it a 404?", and the `include` handed it
 * `{ id, name, enabled, deliveriesJson }` — no `deletedAt`. A field the response
 * does not carry is a question the page cannot ask, so it asked a different one
 * (the SCHEDULE's own `deletedAt`) and got the answer wrong in the direction the
 * cascade does not cover: a schedule deleted on its own leaves its book alive.
 *
 * Asserting the query rather than the render is deliberate — the console suite
 * has no renderer, and the projection is where the field can go missing.
 */

/** A Schedule table standing in for the database. `findMany` records the args it
 *  was handed; the seed comes back unfiltered, because what is under test is the
 *  query the service SENDS. */

/** Counts how many interactive transactions the service opened, and hands the
 *  callback the same delegates. Recording the count is what makes "this mutator
 *  runs inside one transaction" assertable — without it, deleting the
 *  `$transaction` wrapper and leaving the statements loose changes nothing any
 *  assertion can see, which is the shape of a check-then-act race slipping back
 *  in unnoticed. */
const tx = { opened: 0 };
function withTx<T extends object>(client: T): T & { $transaction: <R>(fn: (c: T) => Promise<R>) => Promise<R> } {
  return Object.assign(client, {
    $transaction: async <R>(fn: (c: T) => Promise<R>): Promise<R> => {
      tx.opened += 1;
      return fn(client);
    },
  });
}

function serviceOver(seed: Array<Record<string, unknown>> = []) {
  const args: Array<Record<string, unknown>> = [];
  const prisma = {
    schedule: {
      findMany: async (a: Record<string, unknown>) => {
        args.push(a);
        return seed.map((r) => ({ ...r }));
      },
    },
  };
  // enqueue / dispatcher / scripts / flows are never reached by list(); a stub
  // pretending to be any of them would just be another thing to keep true.
  return { svc: new SchedulesService(prisma as never, undefined as never, undefined as never, undefined as never, undefined as never), args };
}

const bookRow = (over: Record<string, unknown> = {}) => ({
  id: "b1", name: "nightly-report", enabled: true, deliveriesJson: "[]", deletedAt: null, ...over,
});

const scheduleRow = (over: Record<string, unknown> = {}) => ({
  id: "s1", name: "nightly", description: null, bookId: "b1", book: bookRow(),
  cronExpr: "0 3 * * *", timezone: "Asia/Shanghai", mode: "auto", paramsJson: "{}",
  deliveryOverridesJson: null, enabled: true, createdAt: new Date(), updatedAt: new Date(),
  deletedAt: null, lastFiredAt: null, lastFiredStatus: null, lastFiredRunId: null,
  totalFired: 0, totalSuccess: 0, ...over,
});

test("list() projects the book's deletedAt", async () => {
  const { svc, args } = serviceOver();
  await svc.list();
  const select = (args[0] as { include: { book: { select: Record<string, boolean> } } }).include.book.select;
  assert.equal(select.deletedAt, true, `the Book column reads this field; select was ${JSON.stringify(select)}`);
});

test("list() still projects the fields the form and the label need", async () => {
  // The projection is hand-written, so widening it is exactly where something
  // else falls out. `deliveriesJson` feeds the edit dialog's delivery defaults,
  // `enabled` the 已禁用 tag, `id` the link target.
  const { svc, args } = serviceOver();
  await svc.list();
  const select = (args[0] as { include: { book: { select: Record<string, boolean> } } }).include.book.select;
  assert.deepEqual(select, { id: true, name: true, enabled: true, deliveriesJson: true, deletedAt: true });
});

test("list() hands the book's own deletedAt through to the row", async () => {
  // The regression the Book column had backwards: this schedule IS deleted while
  // its book is NOT. The row must carry `book.deletedAt === null` so the page can
  // tell the two apart instead of inferring one from the other.
  const { svc } = serviceOver([scheduleRow({ deletedAt: new Date("2026-08-01"), book: bookRow() })]);
  const [row] = await svc.list({ includeDeleted: true });
  assert.notEqual(row.deletedAt, null, "the schedule is deleted");
  assert.equal(row.book!.deletedAt, null, "its book is not");
});

test("list() reports a cascaded deletion on both", async () => {
  // The other direction, which the old predicate happened to get right:
  // books.service.delete() soft-deletes the book and its schedules together.
  const deletedAt = new Date("2026-08-01");
  const { svc } = serviceOver([scheduleRow({ deletedAt, book: bookRow({ deletedAt }) })]);
  const [row] = await svc.list({ includeDeleted: true });
  assert.deepEqual(row.book!.deletedAt, deletedAt);
});

test('legacy schedules without a target kind are still reported as books', async () => {
  const { svc } = serviceOver([scheduleRow()]);
  assert.equal((await svc.list())[0].targetType, 'book');
});

test('flow and script schedule stats reflect their own run records, including cancellation', async () => {
  const seed = [
    scheduleRow({ id: 'flow-schedule', targetType: 'flow', book: null, flow: { id: 'f1', name: 'flow', enabled: true, deletedAt: null } }),
    scheduleRow({ id: 'script-schedule', targetType: 'script', book: null, script: { id: 'script1', name: 'script', language: 'ts', deletedAt: null } }),
  ];
  const groupQueries: unknown[] = [];
  const latestQueries: unknown[] = [];
  const delegate = (scheduleId: string, latestId: string, latestStatus: string, date: string) => ({
    groupBy: async (args: { where: { scheduleId: { in: string[] } }; by: string[] }) => {
      assert.deepEqual(args.where.scheduleId.in, [scheduleId]);
      assert.deepEqual(args.by, ['scheduleId', 'status']);
      groupQueries.push(args);
      return [
        { scheduleId, status: 'success', _count: { _all: 2 }, _max: { queuedAt: new Date(date) } },
        { scheduleId, status: 'cancelled', _count: { _all: 1 }, _max: { queuedAt: new Date(date) } },
      ];
    },
    findMany: async (args: { where: { OR: Array<{ scheduleId: string; queuedAt: Date }> } }) => {
      assert.deepEqual(args.where.OR, [{ scheduleId, queuedAt: new Date(date) }]);
      latestQueries.push(args);
      return [{ scheduleId, id: latestId, status: latestStatus, queuedAt: new Date(date) }];
    },
  });
  const prisma = {
    schedule: {
      findMany: async () => seed,
      findFirst: async ({ where }: { where: { id: string } }) => seed.find(row => row.id === where.id),
    },
    flowRun: delegate('flow-schedule', 'flow-last', 'cancelled', '2026-09-10T00:00:00Z'),
    run: delegate('script-schedule', 'script-last', 'success', '2026-09-11T00:00:00Z'),
  };
  const svc = new SchedulesService(prisma as never, undefined as never, undefined as never, undefined as never, undefined as never);
  const listed = await svc.list();
  assert.deepEqual(listed.map(row => row.id), ['script-schedule', 'flow-schedule']);
  assert.deepEqual(listed.map(row => [row.totalFired, row.totalSuccess, row.lastFiredRunId, row.lastFiredStatus]), [
    [3, 2, 'script-last', 'success'], [3, 2, 'flow-last', 'cancelled'],
  ]);
  const detail = await svc.findById('flow-schedule');
  assert.equal(detail.totalFired, 3);
  assert.equal(detail.totalSuccess, 2);
  assert.equal(detail.lastFiredStatus, 'cancelled');
  assert.equal(groupQueries.length, 3);
  assert.equal(latestQueries.length, 3);
});

test('a script schedule with no attributed runs does not invent counts from legacy counters', async () => {
  const seed = scheduleRow({ targetType: 'script', totalFired: 99, totalSuccess: 99 });
  const prisma = {
    schedule: { findMany: async () => [seed] },
    run: { groupBy: async () => [], findMany: async () => [] },
  };
  const svc = new SchedulesService(prisma as never, undefined as never, undefined as never, undefined as never, undefined as never);
  const [row] = await svc.list();
  assert.equal(row.totalFired, 0);
  assert.equal(row.totalSuccess, 0);
  assert.equal(row.lastFiredRunId, null);
});

test('listing many flow schedules uses a bounded number of history queries', async () => {
  const ids = ['first', 'second', 'third'];
  let historyQueries = 0;
  const latestDate = new Date('2026-09-11T00:00:00Z');
  const prisma = {
    schedule: { findMany: async () => ids.map(id => scheduleRow({ id, targetType: 'flow' })) },
    flowRun: {
      groupBy: async ({ where }: { where: { scheduleId: { in: string[] } } }) => {
        historyQueries++;
        return where.scheduleId.in.map(scheduleId => ({ scheduleId, status: 'success', _count: { _all: 2 }, _max: { queuedAt: latestDate } }));
      },
      findMany: async () => {
        historyQueries++;
        return ids.map(scheduleId => ({ scheduleId, id: `${scheduleId}-run`, status: 'success', queuedAt: latestDate }));
      },
    },
  };
  const svc = new SchedulesService(prisma as never, undefined as never, undefined as never, undefined as never, undefined as never);
  const listed = await svc.list();
  assert.equal(historyQueries, 2);
  assert.deepEqual(listed.map(row => [row.totalFired, row.totalSuccess]), [[2, 2], [2, 2], [2, 2]]);
});

/* ------------------------------------------------------------------ *
 * The soft-delete guards.
 *
 * `list()` above is a PROJECTION test and says nothing about who is allowed
 * through. Every other entry point re-reads the row with `{ id, deletedAt:
 * null }` first, and until now not one of those five predicates was pinned:
 * rewriting all five to a bare `{ id }` left the suite at 181 passing, while
 * `update` / `toggle` / `remove` / `runNow` / `findById` all started answering
 * 200 for schedules the user had deleted. `runNow` is the sharp one — it
 * enqueues a real run off a deleted schedule.
 *
 * Modelled on books.service.test.ts, which has the same guard on one method
 * covered by seven tests.
 * ------------------------------------------------------------------ */

/**
 * Match one row against the `where` shapes this service builds.
 *
 * Unknown filters THROW instead of quietly matching, and an empty `where` is
 * treated as "the predicate was dropped" rather than "matches everything" —
 * `[].every()` is true, so a dropped filter would otherwise surface as a clean
 * hit on the first row with every assertion still green. That is the exact
 * failure these tests exist to catch, so the double must not absorb it.
 */
function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  const entries = Object.entries(where);
  if (entries.length === 0) {
    throw new Error("test double: findFirst with no filter — the where clause was dropped");
  }
  return entries.every(([key, cond]) => {
    // A live row may carry `deletedAt: null` or omit the column entirely.
    if (cond === null) return row[key] === null || row[key] === undefined;
    if (typeof cond === "object") {
      throw new Error(`test double: unsupported filter ${key}=${JSON.stringify(cond)}`);
    }
    return row[key] === cond;
  });
}

/** A Schedule table plus the two collaborators `runNow()` reaches. Writes and
 *  enqueues are recorded so "it refused" can be asserted as *nothing
 *  happened*, not merely as *it threw*. */
function guardServiceOver(seed: Array<Record<string, unknown>>) {
  const rows = seed.map((r) => ({ ...r }));
  const updated: Array<{ id: string; data: Record<string, unknown> }> = [];
  const enqueued: Array<Record<string, unknown>> = [];
  let kicks = 0;

  const prisma = {
    schedule: {
      findFirst: async ({ where }: { where?: Record<string, unknown> }) =>
        rows.find((r) => matchesWhere(r, where)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === where.id);
        // Real Prisma throws P2025 for an id that is not there. A double that
        // returns undefined lets "the guard failed and the write hit nothing"
        // pass for a harmless no-op.
        if (!row) {
          throw Object.assign(
            new Error(`test double: update() on missing row ${where.id} (real Prisma throws P2025)`),
            { code: "P2025" },
          );
        }
        // `update()` builds its `data` with every patchable column present and
        // the untouched ones set to `undefined`; real Prisma reads that as
        // "leave alone". Assigning them verbatim would blank the row instead,
        // so a later runNow() would trip over a paramsJson this write never
        // meant to change.
        const applied = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
        updated.push({ id: where.id, data: applied });
        Object.assign(row, applied);
        return row;
      },
    },
  };
  const enqueue = { enqueue: async (arg: Record<string, unknown>) => { enqueued.push(arg); return { runId: "r1" }; } };
  const dispatcher = { kick: () => { kicks += 1; } };

  return {
    svc: new SchedulesService(withTx(prisma) as never, enqueue as never, dispatcher as never, undefined as never, undefined as never),
    rows, updated, enqueued, kicked: () => kicks, tx,
  };
}

const LIVE = scheduleRow({ id: "live", name: "live-one" });
const DELETED = scheduleRow({ id: "gone", name: "gone-one", enabled: true, deletedAt: new Date("2026-08-01") });

test('update validates a timezone-only patch before writing', async () => {
  const { svc, updated } = guardServiceOver([LIVE]);
  await assert.rejects(() => svc.update('live', { timezone: 'Not/AZone' }), BadRequestException);
  assert.deepEqual(updated, []);
});

test('update rejects seconds-based cron unsupported by the minute scheduler', async () => {
  const { svc, updated } = guardServiceOver([LIVE]);
  await assert.rejects(() => svc.update('live', { cronExpr: '*/5 * * * * *' }), BadRequestException);
  assert.deepEqual(updated, []);
});

test('update rejects invalid script timeouts before writing', async () => {
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, '60000']) {
    const { svc, updated } = guardServiceOver([scheduleRow({ id: 'live', targetType: 'script' })]);
    await assert.rejects(() => svc.update('live', { timeoutMs: timeoutMs as number }), BadRequestException);
    assert.deepEqual(updated, []);
  }
});

test('nextFires does not advertise execution for paused or deleted schedules', async () => {
  for (const row of [scheduleRow({ enabled: false }), DELETED]) {
    const prisma = { schedule: { findUnique: async () => row } };
    const svc = new SchedulesService(prisma as never, undefined as never, undefined as never, undefined as never, undefined as never);
    assert.deepEqual(await svc.nextFires('s1'), []);
  }
});

test('nextFires isolates invalid persisted cron instead of failing the whole list', async () => {
  const prisma = { schedule: { findUnique: async () => scheduleRow({ cronExpr: 'invalid' }) } };
  const svc = new SchedulesService(prisma as never, undefined as never, undefined as never, undefined as never, undefined as never);
  assert.deepEqual(await svc.nextFires('s1'), []);
});

test("findById() refuses a soft-deleted schedule", async () => {
  const { svc } = guardServiceOver([LIVE, DELETED]);
  await assert.rejects(() => svc.findById("gone"), NotFoundException);
  assert.equal((await svc.findById("live")).id, "live");
});

test("update() refuses a soft-deleted schedule", async () => {
  const { svc, updated } = guardServiceOver([LIVE, DELETED]);
  await assert.rejects(() => svc.update("gone", { description: "edited after deletion" }), NotFoundException);
  // The refusal has to happen BEFORE the write, not just in what it returns.
  assert.deepEqual(updated, [], "a rejected update must not have written anything");
});

test("update() cannot re-enable a soft-deleted schedule", async () => {
  // The sharpest edge of the hole: `enabled: true` on a deleted row is a
  // resurrection `remove()` never sanctioned, and the cron loop would then be
  // firing a schedule that is invisible in every list.
  const { svc, rows } = guardServiceOver([DELETED]);
  await assert.rejects(() => svc.update("gone", { enabled: true }), NotFoundException);
  assert.notEqual(rows[0].deletedAt, null, "the deleted schedule must stay deleted");
});

test("toggle() refuses a soft-deleted schedule", async () => {
  const { svc, updated } = guardServiceOver([LIVE, DELETED]);
  await assert.rejects(() => svc.toggle("gone"), NotFoundException);
  assert.deepEqual(updated, [], "a rejected toggle must not have flipped anything");
});

test("remove() refuses a schedule that is already deleted", async () => {
  // Not a harmless no-op: without the guard the second call re-stamps
  // `deletedAt` with today's date, quietly moving when the deletion happened.
  const deletedAt = new Date("2026-08-01");
  const { svc, updated, rows } = guardServiceOver([scheduleRow({ id: "gone", deletedAt })]);
  await assert.rejects(() => svc.remove("gone"), NotFoundException);
  assert.deepEqual(updated, [], "a second remove() must not write again");
  assert.deepEqual(rows[0].deletedAt, deletedAt, "the original deletion time must survive");
});

test("runNow() refuses a soft-deleted schedule, and enqueues nothing", async () => {
  // The one that leaves a trace outside this table: an unguarded runNow()
  // creates a real Run against a schedule the user deleted.
  const { svc, enqueued, kicked } = guardServiceOver([LIVE, DELETED]);
  await assert.rejects(() => svc.runNow("gone"), NotFoundException);
  assert.deepEqual(enqueued, [], "a deleted schedule must not reach the enqueue service");
  assert.equal(kicked(), 0, "nor wake the dispatcher");
});

test("the guards still let a live schedule through", async () => {
  // The other half of every guard test: a predicate that refuses everything
  // would satisfy all six assertions above and break the feature.
  const { svc, updated, enqueued, kicked } = guardServiceOver([scheduleRow({ id: "live" })]);

  await svc.update("live", { description: "hello" });
  await svc.toggle("live");
  await svc.runNow("live");
  await svc.remove("live");

  assert.deepEqual(updated.map((u) => u.id), ["live", "live", "live"]);
  assert.equal(updated[1].data.enabled, false, "toggle() flipped the live row");
  assert.notEqual(updated[2].data.deletedAt, undefined, "remove() stamped the live row");
  assert.equal(enqueued.length, 1, "runNow() enqueued for the live schedule");
  assert.equal(kicked(), 1, "and woke the dispatcher");
});

test("runNow() still refuses a live schedule whose book is disabled", async () => {
  // A different gate on the same path; pinned here so widening the soft-delete
  // predicate cannot quietly take this one with it.
  const { svc, enqueued } = guardServiceOver([scheduleRow({ id: "live", book: bookRow({ enabled: false }) })]);
  await assert.rejects(() => svc.runNow("live"), BadRequestException);
  assert.deepEqual(enqueued, []);
});

test("toggle() flips enabled inside one transaction", async () => {
  // The counter is what makes the wrapper's presence assertable. Without it,
  // unwrapping the guard and the write back into two loose statements — the
  // window a concurrent remove() slips through to leave an enabled row that is
  // also soft-deleted — changes nothing any other assertion here can see.
  const { svc, tx, rows } = guardServiceOver([LIVE]);
  const before = tx.opened;
  const out = await svc.toggle("live");
  assert.equal(tx.opened, before + 1, "the read and the write must share one transaction");
  assert.equal(out.enabled, !LIVE.enabled);
  assert.equal(rows.find((r) => r.id === "live")?.enabled, !LIVE.enabled);
});

test("toggle() still refuses a soft-deleted schedule", async () => {
  // The counterpart: "opens a transaction" must not be satisfiable by a version
  // that opened one and then dropped the guard inside it.
  const { svc } = guardServiceOver([LIVE, DELETED]);
  await assert.rejects(() => svc.toggle("gone"), NotFoundException);
});

/** A Book table for create(), with the ONE behaviour that makes the missing-
 *  `bookId` test mean anything: an `undefined` VALUE in `where` is SKIPPED, not
 *  compared — because that is what Prisma does with it. Copied from
 *  schema-records.service.test.ts's `match`, and it is the whole point of this
 *  fake: a version that compared `undefined` literally would make the unguarded
 *  service return `null`, throw NotFound, and let the test pass with the guard
 *  deleted. The seed carries TWO live books so "picked an unasked-for one" is
 *  observable at all. */
function createServiceOver(books: Array<Record<string, unknown>>) {
  const created: Array<Record<string, unknown>> = [];
  const match = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => v === undefined || row[k] === v);
  const prisma = {
    book: { findFirst: async ({ where }: any) => books.find((b) => match(b, where)) ?? null },
    schedule: {
      create: async ({ data }: any) => {
        created.push(data);
        return { id: "new", ...data, book: null };
      },
    },
  };
  return { svc: new SchedulesService(prisma as never, undefined as never, undefined as never, undefined as never, undefined as never), created };
}

const createBook = (over: Record<string, unknown> = {}) => ({
  id: "b1", name: "nightly-report", paramSchema: "[]", deliveriesJson: "[]", deletedAt: null, ...over,
});

test("create() refuses a body with no bookId instead of adopting an unrelated book", async () => {
  // Without the guard the findFirst below drops `id` from the filter, hands back
  // `first-book`, and a Schedule row is written carrying that book's NAME and
  // params normalized against ITS paramSchema — with `bookId: null`, so `list()`
  // filters it out and the scheduler never fires it. Silent phantom, not a 500.
  const { svc, created } = createServiceOver([createBook({ id: "first", name: "first-book" }), createBook()]);
  await assert.rejects(
    () => svc.create({ cronExpr: "0 3 * * *" } as never),
    (e: any) => {
      assert.equal(e.getStatus?.(), 400, `expected a 400, got ${e.getStatus?.()} / ${e.message}`);
      assert.match(e.message, /bookId is required/);
      return true;
    },
  );
  assert.deepEqual(created, [], "and nothing was written");
});

test("create() still writes a schedule when bookId names a live book", async () => {
  // The other half: the guard must reject the absent id WITHOUT rejecting the
  // path the form actually uses, or "refuses everything" would satisfy the test
  // above on its own.
  const { svc, created } = createServiceOver([createBook()]);
  await svc.create({ bookId: "b1", cronExpr: "0 3 * * *" } as never);
  assert.equal(created.length, 1);
  assert.equal(created[0].bookId, "b1");
  assert.equal(created[0].targetKey, "book:b1");
  assert.equal(created[0].name, "nightly-report", "name defaults to the book that was actually asked for");
});
