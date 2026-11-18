import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { BrowserEventIngestController, BrowserEventsController } from "./browser-events.controller.js";
import { BrowserEventsService } from "./browser-events.service.js";

/**
 * HTTP 层的契约。直接调方法看不见的东西，只有真路由能看见：
 *
 *  - **路径本身**。`/internal/browser-events/hook` 是要写进 `.env` 的字符串，
 *    挂错地方的表现是 backend 每次推送打一行 404 warn，而 console 这边完全安静。
 *  - **状态码**。推送端只认 `res.ok`，非 2xx 就丢弃事件不重试。所以 200 是契约，
 *    不是风格；@HttpCode 掉了会变成 201（仍然 ok，但形状与 delivery-ingest 分叉）。
 *  - **`@Query` 绑定**。少一个 decorator，参数照样能从直接调用里到达，只有
 *    query string 到不了。
 */
async function overHttp<T>(
  fn: (baseUrl: string, calls: Array<{ method: string; arg: unknown }>) => Promise<T>,
): Promise<T> {
  const calls: Array<{ method: string; arg: unknown }> = [];
  const fake = {
    ingest: async (input: unknown) => { calls.push({ method: "ingest", arg: input }); return { id: "ev1" }; },
    list: async (q: unknown) => { calls.push({ method: "list", arg: q }); return { items: [], page: 1, pageSize: 50, total: 0 }; },
    stats: async (q: unknown) => { calls.push({ method: "stats", arg: q }); return { total: 0, unacknowledged: 0, byKind: [] }; },
    findById: async (id: unknown) => { calls.push({ method: "findById", arg: id }); return { id }; },
    setAcknowledged: async (id: string, acknowledged: boolean) => {
      calls.push({ method: "setAcknowledged", arg: { id, acknowledged } });
      return { id };
    },
    remove: async (id: unknown) => { calls.push({ method: "remove", arg: id }); return { id }; },
    restore: async (id: unknown) => { calls.push({ method: "restore", arg: id }); return { id }; },
  };

  @Module({
    controllers: [BrowserEventIngestController, BrowserEventsController],
    providers: [{ provide: BrowserEventsService, useValue: fake }],
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0);
  try {
    return await fn((await app.getUrl()).replace("[::1]", "127.0.0.1"), calls);
  } finally {
    await app.close();
  }
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("POST /internal/browser-events/hook 收下事件并回 200", async () => {
  await overHttp(async (base, calls) => {
    const res = await post(`${base}/internal/browser-events/hook`, {
      kind: "captcha_appeared",
      tabId: 12,
      ts: 1788945715353,
      summary: "blocked",
      detail: { vendor: "shumei" },
    });
    // 200 而不是 201：推送端一次投递不重试，状态码是契约的一部分。
    assert.equal(res.status, 200);
    assert.equal(calls[0].method, "ingest");
    assert.deepEqual(calls[0].arg, {
      kind: "captcha_appeared",
      tabId: 12,
      ts: 1788945715353,
      summary: "blocked",
      detail: { vendor: "shumei" },
    });
  });
});

test("hook 路径挂在 internal 下，不是 api 下", async () => {
  await overHttp(async (base) => {
    // 这条钉的是要写进 .env 的那个字符串。挂错地方时 backend 只会打一行
    // 404 warn，console 侧毫无动静——没有这条断言就没人会发现。
    assert.equal((await post(`${base}/api/browser-events/hook`, { kind: "x" })).status, 404);
    assert.equal((await post(`${base}/internal/browser-events/hook`, { kind: "x" })).status, 200);
  });
});

test("GET /api/browser-events 把 query string 绑成筛选条件", async () => {
  await overHttp(async (base, calls) => {
    const res = await fetch(`${base}/api/browser-events?kind=captcha_appeared&search=红色&unacknowledged=true&includeDeleted=true&page=2&pageSize=20`);
    assert.equal(res.status, 200);
    assert.deepEqual(calls[0].arg, {
      kind: "captcha_appeared",
      search: "红色",
      unacknowledged: true,
      includeDeleted: true,
      page: 2,
      pageSize: 20,
    });
  });
});

test("不带 unacknowledged 时该键必须缺席，而不是 false", async () => {
  await overHttp(async (base, calls) => {
    await fetch(`${base}/api/browser-events`);
    const arg = calls[0].arg as Record<string, unknown>;
    // 折叠成 false 的后果是默认列表只剩已处理的事件——不报错，只是内容不对。
    assert.ok(!("unacknowledged" in arg));
    assert.equal(arg.includeDeleted, false);
  });
});

test("stats 是独立路由，不会被 :id 吞掉", async () => {
  await overHttp(async (base, calls) => {
    const res = await fetch(`${base}/api/browser-events/stats?kind=captcha_appeared`);
    assert.equal(res.status, 200);
    // @Get("stats") 必须声明在 @Get(":id") 之前，否则 "stats" 会被当成一个 id
    // 走进 findById，返回 404 而不是计数。
    assert.equal(calls[0].method, "stats");
    assert.deepEqual((calls[0].arg as Record<string, unknown>).kind, "captcha_appeared");
  });
});

test("acknowledge 默认是「标记已处理」，取消要显式传 false", async () => {
  await overHttp(async (base, calls) => {
    await post(`${base}/api/browser-events/ev1/acknowledge`, {});
    assert.deepEqual(calls[0].arg, { id: "ev1", acknowledged: true });
    await post(`${base}/api/browser-events/ev1/acknowledge`, { acknowledged: false });
    assert.deepEqual(calls[1].arg, { id: "ev1", acknowledged: false });
    await post(`${base}/api/browser-events/ev1/acknowledge`, { acknowledged: true });
    assert.deepEqual(calls[2].arg, { id: "ev1", acknowledged: true });
  });
});

test("DELETE 走软删，restore 撤销", async () => {
  await overHttp(async (base, calls) => {
    assert.equal((await fetch(`${base}/api/browser-events/ev1`, { method: "DELETE" })).status, 200);
    assert.deepEqual(calls[0], { method: "remove", arg: "ev1" });
    await post(`${base}/api/browser-events/ev1/restore`, {});
    assert.deepEqual(calls[1], { method: "restore", arg: "ev1" });
  });
});
