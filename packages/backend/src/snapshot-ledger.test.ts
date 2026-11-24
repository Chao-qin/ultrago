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
  assert.match(renderShownDelta(d), /1 of the 3 elements you were shown are gone · 1 hidden again/);
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

test("只有子帧跳转时，只作废那一帧的 ref，并说出是哪一帧", () => {
  const l = new ShownLedger();
  const page = [el("e1"), el("42_e1")];
  rec(l, "t", { "0": "top", "42": "a" }, page, refs(page));
  const d = rec(l, "t", { "0": "top", "42": "b" }, page, refs(page));
  assert.equal(d.fresh, undefined);
  assert.deepEqual(d.appeared, ["42_e1"], "子帧的新文档里的 e1 是另一个元素");
  assert.deepEqual(d.framesNavigated, ["42"]);
  assert.match(renderShownDelta(d), /1 frame\(s\) loaded a new document/);
});

test("大批元素消失时只报事实：几个不见了、哪些是新的，不替读者断定这是新页面", () => {
  const l = new ShownLedger();
  const before = Array.from({ length: 20 }, (_, i) => el(`e${i}`));
  rec(l, "t", DOC, before, refs(before));
  const after = [...before.slice(0, 5), ...Array.from({ length: 15 }, (_, i) => el(`e${100 + i}`))];
  const text = renderShownDelta(rec(l, "t", DOC, after, refs(after)));
  assert.match(text, /NEW to you: 15 \(first 12: e100, /);
  assert.match(text, /15 of the 20 elements you were shown are gone/);
  assert.doesNotMatch(text, /fresh page/);
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
  assert.deepEqual(d.framesNavigated, []);
});

test("CHANGED 比的是回复里那一行：行上显示的字段变了就报，行上看不出的不报", () => {
  const l = new ShownLedger();
  const group = (name) => el("e2", { role: "generic", tag: "div", container: true, name });
  rec(l, "t", DOC, [el("e1"), group("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十 尾巴甲")], ["e1", "e2"]);
  const d = rec(l, "t", DOC, [el("e1", { clickable: true }), group("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十 尾巴乙")], ["e1", "e2"]);
  assert.deepEqual(d.changed, ["e1"], "[clickable] 出现在行上；分组名第 30 字之后的变化行上看不到");
});

test("续读页不报 NEW（整页本来就没看过），但照报 CHANGED 与消失", () => {
  const l = new ShownLedger();
  rec(l, "t", DOC, [el("e1"), el("e2", { value: "a" })], ["e1", "e2"]);
  const d = rec(l, "t", DOC, [el("e2", { value: "b" }), el("e3")], ["e2", "e3"]);
  const text = renderShownDelta(d, { continuation: true });
  assert.doesNotMatch(text, /NEW to you/);
  assert.match(text, /CHANGED: e2 · 1 of the 2 elements you were shown are gone\.$/);
  assert.doesNotMatch(text, /earlier reply/, "续读页不能说其余都在之前的回复里");
});

// ---- the default reply: visible elements listed, hidden ones named by ref ----

const menuPage = [
  el("e1", { name: "首页" }),
  el("e2", { role: "button", tag: "button", name: "Language", controls: ["e3"] }),
  el("e3", { role: "menu", tag: "div", name: "Select a language", hidden: true }),
  el("e4", { role: "menuitemradio", tag: "a", name: "Python", hidden: true, parentRef: "e3" }),
  el("e5", { role: "menuitemradio", tag: "a", name: "Go", hidden: true, parentRef: "e3" }),
  el("e6", { name: "登录", hidden: true }),
  el("e7", { tag: "input", role: "file", name: "上传", hidden: true }),
  el("e8", { tag: "select", role: "combobox", name: "城市", hidden: true }),
];

test("默认回复只逐行列可见元素；隐藏的按 ref 点名：一组一行，落单的各一行，不按 tag 开例外", () => {
  const r = renderSnapshotView(menuPage);
  assert.deepEqual(r.shown, ["e1", "e2"]);
  assert.match(r.text, /Hidden right now \(6, not listed above; listed once visible\)/);
  assert.match(r.text, /^ {2}\[e3\] menu "Select a language" \[hidden\] — holds 3 hidden$/m);
  for (const line of ['[e6] link "登录" [hidden]', '[e7] file "上传" [hidden]', '[e8] combobox "城市" [hidden]'])
    assert.ok(r.text.includes(`\n  ${line}`), `落单的隐藏元素带 ref 点名：${line}`);
});

test("覆盖行：每次回复第一行说清列了多少、哪一段、隐藏多少，以及拿全量的确切调用", () => {
  assert.match(renderSnapshotView(menuPage).text, /^Coverage: 2 of the page's 8 elements listed here \(all 2 visible elements\) · 6 hidden, all named by ref under "Hidden right now" below · snapshot\(\{full: true\}\) lists every element, page by page\.\n/);
  const small = [el("e1"), el("e2")];
  assert.match(renderSnapshotView(small).text, /^Coverage: 2 of the page's 2 elements listed here \(all 2 visible elements\) · that is the whole page\.\n/);
  assert.match(renderSnapshotView(menuPage, { full: true }).text, /^Coverage: 8 of the page's 8 elements listed here \(all 8 elements, hidden ones included\) · that is the whole page\./);
  assert.match(renderSnapshotView([]).text, /^Coverage: the page has no interactable elements\.\n\n\(no interactable elements found/);
  assert.match(renderSnapshotView(menuPage, { within: "e99" }).text, /^Coverage: 0 of the page's 8 elements listed here \(\[e99\] is no longer on the page/);
});

test("覆盖行在 full 加过滤条件时写出过滤条件，并给出不带过滤的全量调用", () => {
  const text = renderSnapshotView(menuPage, { full: true, query: "python" }).text;
  assert.match(text, /^Coverage: 1 of the page's 8 elements listed here \(all 1 elements matching query="python"\) · snapshot\(\{full: true\}\) with no filter lists every element/);
});

test("覆盖行的区间只数页面元素：分组节点夹在中间时，full 翻页的区间不越过总数", () => {
  const page = Array.from({ length: 1200 }, (_, i) =>
    i % 3 === 0
      ? el(`g${i}`, { role: "generic", tag: "ul", name: `组 ${i}`, container: true, hiddenGroup: true, hidden: true })
      : el(`e${i}`, { name: `隐藏的链接 ${i} 这里是一段比较长的名字`, hidden: true, parentRef: `g${i - (i % 3)}` }),
  );
  let after;
  let last = "";
  for (let n = 0; n < 20; n++) {
    const r = renderSnapshotView(page, { full: true, after });
    last = r.text;
    const m = /^Coverage: (\d+) of the page's 800 elements listed here \((\d+)–(\d+) of 800 /.exec(r.text);
    assert.ok(m, r.text.split("\n")[0]);
    assert.ok(Number(m[3]) <= 800 && Number(m[3]) - Number(m[2]) + 1 === Number(m[1]), r.text.split("\n")[0]);
    after = /next page: snapshot\(\{after: "([^"]+)"/.exec(r.text)?.[1];
    if (!after) break;
  }
  assert.match(last, /–800 of 800 elements, hidden ones included/);
});

test("从头重来的那一页不是续读页：渲染器按实际起点报 continued", () => {
  assert.equal(renderSnapshotView(menuPage, { after: "e1" }).continued, true);
  assert.equal(renderSnapshotView(menuPage, { after: "e4" }).continued, false, "e4 隐藏了，从第一个重来");
  assert.equal(renderSnapshotView(menuPage).continued, false);
});

test("账本不记隐藏分组：full 列过分组节点，菜单展开后分组消失不算元素消失", () => {
  const l = new ShownLedger();
  const closed = [el("e1"), el("g1", { role: "generic", tag: "ul", container: true, hiddenGroup: true, hidden: true }), el("e2", { hidden: true, parentRef: "g1" }), el("e3", { hidden: true, parentRef: "g1" })];
  rec(l, "t", DOC, closed, refs(closed));
  const open = [el("e1"), el("e2"), el("e3")];
  const d = rec(l, "t", DOC, open, refs(open));
  assert.equal(d.gone, 0);
});

test("隐藏分组节点：默认不列、不计数，摘要用它的 ref 代表整组；可见的分组（关着的 details）也一样", () => {
  const page = [
    el("e1"),
    el("e2", { role: "generic", tag: "details", name: "更多选项", container: true, hiddenGroup: true }),
    el("e3", { role: "button", tag: "summary", name: "更多选项", parentRef: "e2" }),
    el("e4", { name: "导出", hidden: true, parentRef: "e2" }),
    el("e5", { name: "删除", hidden: true, parentRef: "e2" }),
  ];
  const r = renderSnapshotView(page);
  assert.deepEqual(r.shown, ["e1", "e3"], "details 自己可见，但它只是分组，不是控件");
  assert.match(r.text, /^Coverage: 2 of the page's 4 elements/, "分组节点不算页面元素");
  assert.match(r.text, /Hidden right now \(2,/);
  assert.match(r.text, /^ {2}\[e2\] generic "更多选项" \(group\) — holds 2 hidden$/m);
  assert.deepEqual(renderSnapshotView(page, { within: "e2" }).shown, ["e2", "e3", "e4", "e5"]);
});

test("within 展开一组（含它通过 controls 打开的面板），隐藏的也列出", () => {
  const byButton = renderSnapshotView(menuPage, { within: "e2" });
  assert.deepEqual(byButton.shown, ["e2", "e3", "e4", "e5"]);
  assert.match(byButton.text, /\[e4\] menuitemradio "Python" \[hidden\]/);
  assert.match(byButton.text, /^Coverage: 4 of the page's 8 elements listed here \(all 4 elements matching within \[e2\]\)/);
  assert.match(renderSnapshotView(menuPage, { within: "e99" }).text, /\[e99\] is no longer on the page/);
});

test("full 与 query 都不折叠：一个要全部，一个在搜隐藏的也算", () => {
  const full = renderSnapshotView(menuPage, { full: true });
  assert.equal(full.shown.length, 8);
  assert.doesNotMatch(full.text, /Hidden right now/);
  assert.deepEqual(renderSnapshotView(menuPage, { query: "python" }).shown, ["e4"]);
});

test("全是隐藏元素时如实说没有可见的，并点名隐藏的；续读页不重复摘要，但从头重来的那一页要有", () => {
  const hiddenOnly = renderSnapshotView([el("e1", { hidden: true }), el("e2", { hidden: true })]);
  assert.match(hiddenOnly.text, /\n\n\(no visible interactable elements right now\)\n\nHidden right now \(2/);
  assert.deepEqual(hiddenOnly.shown, []);
  assert.doesNotMatch(renderSnapshotView(menuPage, { after: "e1" }).text, /Hidden right now/);
  const restarted = renderSnapshotView(menuPage, { after: "e4" }).text;
  assert.match(restarted, /\[e4\] is hidden now, so this starts again from the first element/);
  assert.match(restarted, /Hidden right now \(6/, "从头重来就是第一页，摘要不能丢");
});

test("viewportOnly 下视口里只有隐藏元素时，说的是这个过滤条件下没有，不说整页没有可见的", () => {
  const page = [el("e1", { inViewport: false }), el("e2", { hidden: true, inViewport: true })];
  const text = renderSnapshotView(page, { viewportOnly: true }).text;
  assert.match(text, /\(nothing to show for viewportOnly\)/);
  assert.doesNotMatch(text, /no visible interactable elements right now/);
  assert.match(text, /Hidden right now \(1/);
});

test("翻页时只把这一页实际列出的 ref 交给账本；续读调用把 full 与过滤条件原样带上", () => {
  const big = Array.from({ length: 3000 }, (_, i) => el(`e${i}`, { name: `职位 ${i} 广州 前端开发工程师 薪资面议`, hidden: i % 2 === 1 }));
  const first = renderSnapshotView(big);
  const printed = [...first.text.matchAll(/^\[(e\d+)\]/gm)].map((m) => m[1]);
  assert.ok(first.shown.length > 0 && first.shown.length < 1500, "默认视图要分页");
  assert.deepEqual(first.shown, printed, "shown 必须正好是回复里印出来的 ref");
  assert.match(renderSnapshotView(big, { full: true }).text, /next page: snapshot\(\{after: "e\d+", full: true\}\)/, "续读要带 full: true，否则第 2 页又会折叠");
  assert.match(renderSnapshotView(big, { query: "广州", viewportOnly: false, limit: 5 }).text, /next page: snapshot\(\{after: "e\d+", query: "广州", limit: 5\}\)/);
});

test("摘要按预算点名：组按大小排在前，落单的按文档顺序，超出预算的给出数量与取法", () => {
  const groups = Array.from({ length: 10 }, (_, g) => [
    el(`g${g}`, { role: "menu", name: `menu ${g}`, hidden: true }),
    ...Array.from({ length: g + 1 }, (_, i) => el(`g${g}_${i}`, { hidden: true, parentRef: `g${g}` })),
  ]).flat();
  const lone = Array.from({ length: 200 }, (_, i) => el(`h${i}`, { name: `隐藏的链接 ${i} 这里是一段比较长的名字`, hidden: true }));
  const text = renderSnapshotView([el("e1"), ...groups, ...lone]).text;
  const lines = [...text.matchAll(/^ {2}\[(g\d+)\] menu/gm)].map((m) => m[1]);
  assert.deepEqual(lines, ["g9", "g8", "g7", "g6", "g5", "g4", "g3", "g2", "g1", "g0"]);
  assert.match(text, /^ {2}\[h0\] link/m, "落单的紧跟在组后面");
  // 10 groups hold their menu plus g+1 items each (65); 200 lone ones follow.
  const named = 65 + [...text.matchAll(/^ {2}\[h\d+\]/gm)].length;
  assert.ok(named < 265, "200 个落单的超出了摘要预算");
  assert.match(text, new RegExp(`^ {2}… ${265 - named} more hidden, counted but not named here — query searches them`, "m"));
  assert.match(text, new RegExp(`^Coverage: .* · 265 hidden: ${named} named by ref under "Hidden right now" below, ${265 - named} only counted there`), "覆盖行不能说全都点了名");
});

test("query 只按元素自己的名字找：包住它的 (group) 与隐藏分组不跟着命中，覆盖行与正文一致", () => {
  const page = [
    el("g1", { role: "generic", tag: "div", container: true, name: "首页 Deutsch 设置" }),
    el("e1", { name: "首页", parentRef: "g1" }),
    el("e2", { name: "Deutsch", parentRef: "g1" }),
    el("h1", { role: "generic", tag: "ul", container: true, hiddenGroup: true, hidden: true, name: "العربية Deutsch Dansk" }),
    el("e3", { name: "العربية", hidden: true, parentRef: "h1" }),
  ];
  assert.deepEqual(renderSnapshotView(page, { query: "deutsch" }).shown, ["e2"], "不返回包住它的分组");
  const inGroup = renderSnapshotView(page, { within: "h1", query: "deutsch" });
  assert.deepEqual(inGroup.shown, []);
  assert.match(inGroup.text, /^Coverage: 0 of the page's 4 elements listed here \(none of 0 elements matching within \[h1\] query="deutsch"\)/);
  assert.doesNotMatch(inGroup.text, /^\[h1\]/m, "正文不能印出覆盖行说没列的分组");
});

test("query 一个元素也没命中时，回复给出这段文字在页面上的事实：在哪个元素里、在正文里、是否隐藏；根本不在页面上也如实说", () => {
  const page = [el("e64", { name: "Liste der Länder – German" }), el("e2", { name: "首页" })];
  const hits = { count: 3, samples: [{ text: "Deutsch", ref: "e64" }, { text: "Iceland 387,758", hidden: true }] };
  const text = renderSnapshotView(page, { query: "Deutsch" }, hits).text;
  assert.match(text, /\(no element's role, name, value or options contain "Deutsch"\)\nThe words occur 3 time\(s\) in the page's text:\n {2}inside \[e64\]: "Deutsch"\n {2}in page text \(hidden\): "Iceland 387,758"\n {2}… 1 more\nAct on the element they are inside/);
  assert.match(renderSnapshotView(page, { query: "zz" }, { count: 0, samples: [] }).text, /The words are not in the page's text either — the content may not have loaded yet/);
});
