/**
 * The readiness signal's rules, pinned.
 *
 * Each case corresponds to a comment in net-idle.ts explaining why the code is
 * shaped the way it is — which is to say, to something that was once wrong.
 * The clock is injected, so these assert on logic rather than on sleeping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNetIdleTracker, type NetIdleOptions } from "./net-idle";

/** A tracker driven by a clock the test moves by hand. */
function harness(over: NetIdleOptions = {}) {
  let t = 1_000_000;
  const slept: number[] = [];
  const tracker = createNetIdleTracker({
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms; // time only advances when the waiter sleeps
    },
    ...over,
  });
  return {
    tracker,
    slept,
    advance: (ms: number) => {
      t += ms;
    },
    get now() {
      return t;
    },
    /** Watch a tab from its main_frame, document request finished — the state
     *  a page is in once it has committed and is fetching subresources. */
    watch(tabId: number) {
      tracker.onRequestStart({ tabId, requestId: "doc", type: "main_frame", url: "https://x/" });
      tracker.onRequestDone({ tabId, requestId: "doc" });
    },
  };
}

const req = (tabId: number, requestId: string, type = "xmlhttprequest", url = "https://x/api") =>
  ({ tabId, requestId, type, url });

test("没从 main_frame 看起的 tab，答案是「未知」而不是「空闲」", () => {
  const { tracker } = harness();
  // A recycled service worker sees only subresources of a load already underway.
  tracker.onRequestStart(req(7, "r1", "script", "https://x/a.js"));
  assert.equal(tracker.inflightCount(7), null, "降级成 0 会把半加载的页面当成就绪交回去");
});

test("main_frame 本身也算在途 —— 文档没到，页面就还在加载", () => {
  const { tracker } = harness();
  tracker.onRequestStart(req(7, "doc", "main_frame", "https://x/"));
  assert.equal(tracker.inflightCount(7), 1, "文档请求在途时不该报空闲");
  tracker.onRequestDone({ tabId: 7, requestId: "doc" });
  assert.equal(tracker.inflightCount(7), 0);
});

test("完成事件没有对应的开始时，计数不会变负", () => {
  const h = harness();
  h.watch(7);
  // Arrived in flight before the listener attached — no matching start.
  h.tracker.onRequestDone({ tabId: 7, requestId: "ghost" });
  h.tracker.onRequestDone({ tabId: 7, requestId: "ghost2" });
  assert.equal(h.tracker.inflightCount(7), 0, "用计数器会变负，然后永远自称空闲");

  h.tracker.onRequestStart(req(7, "r1"));
  assert.equal(h.tracker.inflightCount(7), 1, "变负之后真实请求就再也顶不回正数了");
});

test("导航会丢掉上一份文档的在途集合", () => {
  const h = harness();
  h.watch(7);
  h.tracker.onRequestStart(req(7, "r1"));
  h.tracker.onRequestStart(req(7, "r2"));
  assert.equal(h.tracker.inflightCount(7), 2);

  h.tracker.onRequestStart(req(7, "doc2", "main_frame", "https://x/next"));
  assert.equal(h.tracker.inflightCount(7), 1, "只剩新文档自己，上个页面没答复的请求不该拖住它");
});

test("开着超过 streamAfterMs 的请求算长连接，不再计入繁忙", () => {
  const h = harness({ streamAfterMs: 2500 });
  h.watch(7);
  h.tracker.onRequestStart(req(7, "sse")); // long-poll / SSE 看起来和普通请求一样
  assert.equal(h.tracker.inflightCount(7), 1);

  h.advance(2600);
  assert.equal(h.tracker.inflightCount(7), 0, "否则聊天页/实时看板每次读都要烧满等待");
});

test("挂死超过 maxAgeMs 的请求被彻底遗忘", () => {
  const h = harness({ maxAgeMs: 10_000 });
  h.watch(7);
  h.tracker.onRequestStart(req(7, "hung"));
  h.advance(10_500);
  assert.equal(h.tracker.inflightCount(7), 0);
  assert.equal(h.tracker.inflightCount(7), 0, "是删掉了，不只是不计数");
});

test("永不结束的类型与 favicon 从一开始就不计入", () => {
  const h = harness();
  h.watch(7);
  h.tracker.onRequestStart(req(7, "ws", "websocket", "wss://x/live"));
  h.tracker.onRequestStart(req(7, "media", "media", "https://x/v.mp4"));
  h.tracker.onRequestStart(req(7, "fav", "image", "https://x/favicon.ico"));
  h.tracker.onRequestStart(req(7, "fav2", "image", "https://x/favicon.ico?v=2"));
  assert.equal(h.tracker.inflightCount(7), 0);
});

test("tab 关闭后视图回到「未知」，不是「空闲」", () => {
  const h = harness();
  h.watch(7);
  assert.equal(h.tracker.inflightCount(7), 0);
  h.tracker.onTabRemoved(7);
  assert.equal(h.tracker.inflightCount(7), null);
});

test("视图未知时 waitIdle 立即返回，绝不空等", async () => {
  const h = harness();
  await h.tracker.waitIdle(99, 5000);
  assert.deepEqual(h.slept, [], "未知就该马上放行，交给 settleDom 兜底");
});

test("早就安静的页面不必再付一次静默窗口", async () => {
  const h = harness({ idleMs: 500 });
  h.watch(7);
  h.advance(60_000); // 安静了一分钟

  await h.tracker.waitIdle(7, 5000);
  assert.deepEqual(h.slept, [], "静默窗口要从最后一次活动起算，而不是从调用时刻");
});

test("刚安静下来的页面要等满静默窗口", async () => {
  const h = harness({ idleMs: 500 });
  h.watch(7);
  h.tracker.onRequestStart(req(7, "r1"));
  h.tracker.onRequestDone({ tabId: 7, requestId: "r1" });

  await h.tracker.waitIdle(7, 5000);
  const total = h.slept.reduce((a, b) => a + b, 0);
  assert.ok(total >= 500, `应等满 500ms 静默，实际只等了 ${total}ms`);
});

test("一直忙的页面在超时处放行，不会被无限阻塞", async () => {
  const h = harness({ idleMs: 500, streamAfterMs: 2500 });
  h.watch(7);
  h.tracker.onRequestStart(req(7, "busy")); // 永不完成，且 2500ms 内仍算繁忙
  const t0 = h.now;

  await h.tracker.waitIdle(7, 1000);

  assert.ok(h.now - t0 >= 1000, `应推进到 1000ms 超时后放行，实际 ${h.now - t0}ms`);
  assert.equal(h.tracker.inflightCount(7), 1, "放行不等于页面已就绪 —— 只是不再等了");
});

test("等待不再算开太久的请求，但「还开着的请求」照实报出 —— 慢搜索和长轮询看起来一样，由读者凭地址判断；挂死的不报", () => {
  const h = harness({ streamAfterMs: 2500, maxAgeMs: 60_000 });
  h.watch(1);
  h.tracker.onRequestStart(req(1, "slow", "xmlhttprequest", "https://x/api/search?q=1"));
  h.advance(4000);
  assert.equal(h.tracker.inflightCount(1), 0, "等待把它当成长连接，不再等它");
  assert.deepEqual(h.tracker.openRequests(1), { count: 1, oldestMs: 4000, oldestUrl: "https://x/api/search?q=1" });
  h.advance(60_000);
  h.tracker.inflightCount(1);
  assert.deepEqual(h.tracker.openRequests(1)?.count, 0, "挂死的已被遗忘，不报");
  assert.equal(h.tracker.openRequests(2), null, "没看着的标签页：未知");
});
