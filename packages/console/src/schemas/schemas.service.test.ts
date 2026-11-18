import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSchemaContract, parseCitation } from "@bcp/shared";
import { SchemasService } from "./schemas.service.js";

/**
 * Match one row against the `where` shapes this service actually builds:
 * scalar equality, the `name_version` composite, `{ in: [...] }`, and the
 * `deletedAt: null` soft-delete predicate.
 *
 * Anything it does not recognise THROWS rather than quietly matching. A test
 * double that shrugs at an unknown filter is how a query silently stops
 * filtering and every assertion still passes.
 */

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

function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "name_version") {
      const nv = cond as { name: string; version: number };
      return row.name === nv.name && row.version === nv.version;
    }
    // `deletedAt: null` has to treat "absent" and "explicitly null" alike —
    // a seed row simply omits the column when it is not deleted.
    if (cond === null) return row[key] === null || row[key] === undefined;
    if (typeof cond === "object") {
      if ("in" in (cond as object)) return (cond as { in: unknown[] }).in.includes(row[key]);
      throw new Error(`test double: unsupported filter ${key}=${JSON.stringify(cond)}`);
    }
    return row[key] === cond;
  });
}

/** A registry standing in for the database, holding just the fields the
 *  lineage lookup reads. Enough to exercise the one contract rule that cannot
 *  be pure, without dragging a real SQLite file into a unit test.
 *
 *  Rows are cloned from the seed so a test that writes (soft delete is a
 *  write) cannot leak into the shared CANONICAL / PROJECTION constants. */
function serviceOver(seed: Array<Record<string, unknown>>, recordSeed: Array<Record<string, unknown>> = []) {
  const rows = seed.map((r) => ({ ...r }));
  const records = recordSeed.map((r) => ({ ...r }));
  const hardDeleted: string[] = [];
  const prisma = {
    // remove() has a SECOND dependent to check besides `derivesFrom`. It runs
    // through the same `matches` helper, which throws on a filter it does not
    // recognise — so a guard that stopped narrowing on name / version /
    // deletedAt would be caught here rather than passing by accident.
    schemaRecord: {
      findMany: async ({ where }: { where?: Record<string, unknown> }) =>
        records.filter((r) => matches(r, where)),
    },
    schema: {
      findFirst: async ({ where }: { where?: Record<string, unknown> }) =>
        rows.find((r) => matches(r, where)) ?? null,
      // register() looks a row up by the name+version composite, findById() by
      // primary key — the same method serving two shapes of `where`.
      findUnique: async ({ where }: { where?: Record<string, unknown> }) =>
        rows.find((r) => matches(r, where)) ?? null,
      findMany: async ({ where }: { where?: Record<string, unknown> }) =>
        rows.filter((r) => matches(r, where)),
      create: async ({ data }: { data: unknown }) => data,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return data;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        hardDeleted.push(where.id);
        const index = rows.findIndex((r) => r.id === where.id);
        return index === -1 ? null : rows.splice(index, 1)[0];
      },
    },
  };
  return { svc: new SchemasService(withTx(prisma) as never), rows, records, hardDeleted, tx };
}

/** Most tests only want the service. */
function serviceOnly(seed: Array<Record<string, unknown>>): SchemasService {
  return serviceOver(seed).svc;
}

const CANONICAL = { id: "c1", name: "canonical-product", version: 1, kind: "canonical", entity: "product", upstreamRef: null, derivesFrom: null };
const PROJECTION = { id: "p1", name: "doudian-addv2", version: 1, kind: "projection", entity: "product", upstreamRef: null, derivesFrom: "canonical-product@1" };

/** The three rows actually in the registry on 2026-08-26, reduced to the fields
 *  the contract rules look at. Pinned here so a future rule that would
 *  retroactively outlaw real data fails in CI rather than at the next
 *  registration. `canonical-product` is listed with upstreamRef null because
 *  migration 20260826000000 cleared it — that clearing is the whole point. */
const REGISTERED = [
  { name: "canonical-product", kind: "canonical", entity: "product", upstreamRef: null, derivesFrom: null },
  {
    name: "doudian-addv2",
    kind: "projection",
    entity: "product",
    upstreamRef: "https://op.jinritemai.com/docs/api-docs/14/249",
    derivesFrom: "canonical-product@1",
  },
  { name: "shop-profile", kind: "config", entity: "shop", upstreamRef: null, derivesFrom: null },
];

test("every row already in the registry satisfies the contract rules", () => {
  for (const row of REGISTERED) {
    assert.deepEqual(checkSchemaContract(row), [], `${row.name} should be clean`);
  }
});

test("a canonical may not mirror an external authority", () => {
  // The exact shape canonical-product shipped in: pointing at the same Doudian
  // docs its own projection cites, which is what made it an alias rather than
  // a neutral shape.
  const problems = checkSchemaContract({
    name: "canonical-product",
    kind: "canonical",
    entity: "product",
    upstreamRef: "https://op.jinritemai.com/docs/api-docs/14/249",
    derivesFrom: null,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /canonical schema mirrors no external authority/);
});

test("a canonical may not be projected from anything", () => {
  const problems = checkSchemaContract({
    name: "canonical-product",
    kind: "canonical",
    derivesFrom: "something-else",
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /projected from nothing/);
});

test("a projection must cite its canonical", () => {
  const problems = checkSchemaContract({ name: "doudian-addv2", kind: "projection", entity: "product" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /must cite the canonical it derives from/);
});

test("kinds other than canonical/projection are not dragged into the lineage rules", () => {
  for (const kind of ["config", "book_input", "book_output", "entity"]) {
    assert.deepEqual(checkSchemaContract({ name: "shop-profile", kind, entity: "shop" }), [], `${kind} should be clean`);
  }
});

test("entity must be kebab-case, and null stays legal", () => {
  assert.deepEqual(checkSchemaContract({ name: "a-thing", kind: "entity", entity: null }), []);
  assert.deepEqual(checkSchemaContract({ name: "a-thing", kind: "entity" }), []);
  for (const bad of ["Product", "商品", "my_entity", "trailing-", "两 words"]) {
    const problems = checkSchemaContract({ name: "a-thing", kind: "entity", entity: bad });
    assert.equal(problems.length, 1, `${bad} should be rejected`);
    assert.match(problems[0], /entity must be kebab-case/);
  }
});

test("a lineage citation must be name or name@version", () => {
  for (const bad of ["Canonical Product", "canonical-product@0", "canonical-product@abc", "canonical-product@", "@1"]) {
    const problems = checkSchemaContract({ name: "doudian-addv2", kind: "projection", derivesFrom: bad });
    assert.equal(problems.length, 1, `${bad} should be rejected`);
    assert.match(problems[0], /derivesFrom must be/);
  }
  assert.deepEqual(checkSchemaContract({ name: "doudian-addv2", kind: "projection", derivesFrom: "canonical-product" }), []);
  assert.deepEqual(checkSchemaContract({ name: "doudian-addv2", kind: "projection", derivesFrom: "canonical-product@12" }), []);
});

test("a schema cannot derive from itself, including from another of its versions", () => {
  for (const cite of ["doudian-addv2", "doudian-addv2@1"]) {
    const problems = checkSchemaContract({ name: "doudian-addv2", kind: "projection", derivesFrom: cite });
    assert.equal(problems.length, 1, `${cite} should be rejected`);
    assert.match(problems[0], /cannot derive from itself/);
  }
});

test("all problems are reported at once, not just the first", () => {
  const problems = checkSchemaContract({
    name: "bad-one",
    kind: "canonical",
    entity: "NotKebab",
    upstreamRef: "https://example.test/docs",
    derivesFrom: "some-canonical",
  });
  assert.equal(problems.length, 3);
});

test("a citation splits into name and optional version", () => {
  assert.deepEqual(parseCitation("canonical-product"), { name: "canonical-product" });
  assert.deepEqual(parseCitation("canonical-product@1"), { name: "canonical-product", version: 1 });
  assert.deepEqual(parseCitation("canonical-product@12"), { name: "canonical-product", version: 12 });
});

// ── the rule that needs a lookup, and the second write path ───────────────

const REGISTER_BASE = { jsonSchema: { type: "object" }, kind: "projection", entity: "product" };

test("a lineage citation must resolve to something registered", async () => {
  const svc = serviceOnly([CANONICAL]);
  await assert.rejects(
    () => svc.register({ ...REGISTER_BASE, name: "doudian-addv2", derivesFrom: "typo-product@1" }),
    /not registered/,
  );
});

test("a lineage citation must resolve to a canonical, not another projection", async () => {
  const svc = serviceOnly([CANONICAL, PROJECTION]);
  await assert.rejects(
    () => svc.register({ ...REGISTER_BASE, name: "another-projection", derivesFrom: "doudian-addv2@1" }),
    /must cite a canonical schema/,
  );
});

test("a projection citing a real canonical registers", async () => {
  const svc = serviceOnly([CANONICAL]);
  const created = await svc.register({ ...REGISTER_BASE, name: "another-projection", derivesFrom: "canonical-product@1" });
  assert.equal((created as { derivesFrom?: string }).derivesFrom, "canonical-product@1");
});

// register() is not the only door. update() can set entity, upstreamRef AND
// derivesFrom, so a rule enforced only on registration would be walkable
// around by patching an already-clean row into a dirty one.
test("update() enforces the same rules register() does", async () => {
  const svc = serviceOnly([CANONICAL, PROJECTION]);
  await assert.rejects(
    () => svc.update("c1", { upstreamRef: "https://op.jinritemai.com/docs/api-docs/14/249" }),
    /mirrors no external authority/,
    "patching an upstream onto a canonical must be refused",
  );
  await assert.rejects(() => svc.update("c1", { derivesFrom: "some-canonical" }), /projected from nothing/);
  await assert.rejects(() => svc.update("p1", { derivesFrom: null }), /must cite the canonical/);
  await assert.rejects(() => svc.update("p1", { entity: "Product" }), /kebab-case/);
});

test("a schema still cited by derivesFrom cannot be deleted", async () => {
  const svc = serviceOnly([CANONICAL, PROJECTION]);
  await assert.rejects(() => svc.remove("c1"), /still cited by derivesFrom of: doudian-addv2@1/);
});

test("the bare-name spelling of a citation counts as a dependency too", async () => {
  // PROJECTION cites "canonical-product@1"; this one cites the short form.
  // A dependent using the short form is no less dependent.
  const shortForm = { ...PROJECTION, id: "p2", name: "other-projection", derivesFrom: "canonical-product" };
  const svc = serviceOnly([CANONICAL, shortForm]);
  await assert.rejects(() => svc.remove("c1"), /still cited by derivesFrom/);
});

test("an uncited schema deletes", async () => {
  const svc = serviceOnly([CANONICAL, PROJECTION]);
  assert.deepEqual(await svc.remove("p1"), { ok: true, name: "doudian-addv2", version: 1 });
});

// ── the other kind of dependent: SchemaRecord.schemaName ─────────────────

/** The registry row and the record pinned to it that exist in
 *  resource/db/console.db today (read on 2026-08-28 with node:sqlite in
 *  readOnly mode): one `doudian-category-tree@1` schema, one SchemaRecord
 *  carrying `schemaName="doudian-category-tree", schemaVersion=1`. */
const ENTITY = { id: "e1", name: "doudian-category-tree", version: 1, kind: "entity", entity: null, upstreamRef: null, derivesFrom: null };
const PINNED_RECORD = { id: "rec1", schemaName: "doudian-category-tree", schemaVersion: 1, deletedAt: null };

test("a schema a SchemaRecord still interprets cannot be deleted", async () => {
  // Nothing derives from this one, so the derivesFrom guard waves it through.
  // Deleting it anyway leaves the record visible in the browse list but
  // permanently uneditable: update() re-resolves name+version through
  // resolveSchema, which filters `deletedAt: null`, and 404s naming a schema
  // that is no longer anywhere in the UI.
  const { svc, rows } = serviceOver([ENTITY], [PINNED_RECORD]);
  await assert.rejects(() => svc.remove("e1"), /schema record\(s\) still interpret their payload with it/);
  await assert.rejects(() => svc.remove("e1"), /rec1/);
  assert.equal(rows[0].deletedAt, undefined, "the schema must not be stamped when the guard fires");
});

test("the record guard counts only live records pinned to THIS name and version", async () => {
  // Three near-misses that must NOT block: a soft-deleted record (not a live
  // claim, same reasoning as the derivesFrom query), a different version of the
  // same name, and a different name entirely.
  const { svc } = serviceOver([ENTITY], [
    { ...PINNED_RECORD, id: "gone", deletedAt: new Date("2026-08-01") },
    { ...PINNED_RECORD, id: "otherVersion", schemaVersion: 2 },
    { ...PINNED_RECORD, id: "otherName", schemaName: "shop-profile" },
  ]);
  assert.deepEqual(await svc.remove("e1"), { ok: true, name: "doudian-category-tree", version: 1 });
});

test("the record guard reports the true total while abridging the id list", async () => {
  // Seven dependents: the count must say 7 and the list must say so too, rather
  // than silently understating the blast radius as "5".
  const many = Array.from({ length: 7 }, (_, i) => ({ ...PINNED_RECORD, id: `rec${i}` }));
  const { svc } = serviceOver([ENTITY], many);
  await assert.rejects(() => svc.remove("e1"), /— 7 schema record\(s\)/);
  await assert.rejects(() => svc.remove("e1"), /\+2 more/);
});

test("update() judges the row a patch PRODUCES, not the patch alone", async () => {
  const svc = serviceOnly([CANONICAL, PROJECTION]);
  // Touching an unrelated field on a clean row stays legal — the merge must
  // carry the untouched fields through rather than reading them as cleared.
  const patched = await svc.update("p1", { description: "抖店发布商品接口的业务参数" });
  assert.deepEqual(patched, { description: "抖店发布商品接口的业务参数" });
});

// ── soft delete: `active` and `deletedAt` answer different questions ──────

test("remove() stamps deletedAt instead of dropping the row", async () => {
  const { svc, rows, hardDeleted } = serviceOver([CANONICAL, PROJECTION]);
  await svc.remove("p1");
  const row = rows.find((r) => r.id === "p1");
  assert.ok(row, "the row must survive — historic records still cite it by name@version");
  assert.ok(row.deletedAt instanceof Date, "deletedAt must be stamped");
  assert.deepEqual(hardDeleted, [], "no DELETE may reach the database");
});

test("purge() is the one path that really deletes", async () => {
  const { svc, rows, hardDeleted } = serviceOver([CANONICAL, PROJECTION]);
  await svc.purge("p1");
  assert.deepEqual(hardDeleted, ["p1"]);
  assert.equal(rows.find((r) => r.id === "p1"), undefined);
});

test("purge() can reclaim an already soft-deleted row", async () => {
  // The common case: remove() first, purge() later. If purge went through the
  // visible-rows lookup it would refuse precisely the rows it exists for.
  const { svc, rows, hardDeleted } = serviceOver([CANONICAL, { ...PROJECTION, deletedAt: new Date() }]);
  await svc.purge("p1");
  assert.deepEqual(hardDeleted, ["p1"]);
  assert.equal(rows.find((r) => r.id === "p1"), undefined);
});

test("a soft-deleted schema stops resolving, by name and by pinned version", async () => {
  const { svc } = serviceOver([CANONICAL, { ...PROJECTION, deletedAt: new Date() }]);
  await assert.rejects(() => svc.resolve("doudian-addv2"), /no active schema/);
  // The pinned spelling is the one that matters: it is how historic records are
  // interpreted, so a deleted version must not answer there either.
  await assert.rejects(() => svc.resolve("doudian-addv2", 1), /not found/);
  await assert.rejects(() => svc.findById("p1"), /not found/);
});

test("a retired version still resolves when pinned — retirement is not deletion", async () => {
  // The distinction the Schema model insists on: active:false keeps meaning,
  // deletedAt removes it. Collapsing the two would make every record written
  // against v1 unreadable the moment v2 lands.
  const retired = { ...PROJECTION, active: false };
  const { svc } = serviceOver([CANONICAL, retired]);
  assert.equal((await svc.resolve("doudian-addv2", 1)).id, "p1");
  await assert.rejects(() => svc.resolve("doudian-addv2"), /no active schema/);
});

test("a soft-deleted dependent no longer blocks its parent's deletion", async () => {
  // Otherwise one mistaken registration would pin another in place forever:
  // the projection is already withdrawn, so its lineage claim is not live.
  const { svc, rows } = serviceOver([CANONICAL, { ...PROJECTION, deletedAt: new Date() }]);
  assert.deepEqual(await svc.remove("c1"), { ok: true, name: "canonical-product", version: 1 });
  assert.ok((rows.find((r) => r.id === "c1")!.deletedAt as Date) instanceof Date);
});

test("list() keeps includeInactive and includeDeleted as separate switches", async () => {
  // `active` is spelled out here because the column has a DB default the seed
  // constants do not carry; the point of this test is the interaction between
  // the two flags, so neither may be left implicit.
  const seed = [
    { ...CANONICAL, active: true },
    { ...PROJECTION, id: "p-retired", active: false },
    { ...PROJECTION, id: "p-deleted", active: true, deletedAt: new Date() },
  ];
  const ids = async (filter: Parameters<SchemasService["list"]>[0]) =>
    (await serviceOver(seed).svc.list(filter)).map((r: { id: string }) => r.id).sort();

  assert.deepEqual(await ids({}), ["c1"], "default hides both");
  assert.deepEqual(await ids({ includeInactive: true }), ["c1", "p-retired"], "inactive only");
  assert.deepEqual(await ids({ includeDeleted: true }), ["c1", "p-deleted"], "deleted only");
  assert.deepEqual(
    await ids({ includeInactive: true, includeDeleted: true }),
    ["c1", "p-deleted", "p-retired"],
    "asking for one must never hand back the other",
  );
});

// ── update() writes an allowlist, not the request body ──────────────────────
// `UpdateSchemaInput` is a TypeScript interface and main.ts installs no global
// ValidationPipe, so every key a client PATCHes arrives intact. Until
// 2026-08-28 `update()` handed that object straight to Prisma, which made all
// sixteen Schema columns writable — including the ones this file's own
// guards and doc comments declare unwritable.

test("update() ignores every field outside the five it may set", async () => {
  const { svc, rows } = serviceOver([CANONICAL, PROJECTION]);
  const written = await svc.update("p1", {
    // The five that are allowed.
    description: "抖店发布商品接口的业务参数",
    // Everything else a client could send. `as never` because the interface
    // rightly forbids these — the point is that the interface is not a runtime
    // guard, so the service must be.
    jsonSchema: '{"type":"object"}',
    contentHash: "0".repeat(64),
    name: "hijacked",
    version: 99,
    kind: "canonical",
    id: "somewhere-else",
    deletedAt: null,
    createdAt: new Date(0),
    source: "forged",
    title: "forged",
  } as never);

  assert.deepEqual(written, { description: "抖店发布商品接口的业务参数" }, "only the allowlisted field may be written");
  const row = rows.find((r) => r.id === "p1");
  assert.equal(row?.name, "doudian-addv2", "name is part of the identity anything citing it resolves through");
  assert.equal(row?.version, 1);
  assert.equal(row?.kind, "projection");
  assert.equal(row?.id, "p1");
  assert.ok(!("jsonSchema" in (row ?? {})), "a cited document is immutable — register() refuses to redefine it");
  assert.ok(!("contentHash" in (row ?? {})), "and its hash must never drift from it");
});

test("update() still writes all five allowlisted fields, null included", async () => {
  // The counterpart: "ignores everything else" must not be satisfiable by an
  // update that writes nothing at all.
  const { svc, rows } = serviceOver([CANONICAL, PROJECTION]);
  const written = await svc.update("p1", {
    description: "d",
    entity: null,
    active: false,
    upstreamRef: "https://op.jinritemai.com/docs/api-docs/14/249",
    derivesFrom: "canonical-product@1",
  });
  assert.deepEqual(written, {
    description: "d",
    entity: null,
    active: false,
    upstreamRef: "https://op.jinritemai.com/docs/api-docs/14/249",
    derivesFrom: "canonical-product@1",
  });
  const row = rows.find((r) => r.id === "p1");
  assert.equal(row?.entity, null, "null is an explicit clear, not 'leave alone'");
  assert.equal(row?.active, false);
});

test("update() cannot resurrect a soft-deleted row by patching deletedAt", async () => {
  // remove() refuses to delete a schema anything still cites. A PATCH carrying
  // `deletedAt: null` would have walked straight around that guard.
  const { svc, rows } = serviceOver([CANONICAL, PROJECTION]);
  await svc.remove("p1");
  const before = rows.find((r) => r.id === "p1")?.deletedAt;
  assert.ok(before instanceof Date, "precondition: the row is soft-deleted");
  await assert.rejects(
    () => svc.update("p1", { deletedAt: null } as never),
    /not found/,
    "a deleted row is not patchable at all",
  );
  assert.equal(rows.find((r) => r.id === "p1")?.deletedAt, before, "and it stays deleted");
});

test("remove() runs both dependent scans and the write in one transaction", async () => {
  // Two loose scans then a write leaves a window where a projection citing this
  // schema, or a SchemaRecord pinned to it, is created after the guards said
  // there were none — and the delete lands anyway, producing exactly the
  // dangling reference both guards exist to prevent.
  const { svc, tx } = serviceOver([CANONICAL, PROJECTION]);
  const before = tx.opened;
  await svc.remove("p1");
  assert.equal(tx.opened, before + 1);
});

test("remove() still refuses a cited schema from inside that transaction", async () => {
  // The counterpart: opening a transaction must not be confused with keeping
  // the guards that live inside it.
  const { svc, rows } = serviceOver([CANONICAL, PROJECTION]);
  await assert.rejects(() => svc.remove("c1"), /still cited by derivesFrom/);
  assert.equal(rows.find((r) => r.id === "c1")?.deletedAt ?? null, null, "the row must stay live");
});
