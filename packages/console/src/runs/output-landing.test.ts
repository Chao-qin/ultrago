import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runArtifactSource, runProductSource } from "@bcp/shared";
import { RecordsService } from "../records/records.service.js";
import { describeOutputs } from "./output-type.js";
import { OutputLandingService } from "./output-landing.service.js";

const MONOREPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

interface Row {
  id: string;
  contentType: string;
  schemaName: string | null;
  schemaVersion: number | null;
  schemaErrors: string | null;
  data: string | null;
  fileName: string | null;
  url: string | null;
  bytes: number;
  source: string | null;
  deletedAt: Date | null;
}

/** Apply a `where` the way the real delegate would, so a filter the service
 *  stops sending stops being applied here too.
 *
 *  Hard-coding the predicates instead — `r.deletedAt === null` written into
 *  each query — is what this replaces: it made every `deletedAt: null` in
 *  OutputLandingService unfalsifiable, since the double filtered soft-deleted
 *  rows out whether or not the service asked. Modelled on the `matches()` in
 *  books.service.test.ts, including its rule that an unrecognised filter THROWS
 *  rather than quietly matching. */
function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  const entries = Object.entries(where);
  // An empty `where` is not "matches everything" — it is "the filter was
  // dropped", and `[].every()` would report that as a clean hit.
  if (entries.length === 0) throw new Error("test double: query with no filter — the where clause was dropped");
  return entries.every(([key, cond]) => {
    const actual = (row as unknown as Record<string, unknown>)[key];
    // `deletedAt: null` must treat "absent" and "explicitly null" alike.
    if (cond === null) return actual === null || actual === undefined;
    if (isStartsWith(cond)) return typeof actual === "string" && actual.startsWith(cond.startsWith);
    if (typeof cond === "object") throw new Error(`test double: unsupported filter ${key}=${JSON.stringify(cond)}`);
    return actual === cond;
  });
}

function isStartsWith(cond: unknown): cond is { startsWith: string } {
  return !!cond && typeof cond === "object" && typeof (cond as { startsWith?: unknown }).startsWith === "string";
}

/** Enough of the delegate to exercise the real read-then-write. Queries go
 *  through `matches()` above, so the service's own `where` decides what it
 *  sees. `create` additionally models the partial unique index the DB enforces
 *  — a second row for a live source is refused here exactly as SQLite would
 *  refuse it; that predicate is the INDEX definition (`WHERE source IS NOT NULL
 *  AND deletedAt IS NULL`), not a query filter, so it is stated here rather
 *  than read off a caller. */
class FakeSchemaRecords {
  readonly rows: Row[] = [];
  readonly nodes: Array<{ status?: string; id: string; runId: string; flowRunId: string; nodeId: string; iteration: number | null; outputJson: string | null; deletedAt: Date | null }> = [];
  readonly flowNodeRun = {
    findUnique: async ({ where }: any) => this.nodes.find((node) => node.id === where.id) ?? null,
    findFirst: async ({ where }: any) => this.nodes.find((node) => node.runId === where.runId && node.deletedAt === where.deletedAt) ?? null,
    updateMany: async ({ where, data }: any) => {
      const nodes = this.nodes.filter((node) => Object.entries(where).every(([key, value]) => (node as unknown as Record<string, unknown>)[key] === value));
      for (const node of nodes) Object.assign(node, data);
      return { count: nodes.length };
    },
  };
  readonly schemaRecord = {
    findFirst: async ({ where }: any): Promise<Row | null> => this.rows.find((r) => matches(r, where)) ?? null,
    findMany: async ({ where }: any): Promise<Row[]> => this.rows.filter((r) => matches(r, where)),
    create: async ({ data }: any): Promise<Row> => {
      if (data.source && this.rows.some((r) => r.source === data.source && r.deletedAt === null)) {
        throw new Error("UNIQUE constraint failed: index 'uniq_active_record_source'");
      }
      const row: Row = { id: `sr_${this.rows.length}`, deletedAt: null, ...data };
      this.rows.push(row);
      return row;
    },
    update: async ({ where, data }: any): Promise<Row> => {
      const row = this.rows.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
  };
}

function landingService(prisma: FakeSchemaRecords): OutputLandingService {
  return new OutputLandingService(prisma as never, new RecordsService());
}

test('flow book outputs use their node checkpoint instead of creating intermediate records', async () => {
  const prisma = new FakeSchemaRecords();
  prisma.nodes.push({ id: 'node', runId: 'book-run', flowRunId: 'flow', nodeId: 'any-book', iteration: null, outputJson: null, deletedAt: null });
  const service = landingService(prisma);
  const schema = JSON.stringify({ type: 'object', properties: { result: { type: 'number' } } });
  const described = describeOutputs({ result: 3 }, schema);
  const run = { id: 'book-run', flowNodeRunId: 'node' };
  await service.landRunOutput(run, described, 'output@1');
  await service.landRunOutput(run, described, 'output@1');
  assert.equal(prisma.rows.length, 0);
  assert.deepEqual(JSON.parse(prisma.nodes[0].outputJson!), { outputs: { result: 3 }, outputSchemaErrors: '[]' });
  assert.deepEqual(await service.readLandedValue(runProductSource(run.id)), { result: 3 });
});

test('flow checkpoints preserve validation failures and cannot attach to another run', async () => {
  const prisma = new FakeSchemaRecords();
  prisma.nodes.push({ id: 'node', runId: 'book-run', flowRunId: 'flow', nodeId: 'any-book', iteration: null, outputJson: null, deletedAt: null });
  const service = landingService(prisma);
  const described = describeOutputs({ result: 'invalid' }, JSON.stringify({ type: 'object', properties: { result: { type: 'number' } } }));
  await service.landRunOutput({ id: 'book-run', flowNodeRunId: 'node' }, described, null);
  assert.equal(JSON.parse(prisma.nodes[0].outputJson!).outputSchemaErrors, described.outputsSchemaErrors);
  await assert.rejects(() => service.landRunOutput({ id: 'other-run', flowNodeRunId: 'node' }, described, null), /node/i);
  assert.equal(prisma.rows.length, 0);
});

function cleanup(prisma: FakeSchemaRecords): void {
  for (const row of prisma.rows) {
    if (row.fileName) rmSync(path.join(MONOREPO_ROOT, "resource/records", row.fileName), { force: true });
  }
}

test("the branch is the schema, not the media type: unresolvable schemaName lands a JSON payload in a file", async () => {
  const prisma = new FakeSchemaRecords();
  const service = landingService(prisma);
  // application/json, and a JSON document at that — the ONLY thing sending it
  // to the file branch is that no schema resolves. A rule keyed on contentType
  // (or on "is it JSON") would put this in `data`, which is how a 28MB
  // no-contract payload ends up in a TEXT column.
  const described = describeOutputs({ categories: [{ id: 1 }] }, null);
  assert.equal(described.outputsContentType, "application/json", "precondition: the payload IS json");

  await service.land(runProductSource("run_no_contract"), described, null);
  try {
    assert.equal(prisma.rows.length, 1);
    const [row] = prisma.rows;
    assert.equal(row.contentType, "application/json", "the media type is still recorded on the file branch");
    assert.equal(row.data, null, "a payload with no contract must not occupy the data column");
    assert.equal(row.schemaName, null);
    assert.equal(row.schemaVersion, null);
    assert.ok(row.fileName, "the bytes went to resource/records/");
    assert.equal(row.url, `/api/records/${row.fileName}`);
    assert.equal(row.source, "run:run_no_contract");
    // The DB CHECK is `(data IS NULL) <> (url IS NULL)` — exactly one branch.
    assert.notEqual(row.data === null, row.url === null);
  } finally {
    cleanup(prisma);
  }
});

test("a pinned outputSchemaRef puts the payload in the data column instead", async () => {
  const prisma = new FakeSchemaRecords();
  const service = landingService(prisma);
  await service.land(runProductSource("run_with_contract"), describeOutputs({ ok: true }, null), "product@2");
  try {
    const [row] = prisma.rows;
    assert.equal(row.schemaName, "product");
    assert.equal(row.schemaVersion, 2);
    assert.equal(row.data, '{"ok":true}');
    assert.equal(row.fileName, null);
    assert.equal(row.url, null);
  } finally {
    cleanup(prisma);
  }
});

test("an unpinned or malformed ref is not a contract, so its payload still lands in a file", async () => {
  const prisma = new FakeSchemaRecords();
  const service = landingService(prisma);
  // The registry keeps `name+version` immutable and that pin is what lets a
  // historical run's contract still be read. A bare name pins nothing.
  for (const [i, ref] of ["product", "product@", "product@abc", "@2", ""].entries()) {
    await service.land(runProductSource(`run_bad_ref_${i}`), describeOutputs({ ok: true }, null), ref);
  }
  try {
    assert.equal(prisma.rows.length, 5);
    for (const row of prisma.rows) {
      assert.equal(row.schemaName, null, "an unpinned ref must not be recorded as a resolved contract");
      assert.equal(row.data, null);
    }
  } finally {
    cleanup(prisma);
  }
});

test("bytes is the UTF-8 length, not the UTF-16 code-unit count", async () => {
  const prisma = new FakeSchemaRecords();
  const service = landingService(prisma);
  const described = describeOutputs({ 标题: "商品分类报告" }, null);
  await service.land(runProductSource("run_cjk"), described, null);
  try {
    const [row] = prisma.rows;
    const expected = Buffer.byteLength(described.outputsData, "utf8");
    assert.equal(row.bytes, expected);
    assert.notEqual(expected, described.outputsData.length, "the fixture must actually distinguish the two");
  } finally {
    cleanup(prisma);
  }
});

test("contract violations are recorded on the file branch too", async () => {
  const prisma = new FakeSchemaRecords();
  const service = landingService(prisma);
  // A book may declare an inline `outputSchema` while `outputSchemaRef` is
  // still null — four of the six live books are in exactly that state, so their
  // checked runs all land on the file branch. Dropping schemaErrors here would
  // disarm the flow runner's fatal-violation rule for all of them while every
  // other assertion still passed.
  const described = describeOutputs({ reply: 7 }, JSON.stringify({ type: "object", properties: { reply: { type: "string" } } }));
  assert.notEqual(described.outputsSchemaErrors, "[]", "precondition: this payload violates the contract");

  await service.land(runProductSource("run_violating"), described, null);
  try {
    const [row] = prisma.rows;
    assert.equal(row.data, null, "precondition: it really is on the file branch");
    assert.equal(row.schemaErrors, described.outputsSchemaErrors);
  } finally {
    cleanup(prisma);
  }
});

test("a conforming run records the pass, distinct from 'nobody checked'", async () => {
  const prisma = new FakeSchemaRecords();
  const service = landingService(prisma);
  const schema = JSON.stringify({ type: "object", properties: { reply: { type: "string" } } });
  await service.land(runProductSource("run_ok"), describeOutputs({ reply: "hi" }, schema), null);
  await service.land(runProductSource("run_unchecked"), describeOutputs({ reply: "hi" }, null), null);
  try {
    assert.equal(prisma.rows.find((r) => r.source === "run:run_ok")!.schemaErrors, "[]");
    assert.equal(prisma.rows.find((r) => r.source === "run:run_unchecked")!.schemaErrors, null);
  } finally {
    cleanup(prisma);
  }
});

test("landing the same run twice keeps one row and the latest payload", async () => {
  const prisma = new FakeSchemaRecords();
  const service = landingService(prisma);
  await service.land(runProductSource("run_repeat"), describeOutputs({ n: 1 }, null), "product@1");
  await service.land(runProductSource("run_repeat"), describeOutputs({ n: 2 }, null), "product@1");
  try {
    assert.equal(prisma.rows.length, 1, "a re-ingested run must not grow a second row");
    assert.equal(prisma.rows[0].data, '{"n":2}');
  } finally {
    cleanup(prisma);
  }
});

test("losing the create race falls back to updating the winner's row", async () => {
  const prisma = new FakeSchemaRecords();
  const service = landingService(prisma);
  // A tombstone for the SAME source, sitting ahead of the winner in the table.
  // It is what makes the recovery re-read's own `deletedAt: null` falsifiable:
  // without that filter the re-read finds this row first and writes the
  // recovered payload into a deleted row, leaving the live winner stale.
  prisma.rows.push({
    id: "sr_deleted", contentType: "application/json", schemaName: "product", schemaVersion: 1,
    schemaErrors: null, data: '{"n":-1}', fileName: null, url: null, bytes: 8,
    source: "run:run_race", deletedAt: new Date(),
  });
  // The dispatcher's terminal poll and a durable ingest can both reach here for
  // the same run. Simulate the loser: findFirst saw nothing, then someone else
  // committed first. Without the retry this surfaces as a raw UNIQUE error.
  const realFindFirst = prisma.schemaRecord.findFirst;
  let firstCall = true;
  prisma.schemaRecord.findFirst = async (args: any) => {
    if (firstCall) {
      firstCall = false;
      // The winner commits between our read and our write, for the very source
      // we are about to claim.
      await realFindFirst(args);
      prisma.rows.push({
        id: "sr_winner", contentType: "application/json", schemaName: "product", schemaVersion: 1,
        schemaErrors: null, data: '{"n":0}', fileName: null, url: null, bytes: 7,
        source: "run:run_race", deletedAt: null,
      });
      return null;
    }
    return realFindFirst(args);
  };
  await service.land(runProductSource("run_race"), describeOutputs({ n: 9 }, null), "product@1");
  const live = prisma.rows.filter((r) => r.source === "run:run_race" && r.deletedAt === null);
  assert.equal(live.length, 1, "the loser must not insert a second live row");
  assert.equal(live[0].id, "sr_winner");
  assert.equal(live[0].data, '{"n":9}', "the loser updates the winner's row instead of throwing");
  assert.equal(prisma.rows.find((r) => r.id === "sr_deleted")!.data, '{"n":-1}', "the recovery re-read must not write through to the tombstone");
});

test("a run that produced nothing lands an empty row rather than a zero-byte file", async () => {
  const prisma = new FakeSchemaRecords();
  const service = landingService(prisma);
  // RecordsService refuses an empty body by design, and a zero-byte file would
  // be a worse record of "produced nothing" than an empty column. Skipping the
  // row entirely is worse still: the contract check below would vanish with it.
  const described = describeOutputs(null, JSON.stringify({ type: "object", required: ["reply"] }));
  await service.land(runProductSource("run_empty"), described, null);
  const [row] = prisma.rows;
  assert.equal(row.bytes, 0);
  assert.equal(row.data, "");
  assert.equal(row.fileName, null);
  assert.equal(row.schemaErrors, described.outputsSchemaErrors);
});


/** A real file under reports/, because landArtifact reads bytes off disk — the
 *  whole point of the move is that it stats the file instead of trusting the
 *  `size: 0` the backend reports. */
function writeReport(rel: string, body: string): void {
  const abs = path.join(MONOREPO_ROOT, "reports", rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

test("a run's artifacts land as their own rows, keyed so the file delivery can check ownership", async () => {
  const prisma = new FakeSchemaRecords();
  const service = landingService(prisma);
  const body = '{"hits":["中文"]}';
  writeReport("landing-test-owned.json", body);
  try {
    await service.landArtifact("run_owner", "landing-test-owned.json");

    assert.equal(prisma.rows.length, 1);
    const [row] = prisma.rows;
    assert.equal(row.source, runArtifactSource("run_owner", "landing-test-owned.json"));
    // The ownership check reads the path back out of the source key, so the key
    // has to carry the REPORT path, not the content-hashed storage name.
    assert.deepEqual(await service.listRunArtifactPaths("run_owner"), ["landing-test-owned.json"]);
    // Statted, not taken from the snapshot: `extractArtifacts` hard-codes 0, and
    // every one of the 6 migrated `Artifact` rows recorded 0 for a real file.
    assert.equal(row.bytes, Buffer.byteLength(body, "utf8"));
    assert.notEqual(row.bytes, 0);
    // Content sniff beats the extension, and the file is downloadable — the two
    // things the deleted `Artifact` table could not do.
    assert.equal(row.contentType, "application/json");
    assert.equal(row.url, `/api/records/${row.fileName}`);
    assert.equal(row.data, null);
  } finally {
    cleanup(prisma);
    rmSync(path.join(MONOREPO_ROOT, "reports", "landing-test-owned.json"), { force: true });
  }
});

test("an artifact whose bytes are gone lands NO row, so the delivery reports it unowned", async () => {
  const prisma = new FakeSchemaRecords();
  const service = landingService(prisma);
  // Fail-closed: a row here would claim the run owns a file that isn't there,
  // and `verifyFile` would then pass ownership and fail one line later on a
  // confusing `access` error — or, worse, pass entirely if the name were reused.
  await service.landArtifact("run_missing", "landing-test-does-not-exist.json");
  assert.equal(prisma.rows.length, 0);
  assert.deepEqual(await service.listRunArtifactPaths("run_missing"), []);
});

test("a soft-deleted row stays deleted: every read and the upsert skip the tombstone", async () => {
  const prisma = new FakeSchemaRecords();
  const service = landingService(prisma);
  const source = runProductSource("run_tombstoned");
  await service.land(source, describeOutputs({ n: 1 }, null), "product@1");
  writeReport("landing-test-tombstoned.json", '{"gone":true}');
  await service.landArtifact("run_tombstoned", "landing-test-tombstoned.json");
  try {
    // The fixture the rest of this file never had. Every other row here is
    // live, so `deletedAt: null` could be deleted from all three service
    // methods without a single assertion changing — the guard was there but
    // nothing could tell whether it fired.
    for (const row of prisma.rows) row.deletedAt = new Date();

    assert.equal(await service.readLandedValue(source), undefined, "a deleted product must read back as nothing landed");
    assert.deepEqual(await service.listRunArtifactPaths("run_tombstoned"), [], "a deleted artifact must not be claimed as owned by the run");

    // Landing again must insert BESIDE the tombstone. Updating it instead would
    // resurrect a row an operator deleted, and the partial unique index does
    // not stand in the way — it only covers live rows.
    await service.land(source, describeOutputs({ n: 2 }, null), "product@1");
    assert.equal(prisma.rows.length, 3, "the upsert must not write through to the deleted row");
    assert.equal(prisma.rows[0].data, '{"n":1}', "the tombstone keeps the value it was deleted with");
    assert.deepEqual(await service.readLandedValue(source), { n: 2 });
  } finally {
    cleanup(prisma);
    rmSync(path.join(MONOREPO_ROOT, "reports", "landing-test-tombstoned.json"), { force: true });
  }
});

test("a landed product reads back as the VALUE the book produced, not its serialization", async () => {
  const prisma = new FakeSchemaRecords();
  const service = landingService(prisma);
  try {
    // JSON on the file branch: the delivery layer must get the object back, or
    // a webhook body ships a string containing JSON instead of JSON.
    await service.land(runProductSource("run_json"), describeOutputs({ ok: true }, null), null);
    assert.deepEqual(await service.readLandedValue(runProductSource("run_json")), { ok: true });

    // Markdown: the value IS the markdown text. Running it back through
    // JSON.parse would throw, and swallowing that would print nothing.
    const markdown = "# 热搜\n\n| a | b |";
    await service.land(runProductSource("run_md"), describeOutputs(markdown, null), null);
    assert.equal(await service.readLandedValue(runProductSource("run_md")), markdown);

    // The one that gives the contentType guard teeth. `classifyOutput` calls a
    // bare "123" text/plain on purpose (only objects and arrays count as JSON
    // documents), and text must come back as the STRING the book produced. A
    // decoder that just tried JSON.parse and kept whatever came out would hand
    // the number 123 downstream — parseable, plausible, and the wrong type.
    const numericText = "123";
    const describedText = describeOutputs(numericText, null);
    assert.equal(describedText.outputsContentType, "text/plain", "precondition: this is text, not a JSON document");
    await service.land(runProductSource("run_numeric_text"), describedText, null);
    const readBack = await service.readLandedValue(runProductSource("run_numeric_text"));
    assert.equal(readBack, numericText);
    assert.equal(typeof readBack, "string");

    // Nothing landed at all is distinct from a product of null.
    assert.equal(await service.readLandedValue(runProductSource("run_never")), undefined);
    await service.land(runProductSource("run_null"), describeOutputs(null, null), null);
    assert.equal(await service.readLandedValue(runProductSource("run_null")), null);
  } finally {
    cleanup(prisma);
  }
});

test("a contract-bearing product over the inline limit lands as a file that still names its contract", async () => {
  const prisma = new FakeSchemaRecords();
  const service = landingService(prisma);
  // The shape `doudian-category-tree` produces: it carries
  // `outputSchemaRef = "book-output-nonempty-string@1"`, and its landed product
  // measured 1,171,535 bytes in resource/db/console.db. Before the size ceiling
  // this row went to `data` in full.
  const described = describeOutputs(
    { categories: Array.from({ length: 40_000 }, (_, i) => ({ id: i, 名称: "女装" })) },
    null,
  );
  assert.ok(
    Buffer.byteLength(described.outputsData, "utf8") > 256 * 1024,
    "precondition: the fixture really is over the limit",
  );

  await service.land(runProductSource("run_big_contract"), described, "book-output-nonempty-string@1");
  try {
    const [row] = prisma.rows;
    // The contract half: not dropped on the way to disk.
    assert.equal(row.schemaName, "book-output-nonempty-string");
    assert.equal(row.schemaVersion, 1);
    // The storage half: the bytes are NOT in the TEXT column.
    assert.equal(row.data, null, "a megabyte product must not occupy the data column just because it has a contract");
    assert.ok(row.fileName, "the bytes went to resource/records/");
    assert.equal(row.url, `/api/records/${row.fileName}`, "and the row carries a download link for them");
    // The DB CHECK is `(data IS NULL) <> (url IS NULL)`, and it never mentioned
    // schemaName — this combination was always legal, just never produced.
    assert.notEqual(row.data === null, row.url === null);
    // The download link resolves to the real bytes, byte for byte. Without
    // this, "it went to a file" could be true while the file was empty or held
    // something else — which is how the deleted Artifact table recorded every
    // one of its 6 rows as 0 bytes.
    const onDisk = readFileSync(new RecordsService().resolveStored(row.fileName!), "utf8");
    assert.equal(onDisk, described.outputsData);
    assert.equal(row.bytes, Buffer.byteLength(described.outputsData, "utf8"));
  } finally {
    cleanup(prisma);
  }
});

test("a contract-bearing product that fits still takes the data column", async () => {
  const prisma = new FakeSchemaRecords();
  const service = landingService(prisma);
  // The other side of the same rule: the ceiling must not have quietly turned
  // the data branch off for everyone.
  await service.land(runProductSource("run_small_contract"), describeOutputs({ reply: "hi" }, null), "book-output-nonempty-string@1");
  try {
    const [row] = prisma.rows;
    assert.equal(row.schemaName, "book-output-nonempty-string");
    assert.equal(row.data, '{"reply":"hi"}');
    assert.equal(row.fileName, null);
    assert.equal(row.url, null);
  } finally {
    cleanup(prisma);
  }
});

test('late terminal landing preserves the completed output envelope and delivery value', async () => {
  const prisma = new FakeSchemaRecords();
  const outputJson = JSON.stringify({ outputs: { result: 3 }, status: 'success', outputSchemaErrors: '[]' });
  prisma.nodes.push({ id: 'node', status: 'success', runId: 'book-run', flowRunId: 'flow', nodeId: 'any-book', iteration: null, outputJson, deletedAt: null });
  const service = landingService(prisma);
  await service.landRunOutput({ id: 'book-run', flowNodeRunId: 'node' }, describeOutputs({ result: 4 }, null), null);
  assert.equal(prisma.nodes[0].outputJson, outputJson);
  assert.deepEqual(await service.readLandedValue(runProductSource('book-run')), { result: 3 });
});

test('flow output delivery preserves primitive and array values', async () => {
  const prisma = new FakeSchemaRecords();
  prisma.nodes.push({ id: 'node', status: 'running', runId: 'book-run', flowRunId: 'flow', nodeId: 'any-book', iteration: null, outputJson: null, deletedAt: null });
  const service = landingService(prisma);
  for (const value of ['123', '# Report', null, [1, 2]]) {
    await service.landRunOutput({ id: 'book-run', flowNodeRunId: 'node' }, describeOutputs(value, null), null);
    assert.deepEqual(await service.readLandedValue(runProductSource('book-run')), value);
  }
});
