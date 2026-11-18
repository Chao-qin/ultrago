/**
 * The task-window rules, asserted against a fake windows API.
 *
 * Each case corresponds to a comment in window-ops.ts, i.e. to a way this once
 * went wrong on a real desktop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openWindow, type WindowApi, type WindowLike } from "./window-ops";

type Call = { fn: string; args: unknown[] };

/** A windows API that records what was asked of it, in order. */
function fakeWindows(over: Partial<{ created: WindowLike; lastFocused: WindowLike; got: (id: number) => WindowLike }> = {}) {
  const calls: Call[] = [];
  const created: WindowLike = over.created ?? { id: 20, tabs: [{ id: 200, url: "about:blank" }] };
  const api: WindowApi = {
    async getLastFocused(opts) {
      calls.push({ fn: "getLastFocused", args: [opts] });
      if (!over.lastFocused) throw new Error("no last focused");
      return over.lastFocused;
    },
    async create(opts) {
      calls.push({ fn: "create", args: [opts] });
      return created;
    },
    async update(id, opts) {
      calls.push({ fn: "update", args: [id, opts] });
      return undefined;
    },
    async get(id) {
      calls.push({ fn: "get", args: [id] });
      return over.got ? over.got(id) : { id, left: 1, top: 2, width: 3, height: 4, state: "normal" };
    },
  };
  return { api, calls, names: () => calls.map((c) => c.fn) };
}

function deps(api: WindowApi) {
  const watched: number[] = [];
  return { d: { windows: api, markWatched: async (t: number) => void watched.push(t) }, watched };
}

test("restoreFocus：先记下用户的窗口，再创建，然后把它提回前面", async () => {
  const f = fakeWindows({ lastFocused: { id: 9 } });
  const { d } = deps(f.api);
  await openWindow(d, { url: "https://x/", restoreFocus: true });

  const order = f.names();
  assert.equal(order[0], "getLastFocused", "必须在 create 之前快照 —— 之后就没有可恢复的目标了");
  assert.equal(order[1], "create");
  const raise = f.calls.find((c) => c.fn === "update" && c.args[0] === 9);
  assert.deepEqual(raise?.args[1], { focused: true }, "用户原来的窗口没被提回前面");
});

test("不要 restoreFocus 时就不去打听焦点窗口", async () => {
  const f = fakeWindows({ lastFocused: { id: 9 } });
  const { d } = deps(f.api);
  await openWindow(d, { url: "https://x/" });
  assert.equal(f.names().includes("getLastFocused"), false);
});

test("macOS 兜底：新窗口仍占着焦点时，显式把它按下去", async () => {
  const f = fakeWindows({ lastFocused: { id: 9 }, got: (id) => ({ id, focused: true }) });
  const { d } = deps(f.api);
  await openWindow(d, { url: "https://x/", restoreFocus: true });

  const push = f.calls.filter((c) => c.fn === "update" && c.args[0] === 20 && (c.args[1] as { focused?: boolean }).focused === false);
  assert.equal(push.length, 1, "新窗口抢了前台却没有被按下去");
});

test("创建后要重新 assert bounds —— create 时的坐标只是建议", async () => {
  const f = fakeWindows();
  const { d } = deps(f.api);
  await openWindow(d, { url: "https://x/", left: -3000, top: 10, width: 800, height: 600 });

  const reassert = f.calls.find(
    (c) => c.fn === "update" && c.args[0] === 20 && (c.args[1] as WindowBoundsish).left === -3000,
  );
  assert.ok(reassert, "Chrome 会把完全离屏的窗口拉回屏内，不重新要一次就拿不到最好的位置");
});
type WindowBoundsish = { left?: number };

test("没给任何坐标时，不发多余的 bounds 更新", async () => {
  const f = fakeWindows();
  const { d } = deps(f.api);
  await openWindow(d, { url: "https://x/" });
  const boundsUpdates = f.calls.filter(
    (c) => c.fn === "update" && (c.args[1] as WindowBoundsish).left !== undefined,
  );
  assert.equal(boundsUpdates.length, 0);
});

test("窗口状态两个方向都要显式钉住", async () => {
  for (const [minimized, want] of [[false, "normal"], [true, "minimized"]] as const) {
    const f = fakeWindows();
    const { d } = deps(f.api);
    await openWindow(d, { url: "https://x/", minimized });
    const pin = f.calls.find((c) => c.fn === "update" && (c.args[1] as { state?: string }).state !== undefined);
    assert.equal(
      (pin?.args[1] as { state?: string }).state,
      want,
      "不钉死就可能拿到 minimized —— Chrome 视其为 hidden，渲染停、定时器被重压",
    );
  }
});

test("创建出来的窗口没有 tab 时抛错，而不是交回 -1", async () => {
  const f = fakeWindows({ created: { id: 20, tabs: [] } });
  const { d } = deps(f.api);
  await assert.rejects(
    () => openWindow(d, { url: "https://x/" }),
    /has no tab to work in/,
    "-1 能满足 tabId:number，于是一路无人质疑，故障会在三层之外才浮现",
  );
});

test("登记 watched 发生在返回之前，且拿的是真实 tabId", async () => {
  const f = fakeWindows();
  const { d, watched } = deps(f.api);
  const r = await openWindow(d, { url: "https://x/" });
  assert.deepEqual(watched, [200], "登记必须早于第一次导航");
  assert.equal(r.tabId, 200);
  assert.equal(r.windowId, 20);
});

test("回报窗口实际落到的位置，而不是请求的位置", async () => {
  const f = fakeWindows({ got: (id) => ({ id, left: 0, top: 0, width: 1024, height: 768, state: "normal" }) });
  const { d } = deps(f.api);
  const r = await openWindow(d, { url: "https://x/", left: -3000, width: 800 });
  assert.deepEqual(r.bounds, { left: 0, top: 0, width: 1024, height: 768, state: "normal" });
});

test("getLastFocused 抛错不影响开窗", async () => {
  const f = fakeWindows(); // lastFocused 未设置 → getLastFocused 抛错
  const { d } = deps(f.api);
  const r = await openWindow(d, { url: "https://x/", restoreFocus: true });
  assert.equal(r.tabId, 200, "打听不到焦点窗口是可接受的，不该让开窗失败");
});
