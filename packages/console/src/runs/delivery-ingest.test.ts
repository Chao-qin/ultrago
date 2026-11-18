import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RecordsService } from "../records/records.service.js";
import { DeliveryIngestService } from "./delivery-ingest.service.js";
import { OutputLandingService } from "./output-landing.service.js";

const MONOREPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

class FakePrisma {
  /** Seeded live. Tests that care about the tombstone set `deletedAt` on it. */
  readonly bookRows: any[] = [{
    id: "book_1", name: "book", paramSchema: "[]", paramSchemaRef: "book-input-book@1",
    stepsCount: 2, deliveriesJson: "[]", outputSchemaRef: null, deletedAt: null,
  }];
  /** Both spellings EVALUATE the where clause instead of returning the seed
   *  unconditionally. That is what makes the soft-delete test falsifiable: a
   *  lookup that omits `deletedAt: null` genuinely finds the tombstoned row and
   *  the ingest genuinely proceeds, rather than being rescued by a fake that
   *  matches any filter. */
  readonly book = {
    findUnique: async ({ where }: any) => this.matchBook(where),
    findFirst: async ({ where }: any) => this.matchBook(where),
  };
  private matchBook(where: Record<string, unknown>) {
    return this.bookRows.find((row) => Object.entries(where).every(([k, v]) => row[k] === v)) ?? null;
  }
  readonly runsState = new Map<string, any>();
  readonly deliveriesState = new Map<string, any>();
  readonly recordsState: any[] = [];
  readonly schemaRecord = {
    findFirst: async ({ where }: any) => this.recordsState.find((r) => r.source === where.source && r.deletedAt === null) ?? null,
    create: async ({ data }: any) => {
      const row = { id: `sr_${this.recordsState.length}`, deletedAt: null, ...data };
      this.recordsState.push(row);
      return row;
    },
    update: async ({ where, data }: any) => Object.assign(this.recordsState.find((r) => r.id === where.id), data),
  };
  readonly run = {
    findUnique: async ({ where }: any) => this.runsState.get(where.id) ?? null,
    create: async ({ data }: any) => { const value = { ...data }; this.runsState.set(value.id, value); return value; },
    update: async ({ where, data }: any) => { const value = { ...this.runsState.get(where.id), ...data }; this.runsState.set(where.id, value); return value; },
  };
  readonly deliveryRun = {
    findUnique: async ({ where }: any) => this.deliveriesState.get(`${where.runId_deliveryIndex.runId}:${where.runId_deliveryIndex.deliveryIndex}`) ?? null,
    create: async ({ data }: any) => { const value = { id: `dr_${this.deliveriesState.size}`, ...data }; this.deliveriesState.set(`${data.runId}:${data.deliveryIndex}`, value); return value; },
    update: async ({ where, data }: any) => { const value = [...this.deliveriesState.values()].find((x) => x.id === where.id); Object.assign(value, data); return value; },
    upsert: async ({ where, create, update }: any) => {
      const key = `${where.runId_deliveryIndex.runId}:${where.runId_deliveryIndex.deliveryIndex}`;
      const old = this.deliveriesState.get(key);
      if (old) Object.assign(old, update);
      else this.deliveriesState.set(key, { id: `dr_${this.deliveriesState.size}`, ...create });
    },
  };
  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> { return fn(this); }
}

test("ingest is idempotent and canonicalizes legacy delivery payloads", async () => {
  const prisma = new FakePrisma();
  const service = new DeliveryIngestService(prisma as never, new OutputLandingService(prisma as never, new RecordsService()));
  const input = {
    runId: "mcp_plan_1",
    planId: "plan_1",
    bookName: "book",
    trigger: "mcp",
    status: "success",
    params: { limit: 2 },
    outputs: { ok: true },
    deliveries: [{ kind: "file", path: "report.md" }, { kind: "print" }],
    // Deliberately a path with no file behind it: an artifact whose bytes
    // cannot be read must land NO row, so the file delivery reports "not owned"
    // rather than a row pointing at nothing.
    artifacts: [{ path: "reports/report.md" }],
  };
  await service.ingest(input);
  await service.ingest(input);
  assert.equal(prisma.runsState.size, 1);
  assert.equal(prisma.deliveriesState.size, 2);
  assert.equal(prisma.deliveriesState.get("mcp_plan_1:0").kind, "file");
  // The payload is NOT copied onto the delivery row — it is read back from the
  // run's immutable snapshot by index, canonicalized (legacy `path` → `artifact`)
  // exactly once on the way in.
  assert.equal(prisma.deliveriesState.get("mcp_plan_1:0").payloadJson, undefined);
  assert.deepEqual(
    JSON.parse(prisma.runsState.get("mcp_plan_1").deliverySnapshotJson)[0],
    { kind: "file", artifact: "report.md", on: "success" },
  );
  // The params contract is recorded as the registry pin, never as a copy of the
  // book's filesync-owned inline schema.
  assert.equal(prisma.runsState.get("mcp_plan_1").paramSchemaRef, "book-input-book@1");
  assert.equal(prisma.runsState.get("mcp_plan_1").paramsTypeJson, undefined);
  // The durable ingest is one of the two terminal points that must land the
  // product, inside the same transaction and under the same condition, so
  // re-ingesting cannot produce a second row.
  assert.equal(prisma.recordsState.length, 1);
  assert.equal(prisma.recordsState[0].source, "run:mcp_plan_1");
  assert.equal(prisma.recordsState[0].contentType, "application/json");
  assert.equal(prisma.recordsState[0].bytes, Buffer.byteLength('{"ok":true}', "utf8"));
  // No outputSchemaRef on this book, so the bytes are in records/, not `data`.
  assert.equal(prisma.recordsState[0].data, null);
  rmSync(path.join(MONOREPO_ROOT, "resource/records", prisma.recordsState[0].fileName), { force: true });
});

test("ingest refuses a soft-deleted book instead of minting fresh runs under it", async () => {
  const prisma = new FakePrisma();
  // Exactly the state BooksService.delete leaves behind: the book tombstoned,
  // its runs / steps / deliveries / schedules hand-cascaded to `deletedAt` in
  // the same transaction. This endpoint used to look the book up by name only,
  // so it could immediately create a NEW live run — and, on a terminal status,
  // live DeliveryRun rows that fire — under that dead parent.
  prisma.bookRows[0].deletedAt = new Date("2026-08-28T00:00:00Z");
  const service = new DeliveryIngestService(prisma as never, new OutputLandingService(prisma as never, new RecordsService()));
  await assert.rejects(
    () => service.ingest({
      runId: "mcp_after_delete",
      planId: "plan_after_delete",
      bookName: "book",
      status: "success",
      deliveries: [{ kind: "print" }],
    }),
    /book book not found in console index/,
  );
  // The rejection is the visible half; these two are the half that matters.
  assert.equal(prisma.runsState.size, 0, "no run row may be created for a deleted book");
  assert.equal(prisma.deliveriesState.size, 0, "no delivery may be queued for a deleted book");
});

test("a run with no outputs lands no record at all", async () => {
  const prisma = new FakePrisma();
  const service = new DeliveryIngestService(prisma as never, new OutputLandingService(prisma as never, new RecordsService()));
  await service.ingest({ runId: "mcp_silent", planId: "plan_silent", bookName: "book", status: "success" });
  assert.equal(prisma.recordsState.length, 0, "`outputs: undefined` means the run produced nothing to land");
});

test("cancelled ingest keeps both cancelled and any delivery rows", async () => {
  const prisma = new FakePrisma();
  const service = new DeliveryIngestService(prisma as never, new OutputLandingService(prisma as never, new RecordsService()));
  await service.ingest({
    runId: "mcp_cancelled",
    planId: "plan_cancelled",
    bookName: "book",
    status: "cancelled",
    deliveries: [{ kind: "print", on: "cancelled" }, { kind: "message", on: "any" }],
  });
  assert.equal(prisma.deliveriesState.size, 2);
  assert.deepEqual([...prisma.deliveriesState.values()].map((x) => x.on), ["cancelled", "any"]);
});

test("paused ingest does not deliver and a later terminal snapshot is immutable", async () => {
  const prisma = new FakePrisma();
  const service = new DeliveryIngestService(prisma as never, new OutputLandingService(prisma as never, new RecordsService()));
  await service.ingest({
    runId: "paused_run",
    planId: "plan_paused",
    bookName: "book",
    status: "needsJudge",
    outputs: { v: 1 },
    deliveries: [{ kind: "message", on: "any", template: "first" }],
  });
  assert.equal(prisma.deliveriesState.size, 0);

  await service.ingest({
    runId: "paused_run",
    planId: "plan_paused",
    bookName: "book",
    status: "success",
    outputs: { v: 2 },
    deliveries: [{ kind: "message", on: "any", template: "terminal" }],
  });
  assert.equal(prisma.deliveriesState.size, 1);
  // The payload lives in the run's snapshot now, and the snapshot is frozen at
  // the first one recorded — the terminal ingest must not rewrite it.
  assert.match(prisma.runsState.get("paused_run").deliverySnapshotJson, /first/);

  await service.ingest({
    runId: "paused_run",
    planId: "plan_paused",
    bookName: "book",
    status: "failed",
    outputs: { v: 3 },
    deliveries: [{ kind: "message", on: "any", template: "late" }],
  });
  assert.equal(prisma.runsState.get("paused_run").status, "success");
  assert.match(prisma.runsState.get("paused_run").deliverySnapshotJson, /first/);
  try {
    // The landed row is gated on the same `!existingTerminal` the frozen
    // snapshot is, so the two cannot describe different payloads: the late
    // `{v:3}` is refused by both.
    assert.equal(prisma.recordsState.length, 1);
    assert.equal(prisma.recordsState[0].bytes, Buffer.byteLength('{"v":2}', "utf8"));
    // Names the CONTENT, not just its size: `{"v":2}` and `{"v":3}` are both
    // seven bytes, so a length check would have let the late snapshot through.
    assert.equal(prisma.recordsState[0].fileName, `${contentHash('{"v":2}')}-run-paused_run.json`);
  } finally {
    forgetStoredRecords("paused_run");
  }
});

/** The prefix RecordsService derives from a stored body. */
function contentHash(body: string): string {
  return createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex").slice(0, 16);
}

/** Remove every records/ file this suite's landings wrote for one run. The
 *  stored name is `<content hash>-run-<runId>.json`, so a run that landed twice
 *  left two files and only the last is still named by a row. */
function forgetStoredRecords(runId: string): void {
  const dir = path.join(MONOREPO_ROOT, "resource/records");
  for (const name of readdirSync(dir)) {
    if (name.endsWith(`-run-${runId}.json`)) rmSync(path.join(dir, name), { force: true });
  }
}
