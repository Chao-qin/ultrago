/**
 * The navigation orderings, asserted against fake tabs/webNavigation.
 *
 * Timings are injected and tiny, so these run in milliseconds while still
 * exercising the real announce → commit → complete sequence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNav, type TabLike, type TabsApi, type WebNavigationApi } from "./nav-wait";

function fakeBrowser(tab: TabLike = { url: "https://old/", title: "old", status: "complete" }) {
  const updated = new Set<(id: number, info: { status?: string }, t: TabLike) => void>();
  const before = new Set<(d: { tabId: number; frameId: number }) => void>();
  const committed = new Set<(d: { tabId: number; frameId: number; url: string; transitionType: string; transitionQualifiers?: string[] }) => void>();
  let current = { ...tab };
  const updates: Array<{ tabId: number; url: string }> = [];
  let getFails: Error | null = null;
  let updateFails: Error | null = null;

  const tabs: TabsApi = {
    onUpdated: {
      addListener: (l) => void updated.add(l),
      removeListener: (l) => void updated.delete(l),
    },
    async get() {
      if (getFails) throw getFails;
      return current;
    },
    async update(tabId, o) {
      if (updateFails) throw updateFails;
      updates.push({ tabId, url: o.url });
      return undefined;
    },
  };
  const webNavigation: WebNavigationApi = {
    onBeforeNavigate: { addListener: (l) => void before.add(l), removeListener: (l) => void before.delete(l) },
    onCommitted: { addListener: (l) => void committed.add(l), removeListener: (l) => void committed.delete(l) },
    async getAllFrames() {
      return [{ frameId: 0, url: "https://x/" }, { frameId: 42, url: "https://x/iframe" }];
    },
  };
  return {
    tabs,
    webNavigation,
    updates,
    get listenerCount() {
      return updated.size + before.size + committed.size;
    },
    setTab: (t: TabLike) => void (current = { ...t }),
    failGet: (e: Error | null) => void (getFails = e),
    failUpdate: (e: Error | null) => void (updateFails = e),
    announce: (tabId = 1, frameId = 0) => before.forEach((l) => l({ tabId, frameId })),
    commit: (tabId = 1, frameId = 0, url = "https://new/", transitionType = "link", q?: string[]) =>
      committed.forEach((l) => l({ tabId, frameId, url, transitionType, transitionQualifiers: q })),
    complete: (tabId = 1, t: TabLike = { url: "https://new/", title: "new", status: "complete" }) =>
      updated.forEach((l) => l(tabId, { status: "complete" }, t)),
  };
}

const nav = (f: ReturnType<typeof fakeBrowser>, watched: number[] = []) =>
  createNav(
    { tabs: f.tabs, webNavigation: f.webNavigation, markWatched: (t) => void watched.push(t) },
    { barrierMs: 60, announceMs: 20 },
  );

test("什么都没宣告 → 报 navigated:false，而不是假装成功", async () => {
  const f = fakeBrowser();
  const r = await nav(f).historyNav(1, async () => {});
  assert.deepEqual(r, { ok: true, navigated: false });
});

test("宣告了但还没提交 → 继续等 barrier，而不是当成没发生", async () => {
  const f = fakeBrowser();
  const p = nav(f).historyNav(1, async () => {
    f.announce();
  });
  // Commit arrives well after the announce window (20ms) but inside the barrier.
  await new Promise((r) => setTimeout(r, 35));
  f.commit();
  f.setTab({ url: "https://new/", title: "new", status: "complete" });
  f.complete();
  const r = await p;
  assert.equal(r.navigated, true, "「什么都没发生」这个答案会让 agent 再做一次");
  assert.equal(r.url, "https://new/");
});

test("url 以 tab 当前值为准，commit 的 url 只是兜底", async () => {
  const f = fakeBrowser();
  f.failGet(new Error("tab gone")); // 读不到 tab 时才回落到 commit 的 url
  const r = await nav(f).historyNav(1, async () => {
    f.announce();
    f.commit(1, 0, "https://from-commit/");
  });
  assert.equal(r.url, "https://from-commit/");
});

test("提交后要等 complete，并带回 transition", async () => {
  const f = fakeBrowser();
  const p = nav(f).historyNav(1, async () => {
    f.announce();
    f.commit(1, 0, "https://new/", "reload", ["forward_back"]);
  });
  f.setTab({ url: "https://new/", title: "new", status: "complete" });
  f.complete();
  const r = await p;
  assert.equal(r.transition, "reload+forward_back");
  assert.equal(r.title, "new");
});

test("超时时没等到 complete，就不报 title —— 那会是旧文档的", async () => {
  const f = fakeBrowser();
  f.setTab({ url: "https://new/", title: "STALE-OLD-TITLE", status: "loading" });
  const r = await nav(f).historyNav(1, async () => {
    f.announce();
    f.commit();
  });
  assert.equal(r.navigated, true);
  assert.equal("title" in r, false, "宁可不给，也不能把旧文档的标题当成新页面的");
  assert.equal(r.url, "https://new/");
});

test("只认本 tab 的顶层 frame —— 子 frame 和别的 tab 都不算", async () => {
  const f = fakeBrowser();
  const p = nav(f).historyNav(1, async () => {
    f.announce(2, 0); // 另一个 tab
    f.announce(1, 42); // 本 tab 的 iframe
    f.commit(1, 42, "https://iframe/"); // iframe 的提交
  });
  const r = await p;
  assert.deepEqual(r, { ok: true, navigated: false });
});

test("无论走哪条路径，监听器都要摘干净", async () => {
  const f = fakeBrowser();
  const n = nav(f);
  await n.historyNav(1, async () => {});
  assert.equal(f.listenerCount, 0, "no-op 路径泄漏了监听器");

  const p = n.historyNav(1, async () => {
    f.announce();
    f.commit();
  });
  f.complete();
  await p;
  assert.equal(f.listenerCount, 0, "成功路径泄漏了监听器");
});

test("act 抛错时也要摘干净监听器", async () => {
  const f = fakeBrowser();
  await assert.rejects(() => nav(f).historyNav(1, async () => {
    throw new Error("goBack failed");
  }));
  assert.equal(f.listenerCount, 0);
});

test("waitTabComplete：ignoreCurrentStatus 时不信当前状态", async () => {
  const f = fakeBrowser();
  f.setTab({ status: "complete" }); // 旧文档报的 complete
  const n = nav(f);

  let settled = false;
  void n.waitTabComplete(1, 60, true).then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(settled, false, "宣告之后 tab 报的仍是旧文档的 complete，信它等于没等");

  f.complete();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(settled, true);
});

test("waitTabComplete：不忽略当前状态时，已完成的 tab 立即返回", async () => {
  const f = fakeBrowser();
  f.setTab({ status: "complete" });
  await nav(f).waitTabComplete(1, 60);
});

test("waitTabComplete：tabs.get 失败也要放行，不能永远挂着", async () => {
  const f = fakeBrowser();
  f.failGet(new Error("no such tab"));
  await nav(f).waitTabComplete(1, 60);
});

test("navigateAndWait：complete 时带回真实 url/title，并登记为 driven", async () => {
  const f = fakeBrowser();
  const watched: number[] = [];
  const p = nav(f, watched).navigateAndWait(1, "https://target/");
  f.complete(1, { url: "https://target/final", title: "T", status: "complete" });
  assert.deepEqual(await p, { tabId: 1, url: "https://target/final", title: "T" });
  assert.deepEqual(watched, [1], "登记要发生在导航本身，而不是第一次读页面时");
  assert.deepEqual(f.updates, [{ tabId: 1, url: "https://target/" }]);
});

test("navigateAndWait：update 失败要 reject 并摘掉监听器", async () => {
  const f = fakeBrowser();
  f.failUpdate(new Error("cannot navigate"));
  await assert.rejects(() => nav(f).navigateAndWait(1, "https://target/"), /cannot navigate/);
  assert.equal(f.listenerCount, 0);
});

test("navigateAndWait：超时后回落到读 tab 当前状态", async () => {
  const f = fakeBrowser();
  f.setTab({ url: "https://target/slow", title: "slow", status: "loading" });
  const r = await nav(f).navigateAndWait(1, "https://target/");
  assert.deepEqual(r, { tabId: 1, url: "https://target/slow", title: "slow" });
});

test("liveFrames：列出当前 frame，顶层标出来", async () => {
  const f = fakeBrowser();
  const r = await nav(f).liveFrames(1);
  assert.deepEqual(r?.ids, [0, 42]);
  assert.match(r!.listing, /0 \(top\)/);
});
