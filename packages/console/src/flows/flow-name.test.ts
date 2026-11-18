import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFlowName } from "./flows.service.js";

test("a flow name may be Chinese — it is a label, not an identifier", () => {
  // The bug this pins: the rule started as a copy of Schema.name's kebab-case
  // check, where the restriction is load-bearing because consumers cite
  // "canonical-product@1" as a string. Flows are referenced by id, so the
  // alphabet never mattered — and rejecting 中文 made the most natural way to
  // name a flow in this console impossible.
  assert.equal(normalizeFlowName("啊实打实"), "啊实打实");
  assert.equal(normalizeFlowName("商品预处理与发布"), "商品预处理与发布");
  assert.equal(normalizeFlowName("1688 采集 → 抖店"), "1688 采集 → 抖店");
  assert.equal(normalizeFlowName("smoke-test"), "smoke-test");
  assert.equal(normalizeFlowName("A/B 对照"), "A/B 对照");
});

test("surrounding whitespace is trimmed rather than rejected", () => {
  assert.equal(normalizeFlowName("  报告流程  "), "报告流程");
});

test("an empty or whitespace-only name is refused", () => {
  assert.throws(() => normalizeFlowName(""), /不能为空/);
  assert.throws(() => normalizeFlowName("   "), /不能为空/);
  assert.throws(() => normalizeFlowName(undefined), /不能为空/);
});

test("the length limit counts characters and says how many there are", () => {
  assert.equal(normalizeFlowName("啊".repeat(60)).length, 60);
  assert.throws(() => normalizeFlowName("啊".repeat(61)), /最多 60 个字符，当前 61 个/);
});

test("control characters are refused, since they cannot be seen or typed back", () => {
  assert.throws(() => normalizeFlowName("流程\u0000名"), /控制字符/);
  assert.throws(() => normalizeFlowName("流程\u001F名"), /控制字符/);
  assert.throws(() => normalizeFlowName("流程\u007F名"), /控制字符/);
  // A newline is a control character too, and a name spanning lines would
  // render as a broken row in every table that shows it.
  assert.throws(() => normalizeFlowName("第一行\n第二行"), /控制字符/);
});
