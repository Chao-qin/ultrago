import { test } from "node:test";
import assert from "node:assert/strict";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { BooksService } from "./books.service.js";

/**
 * Match one row against the `where` shapes this service builds — scalar
 * equality plus the `deletedAt: null` soft-delete predicate.
 *
 * Anything unrecognised THROWS rather than quietly matching, for the same
 * reason SchemasService's double does: a test double that shrugs at an unknown
 * filter is how a query silently stops filtering while every assertion passes.
 */
function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  const entries = Object.entries(where);
  // An empty `where` is not "matches everything" — it is "the filter was
  // dropped". `[].every()` is true, so that bug would surface as a clean hit on
  // the first row with every assertion still green, which is the exact failure
  // this double claims to prevent. No caller here queries without a filter.
  if (entries.length === 0) {
    throw new Error("test double: findFirst with no filter — the where clause was dropped");
  }
  return entries.every(([key, cond]) => {
    // `deletedAt: null` must treat "absent" and "explicitly null" alike — a
    // seed row simply omits the column when it is not deleted.
    if (cond === null) return row[key] === null || row[key] === undefined;
    if (typeof cond === "object") {
      throw new Error(`test double: unsupported filter ${key}=${JSON.stringify(cond)}`);
    }
    return row[key] === cond;
  });
}

/** A book table standing in for the database, holding only what `update`
 *  reads and writes. `filesync` is never reached on this path, so it is not
 *  built — a stub that pretended to rescan would just be a second thing to
 *  keep true.
 *
 *  Every statement is tagged with the client it went through, `"base"` or
 *  `"tx"`. That is what makes "did this run inside the transaction" an
 *  observable fact instead of an invisible one: the earlier version of this
 *  double handed the `$transaction` callback the SAME `book` object it hung off
 *  `prisma`, so moving `update()`'s guard back outside the transaction changed
 *  nothing any assertion could see (verified: the full suite stayed green with
 *  the guard hoisted out). Real Prisma hands an interactive transaction its own
 *  client, and reproducing that distinction is the whole point here.
 *
 *  What this still cannot show: the double is single-threaded, so nothing here
 *  exercises the interleaving a real transaction excludes. It pins the SHAPE
 *  (guard and write on one client) rather than the isolation. Proving the
 *  isolation needs two concurrent connections against a real database, which
 *  this suite does not have. */
function serviceOver(seed: Array<Record<string, unknown>>) {
  const rows = seed.map((r) => ({ ...r }));
  const updated: Array<{ id: string; data: Record<string, unknown> }> = [];
  const calls: Array<{ via: "base" | "tx"; op: "findFirst" | "update" }> = [];

  const bookClient = (via: "base" | "tx") => ({
    findFirst: async ({ where }: { where?: Record<string, unknown> }) => {
      calls.push({ via, op: "findFirst" });
      return rows.find((r) => matches(r, where)) ?? null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      calls.push({ via, op: "update" });
      const row = rows.find((r) => r.id === where.id);
      // Real Prisma throws P2025 for an id that is not there; it does not
      // return undefined. A double that shrugs lets "the guard failed and the
      // update hit nothing" pass for a harmless no-op.
      if (!row) {
        throw Object.assign(
          new Error(`test double: update() on missing row ${where.id} (real Prisma throws P2025)`),
          { code: "P2025" },
        );
      }
      updated.push({ id: where.id, data });
      Object.assign(row, data);
      return row;
    },
  });

  const prisma = {
    book: bookClient("base"),
    $transaction: async <T>(fn: (tx: { book: ReturnType<typeof bookClient> }) => Promise<T>): Promise<T> =>
      fn({ book: bookClient("tx") }),
  };
  return { svc: new BooksService(prisma as never, undefined as never), rows, updated, calls };
}

const LIVE = { id: "live", name: "b-live", enabled: true, description: null, tags: null, deletedAt: null };
const DELETED = { id: "gone", name: "b-gone", enabled: false, description: null, tags: null, deletedAt: new Date("2026-08-01") };

test("update() refuses a soft-deleted book", async () => {
  const { svc, updated } = serviceOver([LIVE, DELETED]);
  await assert.rejects(
    () => svc.update("gone", { description: "edited after deletion" }),
    NotFoundException,
  );
  // The refusal has to happen BEFORE the write, not just in what it returns.
  assert.deepEqual(updated, [], "a rejected update must not have written anything");
});

test("update() cannot re-enable a soft-deleted book", async () => {
  // The sharpest edge of the same hole: `enabled: true` on a deleted row is a
  // resurrection that `delete()` never sanctioned, and the row would then be
  // live to the scheduler while still invisible in every list.
  const { svc, rows } = serviceOver([DELETED]);
  await assert.rejects(() => svc.update("gone", { enabled: true }), NotFoundException);
  assert.equal(rows[0].enabled, false, "the deleted book must stay disabled");
});

test("update() still patches a live book", async () => {
  const { svc, updated } = serviceOver([LIVE, DELETED]);
  await svc.update("live", { description: "hello", enabled: false });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, "live");
  assert.deepEqual(updated[0].data, { description: "hello", enabled: false });
});

test("update() reports a missing book the same way as a deleted one", async () => {
  // Same 404 for "never existed" and "deleted": which of the two it is is not
  // something a caller holding a stale id is entitled to learn.
  const { svc } = serviceOver([LIVE]);
  await assert.rejects(() => svc.update("no-such-id", { enabled: true }), NotFoundException);
});

test("update() reads and writes on the transaction's client, not the base one", async () => {
  // The guard exists to stop a resurrection; running it BEFORE the transaction
  // leaves a window where a concurrent delete() commits in between, and the
  // resurrection walks through. Every other assertion in this file passes with
  // the guard hoisted out — this is the one that does not.
  const { svc, calls } = serviceOver([LIVE]);
  await svc.update("live", { enabled: false });
  assert.deepEqual(
    calls,
    [{ via: "tx", op: "findFirst" }, { via: "tx", op: "update" }],
    "the check and the write must both go through the transaction's client",
  );
});

test("update() rejects a deleted book from inside the transaction too", async () => {
  // The refusal path, same requirement: a guard that only runs atomically on
  // the happy path is not a guard.
  const { svc, calls } = serviceOver([DELETED]);
  await assert.rejects(() => svc.update("gone", { enabled: true }), NotFoundException);
  assert.deepEqual(calls, [{ via: "tx", op: "findFirst" }]);
});

test("update() validates before opening a transaction", async () => {
  // The other half of the same decision: rejecting a malformed patch is not a
  // database call and must not hold a transaction open. `normalizeTags` throws
  // on a non-string, so nothing should reach either client.
  const { svc, calls } = serviceOver([LIVE]);
  await assert.rejects(() => svc.update("live", { tags: 42 as never }), BadRequestException);
  assert.deepEqual(calls, [], "a rejected patch must not have touched the database at all");
});

// ── filesync is manual ───────────────────────────────────────────────────
//
// `list()` used to call `filesync.rescan()`, and `rescan()` still does. The
// difference is invisible to the type checker and was invisible to this suite:
// removing the call from `list()` broke nothing, because nothing counted it.
// A spy makes "who reaches filesync" an observable fact, which is the only way
// a later edit that quietly restores the old behaviour shows up as a failure.
function serviceWithFilesyncSpy(books: Array<Record<string, unknown>> = []) {
  let rescans = 0;
  const prisma = {
    book: {
      findMany: async () => books.map((b) => ({ runs: [], schedules: [], tags: null, ...b })),
    },
  };
  const filesync = {
    rescan: async () => {
      rescans += 1;
      // Must mirror `FilesyncService.rescan`'s real return shape. It was a bare
      // number until 2026-08-28; a double left pinning that older contract goes
      // on passing after the service has moved, and — because it is injected
      // `as never` — typecheck cannot notice. The double would then be
      // asserting that a regression is correct.
      return { indexed: books.length, written: books.length, missing: [] };
    },
  };
  return { svc: new BooksService(prisma as never, filesync as never), rescans: () => rescans };
}

test("list() does not rescan the playbooks directory", async () => {
  // The whole point of the 2026-08-28 change: a GET must not write. `rescan()`
  // upserts every row unconditionally, so a list request that rescanned bumped
  // `fileMtime`/`@updatedAt` on every book — and the Books page polled this
  // endpoint every 5s.
  const { svc, rescans } = serviceWithFilesyncSpy([{ id: "b1", name: "alpha" }]);
  const rows = await svc.list();
  assert.equal(rows.length, 1, "the list itself must still work");
  assert.equal(rescans(), 0, "listing books must not touch resource/playbooks/");
});

test("list() does not rescan when including deleted books either", async () => {
  // Same requirement on the other branch: `includeDeleted` changes the filter,
  // not whether a read is allowed to write.
  const { svc, rescans } = serviceWithFilesyncSpy([{ id: "b1", name: "alpha" }]);
  await svc.list({ includeDeleted: true });
  assert.equal(rescans(), 0);
});

test("rescan() is the one path that does reach filesync", async () => {
  // The counterpart assertion. Without it, "list() must not rescan" is
  // satisfiable by a service that can no longer rescan at all, which would
  // leave the 重新扫描 button dead — the exact failure this change had to avoid.
  const { svc, rescans } = serviceWithFilesyncSpy([{ id: "b1", name: "alpha" }, { id: "b2", name: "beta" }]);
  const result = await svc.rescan();
  assert.equal(rescans(), 1, "POST /api/books/rescan must still re-index");
  assert.equal(result.indexed, 2, "and must resolve to the count, which the UI displays");
  assert.deepEqual(result.missing, [], "the orphan report must reach the caller, not stop at the log");
});
