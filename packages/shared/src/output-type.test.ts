import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOutput } from "./output-type.js";

test("classifyOutput is the shared typed-output contract", () => {
  assert.deepEqual(classifyOutput(null), { data: "", type: "null", contentType: "application/json" });
  assert.deepEqual(classifyOutput(false), { data: "false", type: "boolean", contentType: "application/json" });
  assert.deepEqual(classifyOutput("# title"), { data: "# title", type: "markdown", contentType: "text/markdown" });
  assert.deepEqual(classifyOutput({ ok: true }), { data: '{"ok":true}', type: "json", contentType: "application/json" });
});

test("a book that serializes its result still produced a JSON document", () => {
  // Real shape from doubao-ask: pretty-printed JSON whose string values carry
  // their own escaped newlines. Labelling this text/plain sends every consumer
  // down the wrong path.
  const serialized = '{\n  "conversationId": "384388",\n  "reply": "# 7张图\\n1. **第一张**"\n}';
  const out = classifyOutput(serialized);
  assert.equal(out.type, "json");
  assert.equal(out.contentType, "application/json");
  assert.equal(out.data, serialized, "the payload must be stored byte-for-byte, only the label is derived");

  assert.equal(classifyOutput('[{"id":1}]').type, "json");
  assert.equal(classifyOutput('  \n {"a":1}').type, "json", "leading whitespace must not hide a JSON document");
});

test("only object/array payloads count as JSON — scalars stay text", () => {
  // These all parse, but relabelling them would rename ordinary prose.
  for (const scalar of ["123", "true", "null", '"quoted"']) {
    assert.equal(classifyOutput(scalar).type, "text", `${scalar} must stay text`);
  }
  assert.equal(classifyOutput("{not json}").type, "text", "a brace is not a document");
  assert.equal(classifyOutput("plain sentence").type, "text");
});

test("markdown detection still wins for prose, and JSON never masks it", () => {
  assert.equal(classifyOutput("# heading\nbody").type, "markdown");
  assert.equal(classifyOutput("| a | b |").type, "markdown");
  // A JSON document that happens to contain a heading inside a value is JSON,
  // not markdown — the outer structure decides.
  assert.equal(classifyOutput('{"reply":"# heading"}').type, "json");
});
