// @ts-nocheck — fixtures are minimal snapshot shapes
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcMethod } from "@bcp/shared";
import { pickOption } from "./pick-option.js";

/** A fake page: `before`/`after` snapshots around the opening click. */
function page(before: unknown[], after: unknown[]) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let snaps = 0;
  const call = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === RpcMethod.Snapshot) return { elements: snaps++ === 0 ? before : after, docs: { "0": "doc" } };
    return { ok: true };
  };
  return { call, calls };
}

test("pick_option 只在展开后新出现/新显示的元素里找选项，不会点到页面别处的同名元素", async () => {
  const nav = { ref: "e1", tag: "a", role: "link", name: "北京" };
  const hiddenOption = { ref: "e7", tag: "li", role: "option", name: "北京", hidden: true };
  const { call, calls } = page([nav, hiddenOption], [nav, { ...hiddenOption, hidden: undefined }]);
  const r = await pickOption(call, { css: ".city-select", option: "北京" });
  assert.equal(r.ref, "e7");
  assert.equal(r.fromRevealedList, true);
  assert.deepEqual(calls.at(-1), { method: RpcMethod.Click, params: { ref: "e7", tabId: undefined } });
  assert.equal(calls[1]!.params.css, ".city-select", "触发器按描述定位");
});

test("pick_option 新出现的选项里有多个匹配时报错列出，不静默取第一个", async () => {
  const opts = [{ ref: "e8", tag: "li", role: "option", name: "北京 朝阳" }, { ref: "e9", tag: "li", role: "option", name: "北京 海淀" }];
  const { call } = page([], opts);
  await assert.rejects(() => pickOption(call, { ref: "e0", option: "北京" }), /2 options match "北京" in the opened list/);
});

test("pick_option 展开没出现新元素时退回整页匹配并如实标出", async () => {
  const only = { ref: "e3", tag: "li", role: "option", name: "上海" };
  const { call } = page([only], [only]);
  const r = await pickOption(call, { ref: "e0", option: "上海" });
  assert.equal(r.fromRevealedList, false);
});

test("pick_option 的触发器跳转了页面时，新页面的同名 ref 不被当成展开前就可见的", async () => {
  const opt = { ref: "e1", tag: "li", role: "option", name: "北京" };
  let snaps = 0;
  const call = async (method: string) =>
    method === RpcMethod.Snapshot ? { elements: [opt], docs: { "0": snaps++ === 0 ? "old" : "new" } } : { ok: true };
  const r = await pickOption(call, { ref: "e0", option: "北京" });
  assert.equal(r.fromRevealedList, true, "跳转后 e1 是另一个文档里的元素");
});

test("pick_option 遇到不带 docs 的旧扩展，仍按展开前后的可见性找新显示的选项", async () => {
  const nav = { ref: "e1", tag: "a", role: "link", name: "北京" };
  const opt = { ref: "e7", tag: "li", role: "option", name: "北京", hidden: true };
  let snaps = 0;
  const call = async (method: string) =>
    method === RpcMethod.Snapshot ? { elements: snaps++ === 0 ? [nav, opt] : [nav, { ...opt, hidden: undefined }] } : { ok: true };
  const r = await pickOption(call, { ref: "e0", option: "北京" });
  assert.equal(r.ref, "e7", "不能退回整页匹配、去点同名的导航链接");
  assert.equal(r.fromRevealedList, true);
});
