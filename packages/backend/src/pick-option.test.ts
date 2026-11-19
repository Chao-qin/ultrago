// @ts-nocheck — fixtures are minimal snapshot shapes
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcMethod } from "@bcp/shared";
import { pickOption } from "./pick-option.js";

/** A fake page: `before`/`after` snapshots around the opening click. */
function page(before: unknown[], after: unknown[], added: string[] = []) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let snaps = 0;
  const call = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === RpcMethod.Snapshot) return snaps++ === 0 ? { elements: before } : { elements: after, changed: { added, removed: 0 } };
    return { ok: true };
  };
  return { call, calls };
}

test("pick_option 只在展开后新出现/新显示的元素里找选项，不会点到页面别处的同名元素", async () => {
  const nav = { ref: "e1", tag: "a", role: "link", name: "北京" };
  const hiddenOption = { ref: "e7", tag: "li", role: "option", name: "北京", hidden: true };
  const { call, calls } = page([nav, hiddenOption], [nav, { ...hiddenOption, hidden: undefined }]);
  const r = await pickOption(call, { css: ".city-select", option: "北京" }, "k.pick");
  assert.equal(r.ref, "e7");
  assert.equal(r.fromRevealedList, true);
  assert.deepEqual(calls.at(-1), { method: RpcMethod.Click, params: { ref: "e7", tabId: undefined } });
  assert.equal(calls[1]!.params.css, ".city-select", "触发器按描述定位");
});

test("pick_option 新出现的选项里有多个匹配时报错列出，不静默取第一个", async () => {
  const opts = [{ ref: "e8", tag: "li", role: "option", name: "北京 朝阳" }, { ref: "e9", tag: "li", role: "option", name: "北京 海淀" }];
  const { call } = page([], opts, ["e8", "e9"]);
  await assert.rejects(() => pickOption(call, { ref: "e0", option: "北京" }, "k.pick"), /2 options match "北京" in the opened list/);
});

test("pick_option 展开没出现新元素时退回整页匹配并如实标出", async () => {
  const only = { ref: "e3", tag: "li", role: "option", name: "上海" };
  const { call } = page([only], [only]);
  const r = await pickOption(call, { ref: "e0", option: "上海" }, "k.pick");
  assert.equal(r.fromRevealedList, false);
});
