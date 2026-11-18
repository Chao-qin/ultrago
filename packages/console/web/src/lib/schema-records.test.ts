import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPayload, isPreviewBrokenJson } from "./schema-records.js";
import type { SchemaRecordListRow, UpdateSchemaRecordInput } from "./types";

/** A preview row, defaulting to the payload branch. */
function listRow(over: Partial<SchemaRecordListRow> = {}): SchemaRecordListRow {
  return {
    id: "r1",
    contentType: "application/json",
    schemaName: "product",
    schemaVersion: 1,
    dataPreview: { head: '{"a":1}', truncated: false },
    schemaErrors: null,
    fileName: null,
    url: null,
    bytes: 7,
    source: null,
    deletedAt: null,
    createdAt: "2026-08-01",
    updatedAt: "2026-08-01",
    ...over,
  };
}

const FILE_ROW = listRow({
  schemaName: null, schemaVersion: null, dataPreview: null,
  fileName: "abc-report.json", url: "/api/records/abc-report.json", bytes: 28_652_646,
});

/** The row `planOutputRecord` writes for a run that produced nothing:
 *  `inline` is true (`payload === ""`) while `schemaName` stays null. */
const EMPTY_PAYLOAD_ROW = listRow({
  schemaName: null, schemaVersion: null,
  dataPreview: { head: "", truncated: false }, bytes: 0,
});

// ── the type-level guards ─────────────────────────────────────────────────
//
// These two `@ts-expect-error`s ARE the assertions: each marks a misuse that
// must not compile. If a future edit makes either one legal again, the
// directive becomes unused and `tsc` fails with TS2578 — so the guard cannot
// rot in silence the way the `data?: never` version did.

test("a list row has no `data` to read", async () => {
  const row = listRow();
  // @ts-expect-error — reading `data` off a preview row must not compile.
  // `data?: never` (334f969) only blocked ASSIGNING a list row where a full row
  // was wanted; `row.data !== null` still type-checked and was always true,
  // which is exactly the predicate it was meant to replace.
  const stillCompiles = row.data;
  assert.equal(stillCompiles, undefined, "and it is not there at runtime either");
});

test("a preview cannot be written back as a payload", async () => {
  const row = listRow({ dataPreview: { head: '{"a":1', truncated: true } });
  // @ts-expect-error — `DataPreview` is not a `JsonValue`, so a truncated head
  // cannot be handed to PATCH. That round trip (list row → edit form → PATCH)
  // writing 200 characters over a full payload is the reason the preview
  // projection exists at all.
  const patch: UpdateSchemaRecordInput = { data: row.dataPreview ?? "" };
  assert.ok(patch, "the value exists; what must not exist is the type check passing");
});

test("spreading a preview does not launder it into a payload either", async () => {
  const preview = listRow().dataPreview!;
  // @ts-expect-error — the hole the assignment guard alone did NOT close.
  // Spreading produces a fresh object literal type, and object literal types
  // DO get an implicit index signature — so `{ ...preview }` was assignable to
  // `JsonValue` while `preview` itself was not. `DataPreview.notAPayload?:
  // undefined` is what closes it: the spread carries that key into the new
  // type, and `undefined` is not a `JsonValue`.
  const patch: UpdateSchemaRecordInput = { data: { ...preview } };
  assert.ok(patch, "again: the runtime value is fine, the type check must not be");
});

// ── which branch a row is on ──────────────────────────────────────────────

test("the payload branch is decided by dataPreview, not schemaName", async () => {
  assert.equal(hasPayload(listRow()), true);
  assert.equal(hasPayload(FILE_ROW), false);
  // The whole point: no schema name, but a payload body. `schemaName !== null`
  // would call this a file row — rendering "—" for a payload that is there and
  // hiding the 编辑 button on a row PATCH would happily accept.
  assert.equal(hasPayload(EMPTY_PAYLOAD_ROW), true);
});

// (Deleted: "an empty payload is not the same as no payload" only read the two
// module-local constants back to itself — no production code was on the path,
// so no mutation to `hasPayload` or `isPreviewBrokenJson` could turn it red. The
// fact it meant to pin, that those two rows land on different branches, is
// asserted through `hasPayload` in the test just above.)

// ── the invalid-JSON signal ───────────────────────────────────────────────

test("a whole, malformed JSON payload is flagged", async () => {
  const row = listRow({ dataPreview: { head: "{not json", truncated: false } });
  assert.equal(isPreviewBrokenJson(row), true);
});

test("a whole, well-formed JSON payload is not flagged", async () => {
  assert.equal(isPreviewBrokenJson(listRow()), false);
});

test("a truncated preview gets no verdict", async () => {
  // The head of a valid JSON document does not parse. Reporting that as a
  // defect in the data is what the old signal would have done here, which is
  // why 334f969 deleted it rather than porting it.
  const row = listRow({ dataPreview: { head: '{"big":"xxxx', truncated: true } });
  assert.equal(isPreviewBrokenJson(row), false);
});

test("an empty payload is not a broken one", async () => {
  // `JSON.parse("")` throws, but "" is how a run that produced nothing lands.
  assert.equal(isPreviewBrokenJson(EMPTY_PAYLOAD_ROW), false);
});

test("a non-JSON payload is not judged as JSON", async () => {
  const row = listRow({ contentType: "text/markdown", dataPreview: { head: "# title", truncated: false } });
  assert.equal(isPreviewBrokenJson(row), false);
});

test("the file branch gets no verdict", async () => {
  assert.equal(isPreviewBrokenJson(FILE_ROW), false);
});

/** A contract-bearing payload that outgrew the `data` column.
 *
 *  `planOutputRecord` produces this whenever a book with a resolvable
 *  `outputSchemaRef` returns more than INLINE_OUTPUT_LIMIT bytes —
 *  `doudian-category-tree` carries `book-output-nonempty-string@1` and its
 *  product measures 1,171,535 bytes. Before the size ceiling this combination
 *  could not exist, which is why judging the branch by `schemaName` used to
 *  look safe. */
const BIG_CONTRACT_FILE_ROW = listRow({
  schemaName: "book-output-nonempty-string", schemaVersion: 1,
  dataPreview: null,
  fileName: "abc-run-x.json", url: "/api/records/abc-run-x.json", bytes: 1_171_535,
});

test("a file row that names a contract is still a file row", () => {
  // Judging by `schemaName` would return true here, and the page would then
  // render a Data cell previewing a payload that is not in the row and an 编辑
  // button whose PATCH the service answers with a 400.
  assert.equal(hasPayload(BIG_CONTRACT_FILE_ROW), false);
  assert.notEqual(BIG_CONTRACT_FILE_ROW.schemaName, null, "precondition: it really does name a contract");
});

test("the branch predicate ignores schemaName in both directions", () => {
  // The full truth table over (has contract name, has payload). Both skews are
  // reachable, so neither column may be inferred from the other.
  assert.equal(hasPayload(listRow()), true, "contract + payload");
  assert.equal(hasPayload(BIG_CONTRACT_FILE_ROW), false, "contract + no payload");
  assert.equal(hasPayload(EMPTY_PAYLOAD_ROW), true, "no contract + payload");
  assert.equal(hasPayload(FILE_ROW), false, "no contract + no payload");
});

test("a file row that names a contract gets no JSON verdict from its absent preview", () => {
  assert.equal(isPreviewBrokenJson(BIG_CONTRACT_FILE_ROW), false);
});
