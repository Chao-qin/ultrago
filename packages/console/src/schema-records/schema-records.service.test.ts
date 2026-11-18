import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SchemaRecordsService } from "./schema-records.service.js";
import { SchemaRecordsController } from "./schema-records.controller.js";

/**
 * This module had no tests at all, and the two things it does that nothing else
 * can see were both invisible to the rest of the suite:
 *
 *   1. `sourcePrefix` narrowing. Drop it — from the controller's `@Query`
 *      binding or from the service's `where.source` — and every page still
 *      renders correctly, because the detail pages pick their row out of the
 *      answer with `.find()`. Only the transferred bytes change, and the fix
 *      that introduced this filter had zero coverage guarding it.
 *   2. The `preview` projection. Its whole point is that `data` is ABSENT
 *      rather than shortened, because a shortened payload under the `data` key
 *      is indistinguishable from a real one and the edit form writes back
 *      whatever it finds there.
 *
 * So the assertions here are on the `where` the service builds and on the shape
 * it returns — not on what a caller would render.
 */

/** A SchemaRecord table standing in for the database. `findMany` records the
 *  `where` it was handed and returns the seed unfiltered: what is under test is
 *  the query the service SENDS and the shape it returns, not SQLite's ability
 *  to apply a filter. */

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
  const wheres: Array<Record<string, unknown>> = [];
  const prisma = {
    schemaRecord: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        wheres.push(where);
        return seed.map((r) => ({ ...r }));
      },
    },
  };
  return { svc: new SchemaRecordsService(prisma as never), wheres };
}

/** The contract branch: a payload body, no file. */
const contractRow = (data: string) => ({
  id: "c1", contentType: "application/json", schemaName: "product", schemaVersion: 1,
  data, schemaErrors: null, fileName: null, url: null, bytes: data.length,
  source: null, deletedAt: null, createdAt: "2026-08-01", updatedAt: "2026-08-01",
});

/** The file branch: bytes on disk, no payload body. */
const fileRow = () => ({
  id: "f1", contentType: "application/json", schemaName: null, schemaVersion: null,
  data: null, schemaErrors: null, fileName: "abc-report.json", url: "/api/records/abc-report.json",
  bytes: 28_652_646, source: "file:reports/x.json", deletedAt: null,
  createdAt: "2026-08-01", updatedAt: "2026-08-01",
});

// ── sourcePrefix narrowing ────────────────────────────────────────────────

test("list() narrows by sourcePrefix with a startsWith predicate", async () => {
  const { svc, wheres } = serviceOver();
  await svc.list({ sourcePrefix: "run:abc123" });
  // startsWith, not equality: `run:<id>` has to also match the run's artifact
  // keys (`run:<id>:artifact:<path>`), which is the whole reason a prefix is
  // the filter rather than the source key itself.
  assert.deepEqual(wheres[0].source, { startsWith: "run:abc123" });
});

test("list() without sourcePrefix does not constrain source at all", async () => {
  const { svc, wheres } = serviceOver();
  await svc.list({});
  // Absent, not `undefined`: Prisma treats an explicit `source: undefined` as
  // "no filter" too, but the browse page relies on the whole table coming back
  // and a stray key here is how that quietly stops being true.
  assert.ok(!("source" in wheres[0]), `source must be absent, got ${JSON.stringify(wheres[0])}`);
});

test("list() combines sourcePrefix with the other filters", async () => {
  const { svc, wheres } = serviceOver();
  await svc.list({ schemaName: "product", sourcePrefix: "flow:xyz", includeDeleted: true });
  assert.equal(wheres[0].schemaName, "product");
  assert.deepEqual(wheres[0].source, { startsWith: "flow:xyz" });
  assert.ok(!("deletedAt" in wheres[0]), "includeDeleted must lift the soft-delete predicate");
});

test("list() hides soft-deleted rows unless asked", async () => {
  const { svc, wheres } = serviceOver();
  await svc.list({ sourcePrefix: "run:abc" });
  assert.equal(wheres[0].deletedAt, null);
});

// ── the preview projection ────────────────────────────────────────────────

test("list() returns payload bodies untouched by default", async () => {
  // The detail pages depend on this: they narrow by sourcePrefix and then show
  // the payload. A projection applied unconditionally would silently empty them.
  const payload = JSON.stringify({ hello: "world" });
  const { svc } = serviceOver([contractRow(payload)]);
  const [row] = (await svc.list({ sourcePrefix: "run:abc" })) as Array<Record<string, unknown>>;
  assert.equal(row.data, payload);
  assert.ok(!("dataPreview" in row), "the full projection must not invent a preview field");
});

test("list({ preview }) removes the payload body instead of shortening it", async () => {
  const payload = JSON.stringify({ big: "x".repeat(5_000) });
  const { svc } = serviceOver([contractRow(payload)]);
  const [row] = (await svc.list({ preview: true })) as Array<Record<string, unknown>>;
  // The load-bearing assertion of this file. A truncated string left under
  // `data` would satisfy "the response got smaller" while handing the edit form
  // a payload it would write straight back, truncated — silent data loss.
  assert.ok(!("data" in row), `preview rows must not carry a "data" key, got ${Object.keys(row)}`);
});

test("list({ preview }) cuts the head at exactly PREVIEW_CHARS and flags it", async () => {
  const payload = JSON.stringify({ big: "x".repeat(5_000) });
  const { svc } = serviceOver([contractRow(payload)]);
  const [row] = (await svc.list({ preview: true })) as Array<Record<string, unknown>>;
  // Asserted against the LITERAL 200, not against the imported constant: a test
  // that reads the cap from the code under test cannot catch the cap moving.
  // The previous version allowed 1024 — five times the real value — so raising
  // PREVIEW_CHARS to 1000 left it green. This is the whole contract of the
  // projection: one row costs the list the same no matter how big the payload.
  assert.deepEqual(row.dataPreview, { head: payload.slice(0, 200), truncated: true });
  assert.equal((row.dataPreview as { head: string }).head.length, 200);
});

test("list({ preview }) never cuts a surrogate pair in half", async () => {
  // "a"×199 + "😀" puts the emoji's high surrogate at code unit 200. Slicing
  // there leaves a lone \ud83d, which JSON.stringify emits verbatim and the
  // browser renders as U+FFFD. One character short beats one broken one.
  const payload = "a".repeat(199) + "😀";
  const { svc } = serviceOver([contractRow(payload)]);
  const [row] = (await svc.list({ preview: true })) as Array<Record<string, unknown>>;
  const { head, truncated } = row.dataPreview as { head: string; truncated: boolean };
  assert.equal(head, "a".repeat(199), "the straddling high surrogate must be dropped");
  assert.equal(truncated, true);
  // The load-bearing check: no unpaired surrogate survives into the response.
  assert.equal(JSON.stringify(head).includes("\\ud83d"), false, `lone surrogate in ${JSON.stringify(head).slice(-20)}`);
});

test("list({ preview }) leaves a short payload whole and unflagged", async () => {
  const payload = JSON.stringify({ hi: 1 });
  const { svc } = serviceOver([contractRow(payload)]);
  const [row] = (await svc.list({ preview: true })) as Array<Record<string, unknown>>;
  // `truncated: false` is what lets the page tell "this is all of it" from
  // "this is the head of it" — and it is what makes the 非法 JSON verdict
  // decidable, since only a whole payload is supposed to parse.
  assert.deepEqual(row.dataPreview, { head: payload, truncated: false });
});

test("list({ preview }) keeps an empty payload distinct from a missing one", async () => {
  // `planOutputRecord` lands "the run produced nothing" as `data: ""` on the
  // payload branch. It must not collapse into the file branch's null, which is
  // what decides whether the page offers a download link or an edit button.
  const { svc } = serviceOver([contractRow("")]);
  const [row] = (await svc.list({ preview: true })) as Array<Record<string, unknown>>;
  assert.deepEqual(row.dataPreview, { head: "", truncated: false });
});

test("list({ preview }) gives the file branch a null preview", async () => {
  const { svc } = serviceOver([fileRow()]);
  const [row] = (await svc.list({ preview: true })) as Array<Record<string, unknown>>;
  // Null, not an empty preview: the file branch has no payload body at all, and
  // that is exactly the distinction the page's branch predicate reads.
  assert.equal(row.dataPreview, null);
  assert.equal(row.fileName, "abc-report.json", "the rest of the row must survive the projection");
  assert.equal(row.bytes, 28_652_646);
});

// ── the write paths' server-side guards ───────────────────────────────────

/**
 * A SchemaRecord table that ENFORCES the two things the real database enforces
 * and the service used to leave to it:
 *
 *   - `CHECK ((data IS NULL) <> (url IS NULL))` — the branch exclusion.
 *   - `uniq_active_record_source` — a partial UNIQUE on `source`
 *     `WHERE source IS NOT NULL AND deletedAt IS NULL`.
 *
 * Both are copied from the live schema (read out of resource/db/console.db with
 * `node:sqlite` in readOnly mode on 2026-08-28). They are modelled here rather
 * than assumed away because the failure being fixed IS the constraint firing:
 * a fake that accepts every write would let a service with no guard look
 * perfectly healthy, which is exactly the "假防线" this file must not become.
 * The errors thrown mimic the raw driver error that used to reach the client as
 * a 500, so a missing guard fails LOUDLY and for the right reason.
 */
function writableServiceOver(seed: Array<Record<string, unknown>>, schemas: Array<Record<string, unknown>> = []) {
  const rows = seed.map((r) => ({ ...r }));
  /** An `undefined` VALUE is SKIPPED, not compared — because that is what Prisma
   *  does with it: it means "this field takes no part in the filter", never
   *  "this field must be undefined". Modelled rather than assumed away for the
   *  same reason as the constraints above: a fake that compared `undefined`
   *  literally would turn the silent-mislabelling bug (see the missing-
   *  `schemaName` tests) into a tidy 404 and make its guard look unnecessary.
   *  Verified read-only against the real client on 2026-08-28:
   *  `schema.findFirst({ where: { name: undefined, deletedAt: null, active: true } })`
   *  returned `canonical-product@1` out of the registry's 12 active schemas.
   *  `orderBy` is not modelled — seed order stands in for it, which is enough,
   *  since what is under test is that SOME unasked-for schema gets picked. */
  const match = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => v === undefined || row[k] === v);
  const prisma = {
    schemaRecord: {
      findFirst: async ({ where }: any) => rows.find((r) => match(r, where)) ?? null,
      findUnique: async ({ where }: any) => rows.find((r) => match(r, where)) ?? null,
      update: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error(`no row ${where.id}`);
        const next = { ...row, ...data };
        if ((next.data === null) === (next.url === null)) {
          throw new Error("SQLITE_CONSTRAINT_CHECK: CHECK constraint failed: SchemaRecord");
        }
        if (next.source !== null && next.deletedAt === null) {
          const clash = rows.find((r) => r !== row && r.source === next.source && r.deletedAt === null);
          if (clash) throw new Error("SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: SchemaRecord.source");
        }
        Object.assign(row, next);
        return row;
      },
      create: async ({ data }: any) => {
        const row = { id: `new_${rows.length}`, deletedAt: null, source: null, url: null, ...data };
        rows.push(row);
        return row;
      },
    },
    schema: { findFirst: async ({ where }: any) => schemas.find((s) => match(s, where)) ?? null },
  };
  return { svc: new SchemaRecordsService(withTx(prisma) as never), rows, tx };
}

/** A live file-branch row: bytes on disk, `data` null, `url` set. */
const liveFileRow = (over: Record<string, unknown> = {}) => ({
  ...fileRow(), source: "run:r1:artifact:out.md", deletedAt: null, ...over,
});

const objectSchema = {
  id: "s1", name: "product", version: 1, deletedAt: null, active: true,
  jsonSchema: JSON.stringify({ type: "object" }),
};

/** A second registered contract, seeded AHEAD of `objectSchema` wherever the
 *  missing-`schemaName` tests need it. Its whole job is to make "the lookup
 *  ignored the name" observable: with one schema in the registry, picking
 *  arbitrarily and picking correctly land on the same row. */
const otherSchema = {
  id: "s2", name: "shop-profile", version: 1, deletedAt: null, active: true,
  jsonSchema: JSON.stringify({ type: "object" }),
};

test("update() refuses a file-branch row with a 400 instead of letting the CHECK 500", async () => {
  const { svc, rows } = writableServiceOver([liveFileRow()]);
  await assert.rejects(
    () => svc.update("f1", { data: { anything: true } } as never),
    (e: any) => {
      // 400, not the raw SQLITE_CONSTRAINT_CHECK that used to escape as a 500:
      // main.ts installs no ValidationPipe and the app has no ExceptionFilter,
      // so an unguarded Prisma error IS the response.
      assert.equal(e.getStatus?.(), 400, `expected a 400, got ${e.getStatus?.()} / ${e.message}`);
      assert.match(e.message, /file record/);
      return true;
    },
  );
  // The row is untouched — the guard fires before the write is attempted.
  assert.equal(rows[0].data, null);
  assert.equal(rows[0].url, "/api/records/abc-report.json");
});

test("update() still writes a payload-branch row", async () => {
  // The other half of the guard: it must reject the file branch WITHOUT
  // rejecting the branch the edit form actually uses.
  const { svc, rows } = writableServiceOver(
    [{ ...contractRow('{"old":1}'), source: null, url: null }],
    [objectSchema],
  );
  await svc.update("c1", { data: { fresh: 2 } } as never);
  assert.equal(rows[0].data, '{"fresh":2}');
  assert.equal(rows[0].bytes, Buffer.byteLength('{"fresh":2}', "utf8"));
});

test("restore() reports a source collision as 409 rather than a unique violation", async () => {
  // Reachable by ordinary use: delete `run:<id>`, let the run land again (a new
  // live row takes the same source), then restore the old one.
  const { svc, rows } = writableServiceOver([
    liveFileRow({ id: "old", source: "run:r9", deletedAt: new Date("2026-08-01") }),
    liveFileRow({ id: "relanded", source: "run:r9", deletedAt: null }),
  ]);
  await assert.rejects(
    () => svc.restore("old"),
    (e: any) => {
      assert.equal(e.getStatus?.(), 409, `expected a 409, got ${e.getStatus?.()} / ${e.message}`);
      assert.match(e.message, /run:r9/);
      assert.match(e.message, /relanded/, "the message must name the row that is in the way");
      return true;
    },
  );
  assert.notEqual(rows[0].deletedAt, null, "the collided row must stay deleted");
});

test("restore() still revives a row whose source is free", async () => {
  const { svc, rows } = writableServiceOver([
    liveFileRow({ id: "old", source: "run:r9", deletedAt: new Date("2026-08-01") }),
  ]);
  await svc.restore("old");
  assert.equal(rows[0].deletedAt, null);
});

test("restore() does not block a sourceless row, which no index constrains", async () => {
  // `uniq_active_record_source` is partial (`WHERE source IS NOT NULL`), so two
  // live rows with a NULL source are legal and must not be refused.
  const { svc, rows } = writableServiceOver([
    { ...contractRow('{"a":1}'), id: "hand1", source: null, url: null, deletedAt: new Date("2026-08-01") },
    { ...contractRow('{"b":2}'), id: "hand2", source: null, url: null, deletedAt: null },
  ]);
  await svc.restore("hand1");
  assert.equal(rows[0].deletedAt, null);
});

test("create() answers unparseable JSON with 400, not a raw SyntaxError", async () => {
  const { svc } = writableServiceOver([], [objectSchema]);
  await assert.rejects(
    () => svc.create({ schemaName: "product", data: "{oops" } as never),
    (e: any) => {
      assert.equal(e.getStatus?.(), 400, `expected a 400, got ${e.getStatus?.()} / ${e.message}`);
      assert.match(e.message, /not valid JSON/);
      return true;
    },
  );
});

test("create() answers a missing data key with 400, not Buffer.byteLength(undefined)", async () => {
  // `JSON.stringify(undefined)` is `undefined`, which used to reach
  // `Buffer.byteLength` and throw a TypeError — a 500 for an empty body.
  const { svc } = writableServiceOver([], [objectSchema]);
  await assert.rejects(
    () => svc.create({ schemaName: "product" } as never),
    (e: any) => {
      assert.equal(e.getStatus?.(), 400, `expected a 400, got ${e.getStatus?.()} / ${e.message}`);
      assert.match(e.message, /data is required/);
      return true;
    },
  );
});

test("create() refuses a missing schemaName instead of resolving an arbitrary schema", async () => {
  // `main.ts:72-75` deliberately installs no global ValidationPipe, so
  // `CreateSchemaRecordInput.schemaName`'s declared `string` is a claim about
  // the request body, not a fact about it: a POST that omits the key arrives
  // here as `undefined`. Prisma then reads `where.name = undefined` as "do not
  // filter on name", so the lookup narrows on `deletedAt`/`active` alone and
  // returns whichever active schema comes first.
  const { svc, rows } = writableServiceOver([], [otherSchema, objectSchema]);
  await assert.rejects(
    () => svc.create({ data: { anything: true } } as never),
    (e: any) => {
      assert.equal(e.getStatus?.(), 400, `expected a 400, got ${e.getStatus?.()} / ${e.message}`);
      assert.match(e.message, /schemaName is required/);
      return true;
    },
  );
  // The load-bearing assertion. A wrong STATUS would be a nuisance; the actual
  // damage is a WRITE. `{ anything: true }` satisfies `{ type: "object" }`, so
  // the unguarded path does not fail anywhere — it validates against the schema
  // it happened to pick and stores a row stamped `shop-profile@1`, a contract
  // the caller never named. Nothing downstream can tell that row from one that
  // was labelled on purpose.
  assert.equal(rows.length, 0, `no record may be created, got ${JSON.stringify(rows)}`);
});

test("create() refuses a blank schemaName the same way as an absent one", async () => {
  const { svc, rows } = writableServiceOver([], [otherSchema, objectSchema]);
  for (const schemaName of ["", "   "]) {
    await assert.rejects(
      () => svc.create({ schemaName, data: { a: 1 } } as never),
      (e: any) => {
        // Blank does not hit the `undefined` hole — `where.name = ""` matches no
        // row — so unguarded it is a 404 about a schema named "". Still wrong:
        // a malformed request reported as a missing resource.
        assert.equal(e.getStatus?.(), 400, `expected a 400 for ${JSON.stringify(schemaName)}, got ${e.getStatus?.()} / ${e.message}`);
        assert.match(e.message, /schemaName is required/);
        return true;
      },
    );
  }
  assert.equal(rows.length, 0, `no record may be created, got ${JSON.stringify(rows)}`);
});

test("create() still stores a record under the schema it was actually given", async () => {
  // The other half of the guard: refusing the absent name must not cost the
  // path that supplies one. `otherSchema` is seeded FIRST, so this also fails
  // if the lookup stops honouring the name it was handed.
  const { svc, rows } = writableServiceOver([], [otherSchema, objectSchema]);
  await svc.create({ schemaName: "product", data: { fresh: 1 } } as never);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].schemaName, "product", "the row must be stamped with the schema the caller named");
  assert.equal(rows[0].schemaVersion, 1);
  assert.equal(rows[0].data, '{"fresh":1}');
  assert.equal(rows[0].bytes, Buffer.byteLength('{"fresh":1}', "utf8"));
});

test("update() guards the payload the same way create() does", async () => {
  const { svc } = writableServiceOver(
    [{ ...contractRow('{"old":1}'), source: null, url: null }],
    [objectSchema],
  );
  for (const [body, pattern] of [[{ data: "{oops" }, /not valid JSON/], [{}, /data is required/]] as const) {
    await assert.rejects(
      () => svc.update("c1", body as never),
      (e: any) => {
        assert.equal(e.getStatus?.(), 400, `expected a 400 for ${JSON.stringify(body)}, got ${e.getStatus?.()} / ${e.message}`);
        assert.match(e.message, pattern);
        return true;
      },
    );
  }
});

test("null is a payload, not a missing one", async () => {
  // `JsonValue` includes null and `JSON.stringify(null)` is "null" — only the
  // ABSENT key is an error, so the guard must not swallow a legitimate null.
  const { svc, rows } = writableServiceOver(
    [{ ...contractRow('{"old":1}'), source: null, url: null }],
    [{ ...objectSchema, jsonSchema: JSON.stringify({}) }],
  );
  await svc.update("c1", { data: null } as never);
  assert.equal(rows[0].data, "null");
});

// ── the HTTP contract ─────────────────────────────────────────────────────

/** Boot the real controller behind real Nest routing, with the service faked.
 *  A direct method call cannot see a missing `@Query` decorator — the argument
 *  arrives either way when you pass it yourself. Only routing can. */
async function overHttp<T>(fn: (baseUrl: string, calls: Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const calls: Array<Record<string, unknown>> = [];
  const fake = { list: async (opts: Record<string, unknown>) => { calls.push(opts); return []; } };

  @Module({
    controllers: [SchemaRecordsController],
    providers: [{ provide: SchemaRecordsService, useValue: fake }],
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0);
  try {
    return await fn((await app.getUrl()).replace("[::1]", "127.0.0.1"), calls);
  } finally {
    await app.close();
  }
}

test("GET /api/schema-records binds sourcePrefix off the query string", async () => {
  await overHttp(async (base, calls) => {
    const res = await fetch(`${base}/api/schema-records?sourcePrefix=run:abc123`);
    // The path is asserted by the 200: a controller mounted anywhere else 404s.
    assert.equal(res.status, 200);
    assert.equal(calls[0].sourcePrefix, "run:abc123");
  });
});

test("GET /api/schema-records binds every filter it accepts", async () => {
  await overHttp(async (base, calls) => {
    await fetch(`${base}/api/schema-records?schemaName=product&sourcePrefix=flow:xyz&includeDeleted=true&preview=true`);
    assert.deepEqual(calls[0], {
      schemaName: "product",
      sourcePrefix: "flow:xyz",
      includeDeleted: true,
      preview: true,
    });
  });
});

test("GET /api/schema-records defaults the two flags off", async () => {
  await overHttp(async (base, calls) => {
    await fetch(`${base}/api/schema-records`);
    // Anything other than the literal "true" is off — a bare `?preview` or
    // `?includeDeleted=1` must not silently change what the caller gets.
    assert.equal(calls[0].includeDeleted, false);
    assert.equal(calls[0].preview, false);
    assert.equal(calls[0].sourcePrefix, undefined);
  });
});

test("restore() runs its collision check and its write in one transaction", async () => {
  // Three loose statements let another restore — or an ordinary upsertBySource
  // landing a fresh run — commit a live row for this source between the check
  // and the UPDATE. The check's answer would then be stale, the partial index
  // would reject the write anyway, and the caller would get the bare conflict
  // this pre-check was written to replace with a message naming the offender.
  const { svc, tx } = writableServiceOver([
    liveFileRow({ id: "r1", source: "run:1", deletedAt: new Date("2026-08-01") }),
  ]);
  const before = tx.opened;
  await svc.restore("r1");
  assert.equal(tx.opened, before + 1);
});

test("restore() still reports a live collision rather than writing", async () => {
  // The counterpart: opening a transaction must not be mistaken for keeping the
  // guard that lives inside it.
  const { svc, rows } = writableServiceOver([
    liveFileRow({ id: "r1", source: "run:1", deletedAt: new Date("2026-08-01") }),
    liveFileRow({ id: "r2", source: "run:1", deletedAt: null }),
  ]);
  await assert.rejects(() => svc.restore("r1"), /already has a live record/);
  assert.notEqual(rows.find((r) => r.id === "r1")?.deletedAt, null, "the row must stay deleted");
});
