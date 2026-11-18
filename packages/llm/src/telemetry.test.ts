/**
 * 埋点推送的测试。
 *
 * 钉的全是「绝不能影响服务」那三条：不 await、不抛、失败不刷屏。
 * 这些性质出问题时不会让任何断言天然变红——它们只会让网关变慢或变脆，
 * 所以必须显式钉住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { costOf, fromCompletion, fromRequest, preview, record } from "./telemetry.js";

const realFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return handler(String(url), init ?? {});
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

test("record 是同步返回的 —— 类型上就 await 不到，也就进不了关键链", () => {
  const m = mockFetch(async () => new Response("{}"));
  try {
    const returned: void = record({ status: "ok" }, { BCP_LLM_TELEMETRY_URL: "http://x/hook" });
    assert.equal(returned, undefined);
  } finally {
    m.restore();
  }
});

test("推送失败不抛 —— 一次本可成功的请求不该因为日志挂掉", async () => {
  const m = mockFetch(async () => {
    throw new Error("console is down");
  });
  try {
    assert.doesNotThrow(() => record({ status: "ok" }, { BCP_LLM_TELEMETRY_URL: "http://x/hook" }));
    await flush();
  } finally {
    m.restore();
  }
});

test("BCP_LLM_TELEMETRY_URL=off 时一个请求都不发", async () => {
  const m = mockFetch(async () => new Response("{}"));
  try {
    record({ status: "ok" }, { BCP_LLM_TELEMETRY_URL: "off" });
    await flush();
    assert.equal(m.calls.length, 0);
  } finally {
    m.restore();
  }
});

test("默认打 console 的内部摄入口，body 就是这条记录", async () => {
  const m = mockFetch(async () => new Response("{}"));
  try {
    record({ status: "error", channel: "oc", errorMessage: "boom" }, {});
    await flush();
    assert.equal(m.calls.length, 1);
    assert.match(m.calls[0].url, /\/internal\/llm-calls\/hook$/);
    assert.deepEqual(m.calls[0].body, { status: "error", channel: "oc", errorMessage: "boom" });
  } finally {
    m.restore();
  }
});

test("fromCompletion 取 usage 与正文；缺失保持缺失，不补零", () => {
  assert.deepEqual(
    fromCompletion({
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      choices: [{ message: { content: "hi" } }],
    }),
    { promptTokens: 10, completionTokens: 4, totalTokens: 14, responsePreview: "hi" },
  );
  // opencode 一个 token 都不报。补 0 会把所有均值悄悄往下拽。
  const none = fromCompletion({ choices: [{ message: { content: "hi" } }] });
  assert.equal(none.promptTokens, undefined);
  assert.equal(none.totalTokens, undefined);
});

test("fromRequest 取最后一条 user 消息；多模态只取文本", () => {
  assert.equal(fromRequest([{ role: "system", content: "s" }, { role: "user", content: "问题" }]), "问题");
  assert.equal(
    fromRequest([{ role: "user", content: "第一问" }, { role: "assistant", content: "答" }, { role: "user", content: "第二问" }]),
    "第二问",
  );
  // 图片的 base64 没有预览价值还很大。
  assert.equal(
    fromRequest([
      { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } }] },
    ]),
    "看图",
  );
  assert.equal(fromRequest([]), undefined);
});

test("preview 截断并把空串归一成 undefined", () => {
  assert.equal(preview("  hi  "), "hi");
  assert.equal(preview("   "), undefined);
  assert.equal(preview(undefined), undefined);
  assert.equal(preview("x".repeat(5000))?.length, 2001);
});

test("costOf：tokens × 每百万单价 直接就是 micros，没有除法", () => {
  // 1M prompt token @ $3/1M = 3 USD = 3_000_000 micros。
  assert.deepEqual(costOf({ promptTokens: 1_000_000, completionTokens: 0 }, {
    inputPer1M: 3,
    outputPer1M: 15,
    currency: "USD",
  }), { costMicros: 3_000_000, costCurrency: "USD" });

  assert.deepEqual(costOf({ promptTokens: 1000, completionTokens: 500 }, {
    inputPer1M: 3,
    outputPer1M: 15,
  }), { costMicros: 3000 + 7500 });
});

test("costOf：任一侧缺失就返回 undefined，绝不补零", () => {
  const pricing = { inputPer1M: 3, outputPer1M: 15 };
  // 报不出 usage 的上游（opencode 一个都不报）该显示「未知」。显示成 0 会让
  // 「免费」和「不知道」在任何汇总里变成同一件事。
  assert.equal(costOf({ promptTokens: undefined, completionTokens: 5 }, pricing), undefined);
  assert.equal(costOf({ promptTokens: 5, completionTokens: undefined }, pricing), undefined);
  assert.equal(costOf({ promptTokens: 5, completionTokens: 5 }, undefined), undefined);
});

test("costOf：声明为免费算出 0，与「没声明」不是一回事", () => {
  assert.deepEqual(
    costOf({ promptTokens: 9999, completionTokens: 9999 }, { inputPer1M: 0, outputPer1M: 0 }),
    { costMicros: 0 },
  );
});
