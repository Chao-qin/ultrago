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

test("pick_option 的触发器跳转了页面时，什么也不选，直说触发器不是开这个列表的", async () => {
  const opt = { ref: "e1", tag: "li", role: "option", name: "北京" };
  let snaps = 0;
  const clicks: unknown[] = [];
  const call = async (method: string, params: unknown) => {
    if (method === RpcMethod.Click) clicks.push(params);
    return method === RpcMethod.Snapshot ? { url: "https://x/next", elements: [opt], docs: { "0": snaps++ === 0 ? "old" : "new" } } : { ok: true };
  };
  await assert.rejects(pickOption(call, { ref: "e0", option: "北京" }), /navigated to a new document \(https:\/\/x\/next\).*nothing was picked/);
  assert.equal(clicks.length, 1, "只点了触发器，没有在新页面上点任何选项");
});

test("pick_option 期间换了文档的子帧（广告、挂件）不算触发器打开的列表", async () => {
  const before = [{ ref: "e1", tag: "button", role: "button", name: "城市" }, { ref: "42_e1", tag: "a", role: "link", name: "北京" }];
  const after = [...before, { ref: "e2", tag: "li", role: "option", name: "上海" }];
  let snaps = 0;
  const call = async (method: string) =>
    method === RpcMethod.Snapshot
      ? (snaps++ === 0 ? { elements: before, docs: { "0": "top", "42": "ad1" } } : { elements: after, docs: { "0": "top", "42": "ad2" } })
      : { ok: true };
  const r = await pickOption(call, { ref: "e1", option: "北京" }).catch((e) => e);
  assert.match(String(r), /not found in the list the trigger opened/, "重载的子帧里的「北京」不在展开的列表里");
});

test("pick_option 不把隐藏分组的容器当选项：退回整页匹配时，可见的关着的 details 名字里含选项文字也不选它", async () => {
  const page = [
    { ref: "e1", tag: "button", role: "button", name: "城市" },
    { ref: "e2", tag: "details", role: "generic", name: "城市 北京 上海", container: true, hiddenGroup: true },
  ];
  const call = async (method: string) => (method === RpcMethod.Snapshot ? { elements: page, docs: { "0": "d" } } : { ok: true });
  await assert.rejects(pickOption(call, { ref: "e1", option: "北京" }), /not found on the page/, "触发器什么也没展开，整页上也没有叫「北京」的控件");
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
