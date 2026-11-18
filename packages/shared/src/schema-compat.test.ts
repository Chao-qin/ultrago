import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isAssignable } from "./schema-compat.js";
import { unsupportedSchemaKeywords as unsupportedKeywords } from "./schema-keywords.js";
import { validateOutput } from "./param-runtime.js";
import type { ParamSchemaFragment } from "./param-runtime.js";

const MONOREPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** A spread of values wide enough that the laws below get exercised rather
 *  than vacuously satisfied. Deliberately NOT generated from the schemas: the
 *  laws filter this pool through `validateOutput`, so a lazy generator costs
 *  coverage but can never cost correctness. */
const CANDIDATES: unknown[] = [
  "", "a", "abc", "0123456789", "hello world", "42", "true",
  0, 1, 5, 7, 10, 42, 100, -1, -10, 3.5, 0.1,
  true, false, null,
  [], ["a"], ["a", "b"], [1, 2, 3], [{ url: "x" }],
  {}, { a: "x" }, { a: 1 }, { a: "x", b: "y" }, { b: "y" }, { url: "https://e.com/i.jpg" },
  { name: "n", size: 3 }, { items: [] }, { items: [{ url: "u" }] },
];

/** Schema pairs spanning every branch of the decision procedure. */
const PAIRS: Array<[string, ParamSchemaFragment, ParamSchemaFragment]> = [
  ["identical strings", { type: "string" }, { type: "string" }],
  ["integer into number", { type: "integer" }, { type: "number" }],
  ["number into integer", { type: "number" }, { type: "integer" }],
  ["narrower enum", { type: "string", enum: ["a"] }, { type: "string", enum: ["a", "b"] }],
  ["wider enum", { type: "string", enum: ["a", "b"] }, { type: "string", enum: ["a"] }],
  ["disjoint enum", { type: "string", enum: ["a"] }, { type: "string", enum: ["b"] }],
  ["tighter numeric range", { type: "number", minimum: 2, maximum: 5 }, { type: "number", minimum: 0, maximum: 10 }],
  ["looser numeric range", { type: "number", minimum: 0, maximum: 10 }, { type: "number", minimum: 2, maximum: 5 }],
  ["disjoint numeric range", { type: "number", minimum: 10 }, { type: "number", maximum: 5 }],
  ["tighter length", { type: "string", minLength: 3, maxLength: 5 }, { type: "string", minLength: 1, maxLength: 10 }],
  ["disjoint length", { type: "string", minLength: 10 }, { type: "string", maxLength: 5 }],
  ["string into number", { type: "string" }, { type: "number" }],
  ["untyped source", {}, { type: "string" }],
  ["unconstrained target", { type: "string" }, {}],
  [
    "object with matching required",
    { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
    { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
  ],
  [
    "object whose source only optionally has the key",
    { type: "object", properties: { a: { type: "string" } } },
    { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
  ],
  [
    "closed object missing a required key",
    { type: "object", properties: { a: { type: "string" } }, additionalProperties: false, required: ["a"] },
    { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
  ],
  [
    "array of compatible items",
    { type: "array", items: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
    { type: "array", items: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  ],
  [
    "array whose item type conflicts",
    { type: "array", items: { type: "number" } },
    { type: "array", items: { type: "string" } },
  ],
  ["nested property conflict", { type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { a: { type: "number" } } }],
];

// ── Law A: a verdict of `ok` never lies ──────────────────────────────────

test("Law A — every value legal under a source is legal under any target it is `ok` for", () => {
  let checkedPairs = 0;
  let checkedValues = 0;
  for (const [label, src, dst] of PAIRS) {
    if (isAssignable(src, dst).level !== "ok") continue;
    checkedPairs++;
    for (const value of CANDIDATES) {
      if (validateOutput(src, value).length !== 0) continue; // value isn't legal upstream — says nothing
      checkedValues++;
      assert.deepEqual(
        validateOutput(dst, value),
        [],
        `${label}: isAssignable said ok, but ${JSON.stringify(value)} passes the source and fails the target`,
      );
    }
  }
  // These guard against a VACUOUS pass — a law that holds because the loop
  // never ran is not a law. They are not a coverage target: the pool currently
  // yields ~32 source-legal values across ~8 `ok` pairs, so a drop to single
  // digits means either the pairs stopped being `ok` or `validateOutput`
  // started rejecting everything, both of which should fail loudly here.
  assert.ok(checkedPairs >= 5, `expected several ok pairs, saw ${checkedPairs}`);
  assert.ok(checkedValues >= 25, `expected the pool to exercise the law, saw ${checkedValues} values`);
});

// ── Law B: every `error` comes with a witness ────────────────────────────

/** One row per rule that may return `error`. A rule with no witness is a rule
 *  that must be downgraded to `warn` — this table is the enforcement. */
const ERROR_WITNESSES: Array<{ rule: string; src: ParamSchemaFragment; dst: ParamSchemaFragment; witness: unknown }> = [
  { rule: "type mismatch", src: { type: "string" }, dst: { type: "number" }, witness: "abc" },
  { rule: "disjoint enum", src: { type: "string", enum: ["a"] }, dst: { type: "string", enum: ["b"] }, witness: "a" },
  { rule: "disjoint numeric range", src: { type: "number", minimum: 10 }, dst: { type: "number", maximum: 5 }, witness: 10 },
  { rule: "disjoint length range", src: { type: "string", minLength: 10 }, dst: { type: "string", maxLength: 5 }, witness: "0123456789" },
  {
    rule: "closed source cannot produce a required key",
    src: { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
    dst: { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
    witness: { a: "x" },
  },
  {
    rule: "nested item type mismatch",
    src: { type: "array", items: { type: "number" } },
    dst: { type: "array", items: { type: "string" } },
    witness: [1, 2],
  },
];

test("Law B — every error rule names a value that passes the source and fails the target", () => {
  for (const { rule, src, dst, witness } of ERROR_WITNESSES) {
    assert.equal(isAssignable(src, dst).level, "error", `${rule}: expected an error verdict`);
    assert.deepEqual(validateOutput(src, witness), [], `${rule}: the witness must be legal upstream`);
    assert.ok(validateOutput(dst, witness).length > 0, `${rule}: the witness must be rejected downstream`);
  }
});

// ── Law C: unsupported keywords are never judged ─────────────────────────

test("Law C — the real canonical-product document is judged unsupported, not ok", () => {
  // The document that started this: 9 `$ref`s plus const/format/minItems, none
  // of which validateSchemaValue implements. Read from the archive rather than
  // inlined so the law is tested against a real contract's shape.
  const doc = JSON.parse(
    readFileSync(resolve(MONOREPO_ROOT, ".claude/skills/product-preprocess/canonical.schema.json"), "utf8"),
  ) as ParamSchemaFragment;

  const found = unsupportedKeywords(doc);
  assert.ok(found.includes("$ref"), `expected $ref among ${found.join(", ")}`);
  assert.ok(found.includes("$defs"), `expected $defs among ${found.join(", ")}`);

  assert.equal(isAssignable(doc, doc).level, "unsupported", "an identical pair must still refuse to claim ok");
  assert.equal(isAssignable({ type: "object" }, doc).level, "unsupported");
});

test("Law C — a $ref hidden deep inside still disqualifies the whole document", () => {
  const buried: ParamSchemaFragment = {
    type: "object",
    properties: { images: { type: "array", items: { $ref: "#/$defs/image" } } },
    $defs: { image: { type: "object" } },
  };
  assert.deepEqual(unsupportedKeywords(buried).sort(), ["$defs", "$ref"]);
  assert.equal(isAssignable(buried, { type: "object", properties: { images: { type: "array" } } }).level, "unsupported");
});

test("Law C — annotations are not constraints and never make a schema unjudgeable", () => {
  const annotated: ParamSchemaFragment = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://bcp.local/x.json",
    title: "X",
    description: "d",
    default: "a",
    examples: ["a"],
    type: "string",
  };
  assert.deepEqual(unsupportedKeywords(annotated), []);
  assert.equal(isAssignable(annotated, { type: "string" }).level, "ok");
});

test("Law C — the keyword list is a whitelist, so an unknown keyword is refused rather than ignored", () => {
  // A keyword invented after this code was written must not be waved through.
  assert.deepEqual(unsupportedKeywords({ type: "string", someFutureKeyword: 1 }), ["someFutureKeyword"]);
  assert.equal(isAssignable({ type: "string", someFutureKeyword: 1 }, { type: "string" }).level, "unsupported");
});

test("Law C — the offending keywords are evidence in `detail`, not a paragraph inside `reason`", () => {
  // The canvas reports one of these per wire, so a reason that inlines a dozen
  // keyword names repeats that dozen on every wire. The count belongs in the
  // sentence; the names belong somewhere they can be asked for.
  const buried: ParamSchemaFragment = {
    type: "object",
    properties: { images: { type: "array", items: { $ref: "#/$defs/image" } } },
    $defs: { image: { type: "object" } },
  };

  const asTarget = isAssignable({ type: "object" }, buried);
  assert.equal(asTarget.level, "unsupported");
  assert.match(asTarget.reason, /含 2 个/);
  assert.doesNotMatch(asTarget.reason, /\$ref|\$defs/);
  assert.ok(asTarget.detail?.includes("$ref"), `expected $ref in detail, got ${asTarget.detail}`);
  assert.ok(asTarget.detail?.includes("$defs"), `expected $defs in detail, got ${asTarget.detail}`);

  // The source side is a separate branch and drifts independently.
  const asSource = isAssignable(buried, { type: "object", properties: { images: { type: "array" } } });
  assert.equal(asSource.level, "unsupported");
  assert.doesNotMatch(asSource.reason, /\$ref|\$defs/);
  assert.ok(asSource.detail?.includes("$ref"), `expected $ref in detail, got ${asSource.detail}`);
});

// ── The individual verdicts ──────────────────────────────────────────────

test("a target that constrains nothing accepts anything, even an unjudgeable source", () => {
  assert.equal(isAssignable({ type: "string" }, {}).level, "ok");
  assert.equal(isAssignable({ type: "string" }, null).level, "ok");
  assert.equal(isAssignable({ $ref: "#/$defs/x" }, {}).level, "ok");
  // Annotations alone don't constrain.
  assert.equal(isAssignable({ type: "string" }, { title: "anything" }).level, "ok");
});

test("an undeclared source is a warning, not a failure", () => {
  assert.equal(isAssignable(null, { type: "string" }).level, "warn");
  assert.equal(isAssignable({}, { type: "string" }).level, "warn");
});

test("integer widens into number but number does not narrow into integer", () => {
  assert.equal(isAssignable({ type: "integer" }, { type: "number" }).level, "ok");
  assert.equal(isAssignable({ type: "number" }, { type: "integer" }).level, "warn");
});

test("enum containment decides between ok, warn and error", () => {
  assert.equal(isAssignable({ enum: ["a"] }, { enum: ["a", "b"] }).level, "ok");
  assert.equal(isAssignable({ enum: ["a", "c"] }, { enum: ["a", "b"] }).level, "warn");
  assert.equal(isAssignable({ enum: ["c"] }, { enum: ["a", "b"] }).level, "error");
  assert.equal(isAssignable({ type: "string" }, { enum: ["a"] }).level, "warn");
});

test("ranges: contained is ok, overlapping is a warning, disjoint is an error", () => {
  assert.equal(isAssignable({ type: "number", minimum: 2, maximum: 5 }, { type: "number", minimum: 0, maximum: 10 }).level, "ok");
  assert.equal(isAssignable({ type: "number", minimum: 0, maximum: 10 }, { type: "number", minimum: 2, maximum: 5 }).level, "warn");
  assert.equal(isAssignable({ type: "number", minimum: 10 }, { type: "number", maximum: 5 }).level, "error");
  assert.equal(isAssignable({ type: "string", minLength: 10 }, { type: "string", maxLength: 5 }).level, "error");
});

test("a required key the source cannot produce is only an error when the source is closed", () => {
  const closed: ParamSchemaFragment = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
  const open: ParamSchemaFragment = { type: "object", properties: { a: { type: "string" } } };
  const wants: ParamSchemaFragment = { type: "object", properties: { b: { type: "string" } }, required: ["b"] };
  assert.equal(isAssignable(closed, wants).level, "error");
  assert.equal(isAssignable(open, wants).level, "warn");
});

test("an optional source key feeding a required target key is a warning", () => {
  const src: ParamSchemaFragment = { type: "object", properties: { a: { type: "string" } } };
  const dst: ParamSchemaFragment = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  const verdict = isAssignable(src, dst);
  assert.equal(verdict.level, "warn");
  assert.match(verdict.reason, /只是可选产生/);
});

test("verdicts carry the path they came from", () => {
  const verdict = isAssignable(
    { type: "array", items: { type: "object", properties: { url: { type: "number" } } } },
    { type: "array", items: { type: "object", properties: { url: { type: "string" } } } },
  );
  assert.equal(verdict.level, "error");
  assert.equal(verdict.at, "[].url");
});

test("a pattern the source does not restate is a warning, since regex containment is undecidable here", () => {
  assert.equal(isAssignable({ type: "string" }, { type: "string", pattern: "^a" }).level, "warn");
  assert.equal(isAssignable({ type: "string", pattern: "^a" }, { type: "string", pattern: "^a" }).level, "ok");
});

test("oneOf/not on either side downgrades to a warning rather than a guess", () => {
  assert.equal(isAssignable({ oneOf: [{ type: "string" }] }, { type: "string" }).level, "warn");
  assert.equal(isAssignable({ type: "string" }, { type: "string", not: { enum: ["x"] } }).level, "warn");
});

test("the strictest verdict wins when a shape has several problems", () => {
  const verdict = isAssignable(
    { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } },
    { type: "object", properties: { a: { type: "string", pattern: "^x" }, b: { type: "number" } }, required: ["a", "b"] },
  );
  assert.equal(verdict.level, "error");
});
