/** Compatibility import for console-only callers. The contract lives in shared. */
export { classifyOutput } from "@bcp/shared";
export type { OutputType, TypedOutput } from "@bcp/shared";

import { classifyOutput as classify, validateOutput, type ParamSchemaFragment } from "@bcp/shared";

/** A run's produced value, described once: the bytes, how to decode them, and
 *  the contract verdict.
 *
 *  Two call sites land a run's produced data — the dispatcher's terminal poll
 *  and the durable terminal ingest — and they must agree on all of it. Keeping
 *  the derivation here (pure, no I/O) means adding a field later can't leave
 *  one of them behind.
 *
 *  `bookOutputSchema` is the raw `Book.outputSchema` JSON string; null (or
 *  unparseable) means the book declares no contract, which yields
 *  `outputsSchemaErrors: null` — deliberately distinct from `"[]"`, so
 *  "nobody checked" never reads as "it passed".
 *
 *  So that field has three readings, and a fourth hiding inside the third:
 *    null    — no contract declared
 *    "[]"    — checked in full, and conforming
 *    [ ... ] — problems. An entry beginning with shared's `UNCHECKED_PREFIX`
 *              is a problem with the CHECK, not the data: the schema used
 *              keywords the validator does not implement ($ref, const,
 *              minItems…), so those constraints went unverified. Such a schema
 *              used to yield "[]" and read as a pass while nothing had been
 *              examined.
 *
 *  The list is therefore NOT a violation count, and a reader must not treat it
 *  as one — `{items:[1,2,3]}` under `{minItems:1}` conforms and still produces
 *  a one-entry list. Split it with shared's `splitOutputProblems`; both places
 *  that act on this column (the flow runner's fatal-violation rule and the
 *  console's ContractTag) go through that one helper rather than each
 *  re-deriving the distinction from the prefix.
 */
export interface DescribedOutputs {
  outputsData: string;
  outputsContentType: string;
  outputsSchemaErrors: string | null;
}

export function describeOutputs(value: unknown, bookOutputSchema: string | null | undefined): DescribedOutputs {
  const typed = classify(value);
  return {
    outputsData: typed.data,
    outputsContentType: typed.contentType,
    outputsSchemaErrors: checkOutputContract(value, bookOutputSchema),
  };
}

/**
 * `classifyOutput` run backwards: a landed payload back into the value the book
 * produced. The delivery layer needs that value, not its serialization — a
 * print delivery of a markdown product must render the markdown, and a webhook
 * body must carry the object rather than a string containing it.
 *
 * `data: ""` is how `classifyOutput` writes null/undefined, so it decodes back
 * to null. A run that produced NOTHING has no landed row at all, which is a
 * different thing and stays `undefined` at the call site.
 */
export function decodeLandedPayload(data: string, contentType: string): unknown {
  if (contentType !== "application/json") return data;
  if (data === "") return null;
  try {
    return JSON.parse(data);
  } catch {
    // The bytes were labelled JSON but aren't. Hand back what is actually
    // there rather than pretending the payload is missing.
    return data;
  }
}

/** Above this many bytes a payload stops going in the `data` column, whatever
 *  else is true of it.
 *
 *  ONE CONSTANT, TWO READINGS, AND THEY MUST NOT DRIFT APART. `flow-runner`
 *  imports this to decide how much of a FILE-branch payload it reads back for a
 *  downstream node, and that is why a second, independent storage ceiling would
 *  be wrong rather than merely redundant. `FlowRunnerService.recordOutputs`
 *  returns `data` UNCONDITIONALLY when it is non-null — the size check there
 *  guards only the file branch. A storage ceiling set ABOVE the read-back
 *  ceiling would therefore open a band of sizes that lands in `data` and gets
 *  re-read in full on every 200ms dispatcher tick, which is exactly what the
 *  read-back ceiling exists to prevent. Two numbers obliged to stay equal,
 *  living in two files with nothing enforcing it, is the drift bug; this is one
 *  number under one name. `flow-runner.service.ts` re-exports it, so its
 *  existing importers are untouched, and the value is unchanged from when it
 *  was defined there.
 *
 *  It lives HERE rather than there because this module is pure — no Nest, no
 *  I/O — and the flow runner already imports from it. The reverse direction
 *  would make the pure module depend on a service. */
export const INLINE_OUTPUT_LIMIT = 256 * 1024;

/** The one `SchemaRecord` row a run's product lands as, worked out without
 *  touching disk or the database. `describeOutputs` already produced the
 *  payload and ran the contract check; this only decides WHERE the payload
 *  belongs, so the two terminal write points can share one answer the same way
 *  they share the description above.
 *
 *  THREE THINGS ARE BEING ASKED, AND NONE OF THEM MAY ABSORB ANOTHER:
 *
 *    how to decode the bytes → `contentType`, carried on both branches
 *    which contract they keep → `schemaName` / `schemaVersion`, from the ref
 *    where the bytes live     → `inline`, from their size
 *
 *  The v1 design merged the first into the third: `contentType` was the branch
 *  predicate. reports/doudian-category-properties.json refuted it — 28,652,646
 *  bytes of `application/json` with no contract behind it, which an "it parses
 *  as JSON" rule would have put in a TEXT column in full. Anything that isn't
 *  JSON cannot carry a structural contract in the first place, so it reaches
 *  the file branch by the size rule rather than by an exception to it.
 *
 *  The rule that replaced it — `schemaName` non-null ⇒ `data` — merged the
 *  SECOND into the third and so repeated the same error one level down: a
 *  resolvable `outputSchemaRef` sent the payload to `data` whatever it weighed.
 *  Three facts read out of resource/db/console.db (read-only, 2026-08-28) say
 *  that was live, not theoretical:
 *
 *    - two of the six live books carry `outputSchemaRef =
 *      "book-output-nonempty-string@1"` (`doubao-ask`, `doudian-category-tree`),
 *      so their products resolve;
 *    - a `SchemaRecord` row (schemaName `doudian-category-tree`, version 1)
 *      already holds 1,171,535 bytes in `data`. It predates and is unrelated to
 *      the refs above — it is cited only as evidence of the size a `data`
 *      column here actually reaches;
 *    - the DB CHECK is `(data IS NULL) <> (url IS NULL)` and does not mention
 *      `schemaName`, so nothing below this function ever enforced the merge.
 *
 *  Splitting them leaves BOTH invariants standing at once: the contract stays
 *  known, because `schemaName`/`schemaVersion` are now recorded on the file
 *  branch too, and a megabyte still leaves the TEXT column. Every reader that
 *  has to pick a branch was already keyed on payload presence rather than on
 *  the contract name — `recordOutputs` and `PayloadView` on `data !== null`,
 *  `hasPayload` on `dataPreview !== null`, `SchemaRecordsService.update` on
 *  `data === null`, `decodeRow` on `data ?? readFileSync` — so the combination
 *  this now produces needed no reader taught about it. */
export interface OutputRecordPlan {
  contentType: string;
  schemaName: string | null;
  schemaVersion: number | null;
  schemaErrors: string | null;
  /** The produced bytes, as a string: the `data` column on the payload branch,
   *  the file body on the other. */
  payload: string;
  /** UTF-8 byte count. NOT `payload.length`, which counts UTF-16 code units and
   *  undercounts a CJK payload by 20%+. */
  bytes: number;
  /** true → the payload goes in the `data` column; false → the caller stores it
   *  as a file and fills `fileName` + `url`. */
  inline: boolean;
}

export function planOutputRecord(
  described: DescribedOutputs,
  bookOutputSchemaRef: string | null | undefined,
): OutputRecordPlan {
  const schema = parseSchemaRef(bookOutputSchemaRef);
  const payload = described.outputsData;
  const bytes = Buffer.byteLength(payload, "utf8");
  return {
    contentType: described.outputsContentType,
    // Recorded on BOTH branches now. A payload that outgrew the `data` column
    // did not stop having a contract, and dropping the name on the way to a
    // file would make the row indistinguishable from one that never had one.
    schemaName: schema?.name ?? null,
    schemaVersion: schema?.version ?? null,
    // Recorded on both branches, and it always was — the check ran against the
    // book's inline `outputSchema`, which a book may declare without having
    // been converged onto the registry yet (four of the six live books are in
    // exactly that state; the other two declare both an inline `outputSchema`
    // and an `outputSchemaRef`). Dropping it on the file branch would silently
    // disarm the flow runner's fatal-violation rule for every run that lands
    // there, so the three readings documented above survive the split intact.
    schemaErrors: described.outputsSchemaErrors,
    payload,
    bytes,
    // The two conjuncts of the first disjunct are the two axes kept apart: a
    // contract makes the payload ELIGIBLE for the column, its size decides
    // whether it may actually have it.
    //
    // The second disjunct is not the size rule this branch exists to reject —
    // it is the absence of anything to write. A run that produced nothing has
    // no bytes for a file (RecordsService refuses an empty body), and a
    // zero-byte file would be a worse record of "produced nothing" than an
    // empty column. The file branch keeps megabytes out of a TEXT column; at
    // zero bytes there is nothing for it to protect. It stays a disjunct rather
    // than folding into the size test because an empty payload with no contract
    // must still take the column — `0 <= LIMIT` alone would send it to a file.
    inline: (schema !== null && bytes <= INLINE_OUTPUT_LIMIT) || payload === "",
  };
}

/** `"name@version"` → the pinned contract this book promises to produce.
 *
 *  Null for a book not yet converged onto the registry and for a ref whose
 *  version isn't pinned: the registry holds `name+version` immutable, and that
 *  pin is the only thing keeping a historical run's contract readable. Either
 *  way there is no resolvable schema, and a payload with no contract always
 *  goes to a file — but the converse does not hold, since a resolvable one over
 *  `INLINE_OUTPUT_LIMIT` goes there too.
 *
 *  Convergence has started, so the null case is no longer the only one that
 *  runs: of the six live books, `doubao-ask` and `doudian-category-tree` carry
 *  `outputSchemaRef = "book-output-nonempty-string@1"`; the remaining four are
 *  still NULL. What that buys those two is `schemaName`/`schemaVersion` on the
 *  row and eligibility for the `data` column, not the column itself —
 *  `doudian-category-tree`'s own product is a megabyte of category tree. */
export function parseSchemaRef(ref: string | null | undefined): { name: string; version: number } | null {
  if (!ref) return null;
  const at = ref.lastIndexOf("@");
  if (at <= 0) return null;
  const version = Number(ref.slice(at + 1));
  return Number.isInteger(version) && version > 0 ? { name: ref.slice(0, at), version } : null;
}

function checkOutputContract(value: unknown, bookOutputSchema: string | null | undefined): string | null {
  const schema = parseOutputSchema(bookOutputSchema);
  if (!schema) return null;
  return JSON.stringify(validateOutput(schema, value));
}

/** A stored schema that no longer parses is treated as "no contract" rather
 *  than as a violation — the book's declaration is at fault, not the run's
 *  output, and failing the wrong party would send the reader hunting in the
 *  wrong place. */
function parseOutputSchema(raw: string | null | undefined): ParamSchemaFragment | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ParamSchemaFragment) : null;
  } catch {
    return null;
  }
}
