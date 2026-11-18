import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserEvent } from "@bcp/shared";
import { EventStore } from "./event-store.js";
import { buildPayload, createEventWebhook, shouldNotify, type CaptureFn } from "./event-webhook.js";

const challenge = (over: Partial<BrowserEvent> = {}): BrowserEvent => ({
  kind: "captcha_appeared",
  tabId: 12,
  ts: 1757400000000,
  seq: 42,
  browser: "chrome-1",
  summary: "possible challenge — url 像验证页",
  detail: { evidence: ["url 像验证页"], frameId: 0, url: "https://x/verify", title: "安全验证" },
  ...over,
});

test("shouldNotify: 只放行「不说就没人知道」的那几类", () => {
  assert.equal(shouldNotify({ kind: "captcha_appeared" }), true);
  assert.equal(shouldNotify({ kind: "captcha_cleared" }), true);
  assert.equal(shouldNotify({ kind: "browser_offline" }), true);
  // 高频且事后可从 seq buffer 读到的，一律不推
  assert.equal(shouldNotify({ kind: "navigation" }), false);
  assert.equal(shouldNotify({ kind: "dom_changed" }), false);
  assert.equal(shouldNotify({ kind: "console_error" }), false);
});

test("buildPayload: 事件原样透传，不重塑结构", async () => {
  const e = challenge();
  const body = await buildPayload(e);
  // 逐字段等于事件本身——一旦有人给某个 kind 定制扁平 payload，这条会红
  assert.deepEqual(body, { ...e });
  assert.deepEqual(body.detail, e.detail);
});

test("buildPayload: 截图挂在 screenshot 字段上", async () => {
  const capture: CaptureFn = async () => ({ dataUrl: "data:image/png;base64,AAA" });
  const body = await buildPayload(challenge(), capture, 0);
  assert.equal(body.screenshot, "data:image/png;base64,AAA");
});

test("buildPayload: 截到的是别的 tab（带 warning）就丢掉，绝不发错图", async () => {
  const capture: CaptureFn = async () => ({
    dataUrl: "data:image/png;base64,WRONG",
    warning: "requested tab 12 is in the background — the image shows the window's visible tab instead",
  });
  const body = await buildPayload(challenge(), capture, 0);
  assert.equal("screenshot" in body, false);
  // 保留原始事件，推送入口根据缺图状态抑制通知。
  assert.equal(body.kind, "captcha_appeared");
});

test('buildPayload: 截图失败时保留事件，不附加图片', async () => {
  const capture: CaptureFn = async () => {
    throw new Error("browser disconnected");
  };
  const body = await buildPayload(challenge(), capture, 0);
  assert.equal("screenshot" in body, false);
  assert.equal(body.tabId, 12);
});

test("buildPayload: 只有 captcha_appeared 才截图", async () => {
  let calls = 0;
  const capture: CaptureFn = async () => {
    calls++;
    return { dataUrl: "data:image/png;base64,AAA" };
  };
  await buildPayload(challenge({ kind: "captcha_cleared", summary: "challenge no longer detected" }), capture);
  assert.equal(calls, 0, "清除事件没什么可看的，不该付一次 RPC");
});

test("buildPayload: 无 tab 的事件（tabId -1）不截图", async () => {
  let calls = 0;
  const capture: CaptureFn = async () => {
    calls++;
    return { dataUrl: "x" };
  };
  const body = await buildPayload(
    challenge({ kind: "browser_offline", tabId: -1, summary: "chrome-1 went offline", detail: undefined }),
    capture,
  );
  assert.equal(calls, 0);
  assert.equal("screenshot" in body, false);
});

test("buildPayload: 截图前先等画面稳定，且只有要截图的 kind 付这份等待", async () => {
  // challenge 是分帧渲染的：探针在「容器落地」那一帧就判定拦截，此时拼图还在
  // 加载、展开动画还在跑。事件改成边沿触发之后只有这一次截图机会，抢跑就等于
  // 永远只能拿到半张图——这条钉的就是「等」这个动作本身。
  const t0 = Date.now();
  let captureAt = -1;
  const capture: CaptureFn = async () => {
    captureAt = Date.now() - t0;
    return { dataUrl: "data:image/png;base64,AAA" };
  };
  const body = await buildPayload(challenge(), capture, 40);
  assert.equal(body.screenshot, "data:image/png;base64,AAA");
  assert.ok(captureAt >= 35, `截图在 ${captureAt}ms 就发生了，没等渲染稳定`);

  // 反面：等待挂在截图这条路径上，不是挂在所有事件上。cleared 无图可截，
  // 给它一个大到测试会明显变慢的值——它必须一点都不等。
  const started = Date.now();
  await buildPayload(challenge({ kind: "captcha_cleared", summary: "challenge no longer detected" }), capture, 5_000);
  assert.ok(Date.now() - started < 100, "不截图的 kind 不该为渲染稳定买单");
});

test("createEventWebhook: 不在白名单的事件一个请求都不发", async () => {
  const posts: string[] = [];
  await withFetch(
    async () => {
      posts.push("called");
      return new Response(null, { status: 200 });
    },
    async () => {
      createEventWebhook("http://127.0.0.1:9999/hook")(challenge({ kind: "navigation" }));
      await tick();
    },
  );
  assert.deepEqual(posts, []);
});

test('createEventWebhook: 浏览器掉线不依赖模型，原样 POST JSON', async () => {
  const bodies: string[] = [];
  await withFetch(
    async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(null, { status: 200 });
    },
    async () => {
      await createEventWebhook('http://127.0.0.1:9999/hook')(challenge({ kind: 'browser_offline' }));
      await tick();
    },
  );
  assert.equal(bodies.length, 1);
  const sent = JSON.parse(bodies[0]) as BrowserEvent;
  assert.equal(sent.kind, 'browser_offline');
  assert.equal(sent.seq, 42);
  assert.equal((sent.detail as { url: string }).url, "https://x/verify");
});

test("createEventWebhook: 接收端 500 不抛到调用方（事件流不受影响）", async () => {
  await withFetch(
    async () => new Response(null, { status: 500 }),
    async () => {
      // 抛出去就会冒到 EventStore.push 的 for 循环里
      await createEventWebhook('http://127.0.0.1:9999/hook')(challenge({ kind: 'browser_offline' }));
      await tick();
    },
  );
});

test('接线：EventStore 派发 → 复核通过 → POST 到 HTTP 服务', { timeout: 5000 }, async () => {
  const received: Array<Record<string, unknown>> = [];
  let arrived: () => void;
  const firstArrival = new Promise<void>((r) => (arrived = r));
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      received.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200).end();
      arrived();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const store = new EventStore();
    store.onEvent(createEventWebhook(
      `http://127.0.0.1:${port}/hook`,
      async () => ({ dataUrl: 'data:image/jpeg;base64,/9j/2Q==' }),
      { settleMs: 0, verify: async () => ({ isCaptcha: true, reason: 'Visible puzzle' }) },
    ));
    store.push(challenge({ seq: undefined }));
    await firstArrival;
    store.push(challenge({ kind: 'navigation', summary: '→ https://x', seq: undefined }));
    await tick();
    assert.equal(received.length, 1, "navigation 不该出现在接收端");
    assert.equal(received[0].kind, "captcha_appeared");
    // seq 由 push 盖上，证明发出去的是入库后的事件而不是调用方那份
    assert.equal(received[0].seq, 1);
  } finally {
    server.close();
  }
});

async function withFetch(impl: typeof fetch, run: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
}

/** 让 fire-and-forget 的 post() 跑完一轮微任务。 */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
