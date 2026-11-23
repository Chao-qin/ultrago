// @ts-nocheck — fixtures are minimal snapshot shapes
/**
 * What an observer has been shown, and what a default snapshot reply shows.
 *
 * The ledger replaced two approximations that disagreed with the reply: "not in the DOM at the last read" (which
 * missed a menu that was rendered up front and merely hidden) and a per-tab "the last reply was partial" flag
 * (which knew THAT something was left out, never WHAT). Each test here is a way those two used to be wrong.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { renderShownDelta, renderSnapshotView } from "./browser-mcp-render.js";
import { ShownLedger } from "./snapshot-ledger.js";

const el = (ref: string, extra = {}) => ({ ref, tag: "a", role: "link", name: `n${ref}`, ...extra });
const DOC = { "0": "d1" };
const refs = (els) => els.map((e) => e.ref);
/** A read whose reply was delivered. */
const rec = (l, key, docs, els, shown, opts) => {
  const r = l.read(key, docs, els, shown, opts);
  r.commit();
  return r.diff;
};

test("第一次读没有可比的，不报任何增量", () => {
  const l = new ShownLedger();
  const page = [el("e1"), el("e2")];
  const d = rec(l, "t", DOC, page, refs(page));
  assert.equal(d.fresh, "first");
  assert.equal(renderShownDelta(d), "");
});

test("预先渲染、只靠 CSS 藏起来的菜单展开后，算作新出现", () => {
  const l = new ShownLedger();
  const closed = [el("e1"), el("e2", { hidden: true })];
  rec(l, "t", DOC, closed, ["e1"]);
  const open = [el("e1"), el("e2")];
  const d = rec(l, "t", DOC, open, refs(open));
  assert.deepEqual(d.appeared, ["e2"], "e2 一直在 DOM 里，但从没展示给过这个 agent");
  assert.match(renderShownDelta(d), /NEW to you: e2 — start with those; everything else listed here was in an earlier reply/);
});

test("分页或 query 没列出的元素不算读过", () => {
  const l = new ShownLedger();
  const page = [el("e1"), el("e2"), el("e3")];
  rec(l, "t", DOC, page, ["e2"]);
  const d = rec(l, "t", DOC, page, refs(page));
  assert.deepEqual(d.appeared, ["e1", "e3"]);
  const again = rec(l, "t", DOC, page, ["e1"]);
  assert.deepEqual(again.appeared, [], "上次列过的，下次被过滤掉也仍算见过");
  assert.equal(again.gone, 0);
});

test("状态变了的已展示元素报 CHANGED；只是滚动（坐标、是否在视口）不算变化", () => {
  const l = new ShownLedger();
  rec(l, "t", DOC, [el("e1", { expanded: false, rect: [0, 0, 1, 1], inViewport: true })], ["e1"]);
  const scrolled = rec(l, "t", DOC, [el("e1", { expanded: false, rect: [0, 500, 1, 1], inViewport: false })], ["e1"]);
  assert.deepEqual(scrolled.changed, []);
  const opened = rec(l, "t", DOC, [el("e1", { expanded: true })], ["e1"]);
  assert.deepEqual(opened.changed, ["e1"]);
  assert.match(renderShownDelta(opened), /CHANGED: e1/);
});

test("消失与重新隐藏分开计；隐藏后再显示算新出现", () => {
  const l = new ShownLedger();
  rec(l, "t", DOC, [el("e1"), el("e2"), el("e3")], ["e1", "e2", "e3"]);
  const d = rec(l, "t", DOC, [el("e1"), el("e2", { hidden: true })], ["e1"]);
  assert.equal(d.gone, 1);
  assert.equal(d.hiddenAgain, 1);
  assert.match(renderShownDelta(d), /1 gone · 1 hidden again/);
  const back = rec(l, "t", DOC, [el("e1"), el("e2")], ["e1", "e2"]);
  assert.deepEqual(back.appeared, ["e2"], "关掉再打开的菜单，项目要再指给 agent 看");
});

test("整页跳转后，新页面的同名 ref 不被当成读过", () => {
  const l = new ShownLedger();
  const page = [el("e1"), el("e2")];
  rec(l, "t", DOC, page, refs(page));
  const d = rec(l, "t", { "0": "d2" }, page, refs(page));
  assert.equal(d.fresh, "navigated");
  assert.deepEqual(d.appeared, []);
  assert.match(renderShownDelta(d), /New document since your last snapshot .* refs from earlier replies no longer apply/);
  assert.doesNotMatch(renderShownDelta(d), /earlier reply\./, "不能说其余都在之前的回复里");
});

test("只有子帧跳转时，只作废那一帧的 ref", () => {
  const l = new ShownLedger();
  const page = [el("e1"), el("42_e1")];
  rec(l, "t", { "0": "top", "42": "a" }, page, refs(page));
  const d = rec(l, "t", { "0": "top", "42": "b" }, page, refs(page));
  assert.equal(d.fresh, undefined);
  assert.deepEqual(d.appeared, ["42_e1"], "子帧的新文档里的 e1 是另一个元素");
  assert.equal(d.framesNavigated, 1);
  assert.match(renderShownDelta(d), /1 frame\(s\) loaded a new document/);
});

test("大部分已展示元素消失时，当作新页面读，不罗列几百个消失和新增", () => {
  const l = new ShownLedger();
  const before = Array.from({ length: 20 }, (_, i) => el(`e${i}`));
  rec(l, "t", DOC, before, refs(before));
  const after = [...before.slice(0, 5), ...Array.from({ length: 15 }, (_, i) => el(`e${100 + i}`))];
  const text = renderShownDelta(rec(l, "t", DOC, after, refs(after)));
  assert.match(text, /15 of the 20 elements you were shown are gone .* read this as a fresh page/);
  assert.doesNotMatch(text, /NEW to you/);
});

test("旧扩展不带 docs 时什么也不比，之后有 docs 的一次按首次读", () => {
  const l = new ShownLedger();
  const page = [el("e1")];
  rec(l, "t", DOC, page, refs(page));
  const legacy = rec(l, "t", undefined, page, refs(page));
  assert.equal(legacy.fresh, "first");
  assert.equal(renderShownDelta(legacy), "");
  assert.equal(rec(l, "t", DOC, page, refs(page)).fresh, "first", "没有 docs 的那次把记录清掉了");
});

test("reset 当作首次读；不同键互不影响；超过上限时忘掉最久没读的标签页", () => {
  const l = new ShownLedger(1);
  rec(l, "a", DOC, [el("e1")], ["e1"]);
  assert.equal(rec(l, "a", DOC, [el("e1")], ["e1"], { reset: true }).fresh, "first");
  assert.equal(rec(l, "b", DOC, [el("e1")], ["e1"]).fresh, "first", "另一个标签页有自己的记录");
  assert.equal(rec(l, "a", DOC, [el("e1")], ["e1"]).fresh, "first", "a 已被挤出");
});

test("回复没送达（没有 commit）时不记账：下一次照样算新", () => {
  const l = new ShownLedger();
  rec(l, "t", DOC, [el("e1")], ["e1"]);
  l.read("t", DOC, [el("e1"), el("e2")], ["e1", "e2"]); // the tool failed after rendering
  assert.deepEqual(rec(l, "t", DOC, [el("e1"), el("e2")], ["e1", "e2"]).appeared, ["e2"]);
});

test("query 列出过的隐藏元素，下一次默认读不报 hidden again；被列出的隐藏 input 每次读都不算新", () => {
  const l = new ShownLedger();
  const page = [el("e1"), el("e2", { hidden: true }), el("e3", { tag: "input", hidden: true })];
  rec(l, "t", DOC, page, ["e1", "e3"]);
  rec(l, "t", DOC, page, ["e2"]); // snapshot({query}) listed the hidden e2
  const d = rec(l, "t", DOC, page, ["e1", "e3"]);
  assert.equal(d.hiddenAgain, 0, "e2 一直是隐藏的，没有变化");
  assert.deepEqual(d.appeared, []);
  assert.deepEqual(d.changed, []);
});

test("值变了、隐藏状态翻转了都算 CHANGED", () => {
  const l = new ShownLedger();
  rec(l, "t", DOC, [el("e1", { value: "a" }), el("e2", { tag: "input", hidden: true })], ["e1", "e2"]);
  const d = rec(l, "t", DOC, [el("e1", { value: "ab" }), el("e2", { tag: "input" })], ["e1", "e2"]);
  assert.deepEqual(d.changed, ["e1", "e2"]);
  const back = rec(l, "t", DOC, [el("e1", { value: "ab" }), el("e2", { tag: "input", hidden: true })], ["e1", "e2"]);
  assert.deepEqual([back.changed, back.appeared, back.hiddenAgain], [["e2"], [], 0], "照常列出的 input 变隐藏是状态变化，不是消失再出现");
});

test("整个子帧消失时，它的 ref 计为 gone，不算子帧跳转", () => {
  const l = new ShownLedger();
  rec(l, "t", { "0": "top", "42": "a" }, [el("e1"), el("42_e1")], ["e1", "42_e1"]);
  const d = rec(l, "t", { "0": "top" }, [el("e1")], ["e1"]);
  assert.equal(d.gone, 1);
  assert.equal(d.framesNavigated, 0);
});

// ---- the default reply: hidden elements are summarised, not listed ----

const menuPage = [
  el("e1", { name: "首页" }),
  el("e2", { role: "button", tag: "button", name: "Language", controls: ["e3"] }),
  el("e3", { role: "menu", tag: "div", name: "Select a language", hidden: true }),
  el("e4", { role: "menuitemradio", tag: "a", name: "Python", hidden: true, parentRef: "e3" }),
  el("e5", { role: "menuitemradio", tag: "a", name: "Go", hidden: true, parentRef: "e3" }),
  el("e6", { name: "登录", hidden: true }),
  el("e7", { tag: "input", role: "button", name: "上传", hidden: true }),
  el("e8", { tag: "select", role: "combobox", name: "城市", hidden: true }),
  el("e9", { tag: "textarea", role: "textbox", name: "{\"hotsearch\": …}", hidden: true }),
];

test("默认回复把隐藏元素收进摘要：按隐藏子树归组，零散的给出名字；隐藏的 input / select 照常列出", () => {
  const r = renderSnapshotView(menuPage);
  assert.deepEqual(r.shown, ["e1", "e2", "e7", "e8"], "上传与原生下拉是 upload_file / select_option 的目标");
  assert.doesNotMatch(r.text, /^\s*\[e4\]/m);
  assert.match(r.text, /Hidden right now \(5, not listed above; listed once visible\)/);
  assert.match(r.text, /\[e3\] menu "Select a language" — 3 hidden elements/);
  assert.match(r.text, /2 more hidden, e\.g\. "登录"/, "隐藏的 textarea 是页面存数据用的，不单独列出");
});

test("within 展开一组（含它通过 controls 打开的面板），隐藏的也列出", () => {
  const byButton = renderSnapshotView(menuPage, { within: "e2" });
  assert.deepEqual(byButton.shown, ["e2", "e3", "e4", "e5"]);
  assert.match(byButton.text, /\[e4\] menuitemradio "Python" \[hidden\]/);
  assert.match(byButton.text, /4 of 9 elements match within \[e2\]/);
  assert.match(renderSnapshotView(menuPage, { within: "e99" }).text, /\[e99\] is no longer on the page/);
});

test("full 与 query 都不折叠：一个要全部，一个在搜隐藏的也算", () => {
  const full = renderSnapshotView(menuPage, { full: true });
  assert.equal(full.shown.length, 9);
  assert.doesNotMatch(full.text, /Hidden right now/);
  assert.deepEqual(renderSnapshotView(menuPage, { query: "python" }).shown, ["e4"]);
});

test("全是隐藏元素时如实说没有可操作的，并给出摘要；翻页时摘要不重复", () => {
  const hiddenOnly = renderSnapshotView([el("e1", { hidden: true }), el("e2", { hidden: true })]);
  assert.match(hiddenOnly.text, /^\(no visible interactable elements right now\)\n\nHidden right now \(2/);
  assert.deepEqual(hiddenOnly.shown, []);
  assert.doesNotMatch(renderSnapshotView(menuPage, { after: "e1" }).text, /Hidden right now/);
});

test("翻页时只把这一页实际列出的 ref 交给账本；full 翻页时续读提示带着 full", () => {
  const big = Array.from({ length: 3000 }, (_, i) => el(`e${i}`, { name: `职位 ${i} 广州 前端开发工程师 薪资面议`, hidden: i % 2 === 1 }));
  const first = renderSnapshotView(big);
  const printed = [...first.text.matchAll(/^\[(e\d+)\]/gm)].map((m) => m[1]);
  assert.ok(first.shown.length > 0 && first.shown.length < 1500, "默认视图要分页");
  assert.deepEqual(first.shown, printed, "shown 必须正好是回复里印出来的 ref");
  const full = renderSnapshotView(big, { full: true });
  const next = /after: "(e\d+)", full: true/.exec(full.text)?.[1];
  assert.ok(next, "续读提示要带 full: true，否则第 2 页又会折叠");
  assert.match(renderSnapshotView(big, { after: "e1" }).text, /\[e1\] is hidden now, so this starts again/);
});

test("摘要最多 8 组、按大小排，其余并成一行", () => {
  const groups = Array.from({ length: 10 }, (_, g) => [
    el(`g${g}`, { role: "menu", name: `menu ${g}`, hidden: true }),
    ...Array.from({ length: g + 1 }, (_, i) => el(`g${g}_${i}`, { hidden: true, parentRef: `g${g}` })),
  ]).flat();
  const text = renderSnapshotView([el("e1"), ...groups]).text;
  const lines = [...text.matchAll(/^ {2}\[(g\d+)\] menu/gm)].map((m) => m[1]);
  assert.deepEqual(lines, ["g9", "g8", "g7", "g6", "g5", "g4", "g3", "g2"]);
  assert.match(text, /^ {2}5 more hidden, e\.g\. "menu 0", "ng0_0", "menu 1"/m, "g1 (3 个) 与 g0 (2 个) 不在前 8 组里，按文档顺序给名字");
});
