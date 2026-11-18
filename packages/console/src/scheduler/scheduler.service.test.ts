import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SchedulerService, buildLeaseAcquire } from "./scheduler.service.js";

/**
 * The lease is exercised against a REAL SQLite database built from the real
 * DDL, not a Prisma test double. That is the whole point: the bug this file
 * exists to prevent was not something the service's own code could show —
 * `INSERT OR IGNORE` omitted `updatedAt`, SQLite turned the NOT NULL violation
 * into a silently skipped row, and the tick read "0 rows affected" as "someone
 * else holds the lock". Every assertion here passes against a double that just
 * records calls; only the engine's own constraint handling fails it.
 *
 * DDL copied verbatim from the live resource/db/console.db, which agrees with
 * prisma/migrations/20260828072126_payload_convergence. `updatedAt` being NOT
 * NULL with no default is the load-bearing detail — do not give it a default to
 * make a test pass.
 */
const DDL = `CREATE TABLE "CronLease" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
  "holder" TEXT NOT NULL,
  "acquiredAt" DATETIME NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
)`;

const T0 = 1_000_000;
const TTL = 70_000;

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(DDL);
  return db;
}

/** Goes through `buildLeaseAcquire`, so this shares ONE parameter order with
 *  the scheduler instead of re-declaring its own. Binding them here by hand is
 *  what would let a swapped argument in the service pass unnoticed. */
function acquire(db: DatabaseSync, holder: string, now: number): boolean {
  const { sql, params } = buildLeaseAcquire(holder, now, TTL);
  return Number(db.prepare(sql).run(...(params as Array<string | number>)).changes) > 0;
}

const lease = (db: DatabaseSync) =>
  db.prepare(`SELECT holder, acquiredAt, expiresAt, createdAt FROM "CronLease" WHERE id = 'singleton'`).get() as
    | { holder: string; acquiredAt: number; expiresAt: number; createdAt: number }
    | undefined;

test("acquires the lease on an empty table", () => {
  const db = freshDb();
  // The regression: the old `INSERT OR IGNORE` (no updatedAt) reported 0 here,
  // so the lock was unacquirable and no schedule ever fired.
  assert.equal(acquire(db, "A", T0), true);
  assert.equal(lease(db)?.holder, "A");
});

test("refuses a second instance while the lease is live", () => {
  const db = freshDb();
  acquire(db, "A", T0);
  assert.equal(acquire(db, "B", T0 + 1_000), false);
  assert.equal(lease(db)?.holder, "A", "a refused acquire must not steal the lease");
});

test("refuses a challenger at the exact expiry instant", () => {
  const db = freshDb();
  acquire(db, "A", T0);
  // Pins `<` rather than `<=`. The lease runs to T0+TTL inclusive, matching the
  // `DELETE ... WHERE expiresAt < now` this replaced; with `<=` the lease would
  // be stealable one tick early and two instances could both believe they hold
  // it. Only asserting T0+TTL+1 leaves that mutant alive.
  assert.equal(acquire(db, "B", T0 + TTL), false);
  assert.equal(lease(db)?.holder, "A");
});

test("lets the holder renew its own live lease", () => {
  const db = freshDb();
  acquire(db, "A", T0);
  assert.equal(acquire(db, "A", T0 + 2_000), true);
  assert.equal(lease(db)?.expiresAt, T0 + 2_000 + TTL, "renewal must push the deadline out");
});

test("renewal does not rewrite createdAt", () => {
  const db = freshDb();
  acquire(db, "A", T0);
  acquire(db, "A", T0 + 2_000);
  // `createdAt` is deliberately absent from the DO UPDATE SET list: it records
  // when the lock row first appeared, and an upsert that refreshed it would
  // make the column mean the same thing as updatedAt.
  assert.equal(lease(db)?.createdAt, T0);
  assert.equal(lease(db)?.acquiredAt, T0 + 2_000, "the renewal itself must still land");
});

test("lets another instance reclaim an expired lease", () => {
  const db = freshDb();
  acquire(db, "A", T0);
  assert.equal(acquire(db, "B", T0 + TTL + 1), true);
  assert.equal(lease(db)?.holder, "B");
});

test("keeps exactly one row however many instances contend", () => {
  const db = freshDb();
  ["A", "B", "A", "C"].forEach((who, i) => acquire(db, who, T0 + i));
  const { c } = db.prepare(`SELECT COUNT(*) c FROM "CronLease"`).get() as { c: number };
  assert.equal(Number(c), 1, "CronLease is a singleton lock, not a log");
});

test("the scheduler acquires the lock with exactly one statement, opening no transaction", async () => {
  const db = freshDb();
  const issued: string[] = [];
  // Records what the METHOD sends and runs it for real. Asserting on the SQL
  // constant instead would be a tautology — `db.prepare` rejects multi-statement
  // SQL, so the constant could never hold a BEGIN and still work. The defect
  // being guarded lived in the method: it issued `BEGIN IMMEDIATE` and `COMMIT`
  // as separate self-contained calls, which on a pooled connection can take
  // different connections and strand one mid-transaction.
  const prisma = {
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) =>
      Number(
        db.prepare((issued.push(sql), sql)).run(...(params as Array<string | number>)).changes,
      ),
  };
  const previousId = process.env.INSTANCE_ID;
  process.env.INSTANCE_ID = "instance-under-test";
  try {
    const scheduler = new SchedulerService(prisma as never, {} as never, {} as never, {} as never, {} as never);
    const held = await (scheduler as unknown as {
      acquireSchedulerLock(): Promise<boolean>;
    }).acquireSchedulerLock();

    assert.equal(held, true, "a fresh table must yield the lock");
    assert.equal(lease(db)?.holder, "instance-under-test");
    assert.equal(issued.length, 1, "the lock must cost one statement, not a BEGIN/…/COMMIT sequence");
    for (const keyword of ["BEGIN", "COMMIT", "ROLLBACK"]) {
      assert.ok(
        !new RegExp(`\\b${keyword}\\b`, "i").test(issued[0]),
        `the scheduler must not manage transactions itself (issued ${keyword})`,
      );
    }
  } finally {
    if (previousId === undefined) delete process.env.INSTANCE_ID;
    else process.env.INSTANCE_ID = previousId;
  }
});
