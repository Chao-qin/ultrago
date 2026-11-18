import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getRunStatusMeta,
  normalizeTags,
  parseConsoleDeliveries,
  parseConsoleParamSchema,
  parseConsoleParams,
  parseRunStatusFilter,
} from "./console-types.js";

test("console JSON adapters reject null, arrays, and scalars", () => {
  assert.deepEqual(parseConsoleParams('{"limit":1}'), { limit: 1 });
  for (const value of ["null", "[]", "1", '"text"']) {
    assert.throws(() => parseConsoleParams(value), /plain object/);
  }
  assert.throws(() => parseConsoleParamSchema("null"), /array/);
  assert.throws(() => parseConsoleDeliveries("{}"), /array/);
});

test("console adapters validate schema and delivery shapes", () => {
  assert.equal(parseConsoleParamSchema('[{"name":"q","required":true}]')[0]?.name, "q");
  assert.deepEqual(parseConsoleDeliveries('[{"kind":"print"}]'), [{ kind: "print", format: "markdown", on: "success" }]);
  assert.throws(() => parseConsoleDeliveries('[{"kind":"webhook"}]'), /requires url/);
});

test("run status filter and metadata are shared", () => {
  assert.deepEqual(parseRunStatusFilter("needsConfirm,needsJudge,noAction"), ["needsConfirm", "needsJudge", "noAction"]);
  assert.equal(getRunStatusMeta("starting").label, "启动中");
  assert.equal(getRunStatusMeta("noAction").group, "attention");
  assert.throws(() => parseRunStatusFilter("not-a-status"), /unsupported/);
});

test("tags are normalized for persistence and display", () => {
  assert.equal(normalizeTags("  Ops,console,ops ,,  "), "ops,console");
  assert.equal(normalizeTags(""), null);
  assert.equal(normalizeTags(null), null);
  assert.throws(() => normalizeTags(["ops"]), /string/);
});
