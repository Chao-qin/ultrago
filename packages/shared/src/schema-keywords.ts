/**
 * Which JSON Schema keywords this codebase actually implements.
 *
 * There is exactly one runtime validator here (`validateSchemaValue` in
 * param-runtime) and it covers a SUBSET of draft 2020-12. That subset has to be
 * stated in one place, because two things depend on knowing it and they must
 * never disagree:
 *
 *   - `validateOutput`, which has to admit when it could not really check a
 *     value rather than returning "no problems"
 *   - `isAssignable`, which has to refuse to judge two schemas it cannot read
 *
 * Those were one bug in two costumes: a document whose constraints live behind
 * `$ref` used to sail through the validator as "checked and conforming" while
 * nothing had been checked at all. Whichever module notices the gap, both have
 * to notice it the same way — hence this file, which neither imports.
 */

/** Keywords that annotate without constraining. Their presence says nothing
 *  about which values are legal, so seeing one is never a reason to give up on
 *  judging a schema. */
export const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
  "deprecated",
]);

/** Keywords `validateSchemaValue` actually implements.
 *
 *  Deliberately a WHITELIST. A blacklist of "known unsupported" keywords would
 *  quietly wave through every keyword invented after it was written, and waving
 *  something through is the exact failure this file exists to prevent. Anything
 *  neither listed here nor annotating is unsupported. */
export const SUPPORTED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "enum",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "pattern",
  "oneOf",
  "not",
  "items",
  "properties",
  "required",
  "additionalProperties",
]);

/** Sub-schemas reached through a single nested schema value. */
const SCHEMA_VALUED = [
  "items",
  "not",
  "additionalProperties",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
];
/** Sub-schemas reached through an array of schemas. */
const SCHEMA_LIST_VALUED = ["oneOf", "anyOf", "allOf", "prefixItems"];
/** Sub-schemas reached through a map whose KEYS are arbitrary names, not
 *  keywords — so the keys are never inspected, only the values. */
const SCHEMA_MAP_VALUED = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Keywords ajv enforces for us, running as `schema-records.ts` configures it:
 * the 2020-12 build, `strict: false`, no format plugin.
 *
 * The contents were MEASURED, not recalled — each keyword was put through the
 * engine with a violating value to see whether it complained. That found seven
 * entries this list claimed and the engine did not have (`prefixItems`,
 * `dependentRequired`, `unevaluatedProperties`, …), which is the exact
 * over-claim the notice exists to prevent, committed by the notice's own
 * whitelist. They are enforced now because the engine moved to the 2020-12
 * build; had it not, they would have had to come off this list.
 *
 * A WHITELIST for the same reason `SUPPORTED_SCHEMA_KEYWORDS` is one, and the
 * reason bites harder here: `strict: false` is not optional (this repo's own
 * `canonical.schema.json` carries `x-doudian-*` vendor keywords that would
 * abort compilation under `strict: true`), and its cost is that ajv passes over
 * anything it does not recognise WITHOUT A WORD. A blacklist would inherit that
 * silence. Listing what is enforced means everything else is reported.
 */
export const AJV_CHECKED_KEYWORDS: ReadonlySet<string> = new Set([
  "type", "enum", "const",
  "minLength", "maxLength", "pattern",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minItems", "maxItems", "uniqueItems", "items", "prefixItems", "contains", "minContains", "maxContains",
  "properties", "patternProperties", "additionalProperties", "required", "propertyNames",
  "minProperties", "maxProperties", "dependentRequired", "dependentSchemas",
  "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
  "$ref", "$defs", "definitions", "$dynamicRef", "$dynamicAnchor",
  "unevaluatedItems", "unevaluatedProperties",
]);

/** One traversal, two questions. Both ask "which keywords in this document are
 *  outside some set", and they differ only in the set — so they share the walk
 *  rather than keeping two copies of the nesting rules in step by hand. */
function collectForeignKeywords(schema: unknown, known: ReadonlySet<string>, seen: Set<string>): string[] {
  if (!isPlainObject(schema)) return [...seen];
  for (const [key, value] of Object.entries(schema)) {
    if (!ANNOTATION_KEYWORDS.has(key) && !known.has(key)) seen.add(key);
    if (SCHEMA_VALUED.includes(key)) collectForeignKeywords(value, known, seen);
    else if (SCHEMA_LIST_VALUED.includes(key) && Array.isArray(value)) for (const item of value) collectForeignKeywords(item, known, seen);
    else if (SCHEMA_MAP_VALUED.includes(key) && isPlainObject(value)) for (const item of Object.values(value)) collectForeignKeywords(item, known, seen);
  }
  return [...seen];
}

/** Every keyword in this document that neither annotates nor is implemented.
 *
 *  Recursive on purpose: a `$ref` buried three levels down under `properties`
 *  makes the whole document unjudgeable just as surely as one at the root, and
 *  that buried case is the one that actually shipped.
 *
 *  Still the SUBSET question, and still the right one for its two callers —
 *  `isAssignable`, which compares two schemas statically and cannot follow a
 *  `$ref`, and the script skeleton's TS codegen, which cannot name a type it
 *  cannot read. Neither becomes able to do those things because a validator
 *  elsewhere got stronger. */
export function unsupportedSchemaKeywords(schema: unknown, seen = new Set<string>()): string[] {
  return collectForeignKeywords(schema, SUPPORTED_SCHEMA_KEYWORDS, seen);
}

/** Every keyword in this document that ajv will silently pass over.
 *
 *  In practice: `format` (which needs the `ajv-formats` plugin and is otherwise
 *  a no-op) and vendor extensions like `x-doudian-total-limit` (a real
 *  constraint, enforced by a different tool entirely). Both are cases where a
 *  clean bill of health would be claiming more than was done. */
export function unenforcedSchemaKeywords(schema: unknown): string[] {
  return collectForeignKeywords(schema, AJV_CHECKED_KEYWORDS, new Set<string>());
}

/** Does this schema constrain nothing at all (so it permits every value)? */
export function isUnconstrainedSchema(schema: unknown): boolean {
  if (!isPlainObject(schema)) return true;
  return Object.keys(schema).every((k) => ANNOTATION_KEYWORDS.has(k));
}

/** Marks a reported problem that is about the CHECK rather than the value.
 *
 *  Exported so a consumer can tell "your data is wrong" apart from "nobody
 *  could verify your data" — they call for different responses, even though
 *  both belong in the same problem list. What must never happen is the second
 *  one being reported as an empty list. */
export const UNCHECKED_PREFIX = "not fully checked:";

/** The sentence appended when a schema reaches beyond the supported subset. */
export function uncheckedNotice(keywords: string[]): string {
  return `${UNCHECKED_PREFIX} this schema uses ${keywords.join(", ")}, which the validator does not implement — the value was NOT verified against those constraints`;
}

/** A reported problem list, separated into the two different things it mixes. */
export interface SplitProblems {
  /** The value is wrong: it was checked and it breached the contract. */
  violations: string[];
  /** Nobody could check part of it. Says nothing about whether the value is
   *  good — only that some constraints went unexamined. */
  notices: string[];
}

/** Split a problem list on `UNCHECKED_PREFIX`.
 *
 *  WHY THE SPLIT CANNOT LIVE IN THE PRODUCER: `SchemaRecord.schemaErrors` is a
 *  COLUMN, and what is already stored in it is the merged array. Restructuring
 *  `validateOutput`'s return value would leave every historical row exactly as
 *  ambiguous as it is now, so the separation has to happen where the list is
 *  read. This function exists so it happens the same way at every such place
 *  rather than being re-derived from the prefix at each one.
 *
 *  Both consumers used to judge by `length > 0` alone, which made a conforming
 *  value under an unsupported schema — `{items:[1,2,3]}` against
 *  `{minItems:1}` — indistinguishable from a breach. */
export function splitOutputProblems(problems: readonly string[]): SplitProblems {
  const violations: string[] = [];
  const notices: string[] = [];
  for (const problem of problems) {
    (problem.startsWith(UNCHECKED_PREFIX) ? notices : violations).push(problem);
  }
  return { violations, notices };
}
