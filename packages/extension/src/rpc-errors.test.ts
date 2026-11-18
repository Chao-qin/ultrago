/**
 * Both arrival routes for a failure have to produce the same shape, or half of
 * them reach the agent as a bare string.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { domOpError, errorInfoOf } from "./rpc-errors";

test("跨注入边界回来的失败：诊断在结果对象里，转成可抛的 Error 后仍带着", () => {
  const e = domOpError({ error: "click intercepted", errorInfo: { code: "intercepted" } });
  assert.equal(e.message, "click intercepted");
  assert.deepEqual(errorInfoOf(e), { code: "intercepted" });
});

test("这一侧抛出的失败：诊断挂在 Error 的 bcp* 标签上", () => {
  const e = Object.assign(new Error("no match"), {
    bcpCode: "not_found",
    bcpCandidates: [{ ref: "e1" }],
    bcpRelaxedBy: "text",
  });
  assert.deepEqual(errorInfoOf(e), { code: "not_found", candidates: [{ ref: "e1" }], relaxedBy: "text" });
});

test("errorInfo 优先于 bcp* 标签 —— 前者是已经成形的诊断", () => {
  const e = Object.assign(new Error("x"), { errorInfo: { code: "intercepted" }, bcpCode: "not_found" });
  assert.deepEqual(errorInfoOf(e), { code: "intercepted" });
});

test("没有任何标签的普通 Error 不硬造诊断", () => {
  assert.equal(errorInfoOf(new Error("boom")), undefined);
});

test("非 Error 值不参与 —— 拒绝把字符串当成失败对象", () => {
  assert.equal(errorInfoOf("boom"), undefined);
  assert.equal(errorInfoOf(undefined), undefined);
  assert.equal(errorInfoOf({ bcpCode: "not_found" }), undefined);
});

test("candidates 不是数组时丢掉，而不是原样塞进契约", () => {
  const e = Object.assign(new Error("x"), { bcpCode: "not_found", bcpCandidates: "e1" });
  assert.deepEqual(errorInfoOf(e), { code: "not_found" });
});

test("没给 error 文案时有个说得过去的默认值", () => {
  assert.equal(domOpError({}).message, "dom op failed");
});
