import assert from "node:assert/strict";
import test from "node:test";

import type { SchemaRecordRow } from "./types";
import {
  filterSchemaRecordRows,
  parseRecordData,
  recordOptionLabel,
  recordVerdict,
} from "./schema-record-options";

/** 行工厂：只填本组测试关心的轴，其余给合法的载荷支默认值。 */
function row(overrides: Partial<SchemaRecordRow> = {}): SchemaRecordRow {
  return {
    id: "cmtooy98k0003s8b6fd12leus",
    contentType: "application/json",
    schemaName: "shop-profile",
    schemaVersion: 2,
    data: "{}",
    schemaErrors: "[]",
    fileName: null,
    url: null,
    bytes: 2,
    source: null,
    deletedAt: null,
    createdAt: "2026-09-05T18:03:15.140Z",
    updatedAt: "2026-09-05T18:03:15.140Z",
    ...overrides,
  };
}

test("filter drops file-branch rows (data === null), not rows merely lacking a schema name", () => {
  const rows = [
    row(),
    row({ id: "file-branch", data: null, url: "/api/records/x.json", fileName: "x.json" }),
    row({ id: "no-contract-name", schemaName: null }),
  ];
  const out = filterSchemaRecordRows(rows, { name: "shop-profile", version: 2 });
  assert.deepEqual(
    out.map((r) => r.id),
    ["cmtooy98k0003s8b6fd12leus", "no-contract-name"],
    "判支看 data（CHECK 约束的那条轴），schemaName 是另一条独立的轴",
  );
});

test("filter honours the citation version, and a versionless citation keeps every version", () => {
  const rows = [row({ schemaVersion: 1 }), row(), row({ schemaVersion: 3 })];
  assert.deepEqual(
    filterSchemaRecordRows(rows, { name: "shop-profile", version: 2 }).map((r) => r.schemaVersion),
    [2],
  );
  assert.equal(filterSchemaRecordRows(rows, { name: "shop-profile" }).length, 3);
});

test("filter does not guess the active version — data registered under an old version stays selectable", () => {
  // schema 升到 @3 后，@2 的存档仍是 @2 登记的数据；由 citation 决定筛哪版，
  // 不在这里做「当前 active」的二次猜测。
  const rows = [row({ schemaVersion: 2 })];
  assert.equal(filterSchemaRecordRows(rows, { name: "shop-profile", version: 2 }).length, 1);
});

test("recordVerdict reads the stored schemaErrors tri-state", () => {
  assert.equal(recordVerdict(row({ schemaErrors: null })), "unchecked");
  assert.equal(recordVerdict(row({ schemaErrors: "[]" })), "ok");
  assert.equal(recordVerdict(row({ schemaErrors: '["/ title must be string"]' })), "violated");
  assert.equal(recordVerdict(row({ schemaErrors: "not json" })), "violated", "解析不了的一律按违约显示，宁错报不漏报");
});

test("recordOptionLabel marks violations and only spells the version when the citation has none", () => {
  const cited = recordOptionLabel(row(), { name: "shop-profile", version: 2 });
  assert.match(cited, /^#cmtooy98 · 2026-09-05 18:03 · 2B$/);
  assert.doesNotMatch(cited, /v2/);

  const versionless = recordOptionLabel(row(), { name: "shop-profile" });
  assert.match(versionless, /v2/);

  const violated = recordOptionLabel(
    row({ schemaErrors: '["/ x"]' }),
    { name: "shop-profile", version: 2 },
  );
  assert.match(violated, /⚠ 存档违约$/);
});

test("parseRecordData parses JSON payloads and degrades to the raw string otherwise", () => {
  assert.deepEqual(parseRecordData(row({ data: '{"a":1}' })), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseRecordData(row({ data: "  " })), { ok: true, value: "" });
  const broken = parseRecordData(row({ data: "{oops" }));
  assert.equal(broken.ok, false);
  const file = parseRecordData(row({ data: null }));
  assert.equal(file.ok, false);
});

test("a violated record still parses — the picker warns, submit-time validation decides", () => {
  const r = row({ schemaErrors: '["/ x"]', data: '{"freightTemplateId":1}' });
  assert.deepEqual(parseRecordData(r), { ok: true, value: { freightTemplateId: 1 } });
});
