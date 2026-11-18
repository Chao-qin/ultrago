import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyIsSubstantive } from "./verify-strength.js";

test("verifyIsSubstantive: 只有弱谓词的 verify 不算证据", () => {
  assert.equal(verifyIsSubstantive({ noErrors: true, settled: true }), false);
  assert.equal(verifyIsSubstantive({ actionSucceeded: true }), false);
  assert.equal(verifyIsSubstantive({ noErrors: true, settled: true, actionSucceeded: true }), false);
  assert.equal(verifyIsSubstantive(undefined), false);
  assert.equal(verifyIsSubstantive({}), false);
});

test("verifyIsSubstantive: 一个真谓词就够", () => {
  assert.equal(verifyIsSubstantive({ urlIncludes: "baidu.com/s" }), true);
  assert.equal(verifyIsSubstantive({ elementName: "收起" }), true);
  assert.equal(verifyIsSubstantive({ evalCheck: { code: "1" } }), true);
  assert.equal(verifyIsSubstantive({ noErrors: true, textPresent: "已提交" }), true);
});

test("verifyIsSubstantive: false 值不算声明", () => {
  // { settled: false } 是"没有这条判据"，不是"判据成立"
  assert.equal(verifyIsSubstantive({ settled: false } as never), false);
});
