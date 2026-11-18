import { test } from "node:test";
import assert from "node:assert/strict";
import { describeOutputs, planOutputRecord, INLINE_OUTPUT_LIMIT, type DescribedOutputs } from "./output-type.js";

const CONTRACT = JSON.stringify({
  type: "object",
  required: ["reply"],
  properties: {
    reply: { type: "string" },
    hits: { type: "integer", minimum: 0 },
  },
});

test("no declared contract is reported as unchecked, not as a pass", () => {
  for (const schema of [null, undefined, "", "not json", '"a string"', "[1,2]"]) {
    const d = describeOutputs({ reply: "hi" }, schema);
    assert.equal(d.outputsSchemaErrors, null, `schema ${JSON.stringify(schema)} should read as "no contract"`);
  }
});

test("conforming output records an empty problem list, distinct from null", () => {
  const d = describeOutputs({ reply: "hi", hits: 3 }, CONTRACT);
  assert.equal(d.outputsSchemaErrors, "[]");
  assert.notEqual(d.outputsSchemaErrors, null);
});

test("violations are recorded per problem, and never change the rest of the description", () => {
  const value = { hits: -1 };
  const d = describeOutputs(value, CONTRACT);
  const problems = JSON.parse(d.outputsSchemaErrors!) as string[];

  assert.ok(problems.some((p) => /reply/.test(p) && /required/i.test(p)), `missing required not reported: ${problems}`);
  assert.ok(problems.some((p) => /hits/.test(p) && />= 0/.test(p)), `minimum not reported: ${problems}`);

  // A violation is a recording, not a failure: the produced data is still
  // classified and stored exactly as it would be without any contract.
  const without = describeOutputs(value, null);
  assert.equal(d.outputsData, without.outputsData);
  assert.equal(d.outputsContentType, without.outputsContentType);
});

test("nested shapes are checked, not just the top level", () => {
  const nested = JSON.stringify({
    type: "object",
    properties: { items: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } },
  });
  assert.equal(describeOutputs({ items: [{ id: "a" }, { id: "b" }] }, nested).outputsSchemaErrors, "[]");
  const problems = JSON.parse(describeOutputs({ items: [{ id: "a" }, { id: 7 }] }, nested).outputsSchemaErrors!) as string[];
  // JSON Pointer, which is what ajv reports. The point of the assertion is
  // unchanged: the message has to say WHICH element, not just that one of them
  // is wrong.
  assert.ok(problems.some((p) => /\/items\/1\/id/.test(p)), `element index not reported: ${problems}`);
});

test("an unserializable output still produces a writable run record", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const d = describeOutputs(cyclic, CONTRACT);
  assert.equal(typeof d.outputsData, "string");
  assert.ok(JSON.parse(d.outputsSchemaErrors!).length > 0, "a cyclic object cannot satisfy the reply contract");
});

// ── where the payload goes ────────────────────────────────────────────────
//
// Two axes that were merged twice and must stay apart: CONTRACT IDENTITY
// (`schemaName`/`schemaVersion`, from the book's `outputSchemaRef`) and
// STORAGE LOCATION (`inline`, from the byte count). The cases below pin the
// full truth table plus the boundary, so that removing either conjunct of
// `(schema !== null && bytes <= INLINE_OUTPUT_LIMIT)` fails something.

/** A described payload of an exact UTF-8 byte length. ASCII, so one char is
 *  one byte — the CJK case gets its own test below. */
function payloadOfBytes(n: number, schemaErrors: string | null = null): DescribedOutputs {
  return { outputsData: "x".repeat(n), outputsContentType: "application/json", outputsSchemaErrors: schemaErrors };
}

test("a contract does not by itself buy the data column: over the limit the payload goes to a file", () => {
  const plan = planOutputRecord(payloadOfBytes(INLINE_OUTPUT_LIMIT + 1), "book-output-nonempty-string@1");
  assert.equal(plan.inline, false, "a payload past the ceiling must not occupy a TEXT column");
  // …and the contract is NOT lost on the way there. This half is the point of
  // splitting the axes rather than just adding a ceiling: the row still says
  // which contract these bytes keep.
  assert.equal(plan.schemaName, "book-output-nonempty-string");
  assert.equal(plan.schemaVersion, 1);
});

test("a contract plus a payload that fits still takes the data column", () => {
  const plan = planOutputRecord(payloadOfBytes(1024), "book-output-nonempty-string@1");
  assert.equal(plan.inline, true);
  assert.equal(plan.schemaName, "book-output-nonempty-string");
});

test("no contract means a file whatever the size", () => {
  for (const n of [1, 1024, INLINE_OUTPUT_LIMIT, INLINE_OUTPUT_LIMIT + 1]) {
    const plan = planOutputRecord(payloadOfBytes(n), null);
    assert.equal(plan.inline, false, `${n} bytes with no contract must land in a file`);
    assert.equal(plan.schemaName, null);
  }
});

test("an empty payload takes the data column with or without a contract", () => {
  // RecordsService refuses an empty body, so the file branch has nothing to
  // write; a zero-byte file would be a worse record of "produced nothing" than
  // an empty column. Both halves matter — the no-contract case is the one the
  // `|| payload === ""` disjunct exists for, since the size test alone
  // (`0 <= LIMIT`) never fires without a schema.
  const withRef = planOutputRecord(payloadOfBytes(0), "book-output-nonempty-string@1");
  const withoutRef = planOutputRecord(payloadOfBytes(0), null);
  assert.equal(withRef.inline, true);
  assert.equal(withoutRef.inline, true, "an empty product must not be asked to become a zero-byte file");
  assert.equal(withoutRef.schemaName, null, "and it lands as a payload row carrying no contract name");
});

test("the ceiling is inclusive, and one byte is the whole difference", () => {
  // The boundary itself, asserted against the real constant rather than a
  // number copied next to it: a test that hard-codes 262144 keeps passing when
  // the limit moves, which is the same class of false defence as an assertion
  // threshold set looser than the value it guards.
  const atLimit = planOutputRecord(payloadOfBytes(INLINE_OUTPUT_LIMIT), "product@1");
  const overLimit = planOutputRecord(payloadOfBytes(INLINE_OUTPUT_LIMIT + 1), "product@1");
  assert.equal(atLimit.bytes, INLINE_OUTPUT_LIMIT, "precondition: the fixture really sits on the boundary");
  assert.equal(overLimit.bytes, INLINE_OUTPUT_LIMIT + 1);
  assert.equal(atLimit.inline, true, "exactly at the limit still fits");
  assert.equal(overLimit.inline, false, "one byte past it does not");
});

test("the ceiling counts UTF-8 bytes, not UTF-16 code units", () => {
  // A CJK payload is ~3 bytes per character, so this one is comfortably under
  // the limit by `.length` and over it by byte count. Judging by `.length`
  // would send it inline — the same undercount `bytes` was given its own
  // comment to prevent, arriving here through a different door.
  const chars = Math.ceil(INLINE_OUTPUT_LIMIT / 3) + 1;
  const described: DescribedOutputs = {
    outputsData: "商".repeat(chars),
    outputsContentType: "application/json",
    outputsSchemaErrors: null,
  };
  assert.ok(described.outputsData.length < INLINE_OUTPUT_LIMIT, "precondition: under the limit by code units");
  const plan = planOutputRecord(described, "product@1");
  assert.ok(plan.bytes > INLINE_OUTPUT_LIMIT, "precondition: over the limit by UTF-8 bytes");
  assert.equal(plan.inline, false);
});

test("the contract verdict is recorded wherever the bytes land", () => {
  // schemaErrors is what the flow runner's fatal-violation rule reads. A big
  // product that violates its contract must not become a silent pass just
  // because its bytes went to disk.
  const violating = payloadOfBytes(INLINE_OUTPUT_LIMIT + 1, '["/ must be a string"]');
  const plan = planOutputRecord(violating, "book-output-nonempty-string@1");
  assert.equal(plan.inline, false, "precondition: it really is on the file branch");
  assert.equal(plan.schemaErrors, '["/ must be a string"]');
});

test("an unpinned ref is no contract, so its payload lands in a file even when tiny", () => {
  for (const ref of ["product", "product@", "product@abc", "@2", "", null, undefined]) {
    const plan = planOutputRecord(payloadOfBytes(16), ref);
    assert.equal(plan.schemaName, null, `${JSON.stringify(ref)} must not resolve to a contract`);
    assert.equal(plan.inline, false);
  }
});

test("describeOutputs feeds planOutputRecord: a real megabyte product lands as a file with its contract", () => {
  // The end-to-end shape of the row `doudian-category-tree` produces: it is one
  // of the two live books carrying `book-output-nonempty-string@1`, and the
  // landed product measured 1,171,535 bytes in resource/db/console.db.
  const described = describeOutputs({ categories: Array.from({ length: 40_000 }, (_, i) => ({ id: i, 名称: "女装" })) }, null);
  assert.ok(Buffer.byteLength(described.outputsData, "utf8") > INLINE_OUTPUT_LIMIT, "precondition: a megabyte-class product");
  const plan = planOutputRecord(described, "book-output-nonempty-string@1");
  assert.equal(plan.inline, false);
  assert.equal(plan.schemaName, "book-output-nonempty-string");
  assert.equal(plan.contentType, "application/json", "the media type is carried on the file branch too");
});
