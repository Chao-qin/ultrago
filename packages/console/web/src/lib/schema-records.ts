/**
 * The two questions the SchemaRecords list asks about a row that it cannot ask
 * of a `dataPreview` string alone.
 *
 * They live here rather than inside the page because the page has no test file:
 * a predicate in a `render:` callback is only reachable through a DOM, and the
 * console's suite is `node --test` with no renderer. Extracted, they are plain
 * functions with a truth table — see `schema-records.test.ts`.
 */
import type { DataPreview, SchemaRecordListRow } from "./types";

/** Does this row carry a payload body — i.e. is it the payload branch rather
 *  than the file branch?
 *
 *  The predicate is `dataPreview`, NOT `schemaName`. On a preview row
 *  `dataPreview === null` exactly when `data === null` (the service returns null
 *  for that case and only that case), and `data` is what the table's hand-written
 *  `CHECK ((data IS NULL) <> (url IS NULL))` constrains. Nothing constrains
 *  `schemaName`: `planOutputRecord` decides it from the book's `outputSchemaRef`
 *  and decides `inline` separately, from the payload's SIZE
 *  (`(schema !== null && bytes <= INLINE_OUTPUT_LIMIT) || payload === ""`).
 *  The two come apart in both directions, and judging the branch by
 *  `schemaName` gets each one wrong in its own way:
 *
 *   - `schemaName = null, data = ""` (empty payload) would render as a file and
 *     lose its 编辑 button;
 *   - `schemaName` non-null with `data = null` (a contract-bearing payload over
 *     256KB) would render as an editable payload row with no payload — a 编辑
 *     button whose PATCH the service answers with a 400, and a Data cell that
 *     tries to preview bytes that are on disk. `doudian-category-tree` produces
 *     exactly this shape: it carries `book-output-nonempty-string@1` and its
 *     product measures 1,171,535 bytes.
 *
 *  Neither row is in the table today: both
 *  `WHERE schemaName IS NULL AND data IS NOT NULL` and
 *  `WHERE schemaName IS NOT NULL AND data IS NULL` return 0 over the current 19
 *  rows (read-only query, 2026-08-28). Both producing paths are reachable. */
export function hasPayload(
  row: SchemaRecordListRow,
): row is SchemaRecordListRow & { dataPreview: DataPreview } {
  return row.dataPreview !== null;
}

/** Is this row's payload demonstrably not the JSON it claims to be?
 *
 *  This is the old `JsonPreview`'s red "invalid JSON" signal, narrowed to the
 *  cases where the answer is actually knowable from a preview:
 *
 *   - truncated → NO VERDICT. The head of a JSON document is not itself JSON, so
 *     parsing it fails on every payload long enough to be worth previewing. The
 *     old signal could parse because it held the whole payload; this one cannot.
 *     A malformed payload longer than the preview cap therefore goes unflagged
 *     here — 编辑 fetches the full row and the editor's own parse reports it.
 *   - `head === ""` → NO VERDICT. That is how `classifyOutput` writes "the run
 *     produced nothing" (`decodeLandedPayload` decodes it back to null), not a
 *     broken document.
 *   - not `application/json` → NO VERDICT. Markdown is not supposed to parse. */
export function isPreviewBrokenJson(row: SchemaRecordListRow): boolean {
  const preview = row.dataPreview;
  if (preview === null || preview.truncated || preview.head === "") return false;
  if (row.contentType !== "application/json") return false;
  try {
    JSON.parse(preview.head);
    return false;
  } catch {
    return true;
  }
}
