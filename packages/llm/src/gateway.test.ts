/**
 * Gateway end-to-end tests — a real listening server, a mocked upstream.
 *
 * These exercise the seam the whole package exists for: an OpenAI client talks
 * to us, and whatever the upstream speaks never leaks out. The streaming and
 * error-status assertions are the ones that catch regressions; the happy path
 * mostly proves the wiring.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// 埋点走的是同一个全局 fetch，会污染这里 mock 的上游计数与捕获。
// 在导入网关之前关掉它——record() 每次调用都现读 env，所以这一行就够。
process.env.BCP_LLM_TELEMETRY_URL = "off";

import { loadRegistry } from "./adapters/index.js";
import type { ChannelConfig, JsonRecord } from "./adapters/types.js";
import { createGateway, resolveRequestTimeoutMs } from './gateway.js';

const LOCAL: ChannelConfig = {
  id: "local",
  adapter: "ollama",
  baseUrl: "http://127.0.0.1:11437",
  model: "qwen3.5:4b",
  options: { numCtx: 32768 },
};

const VENDOR: ChannelConfig = {
  id: "vendor",
  adapter: "openai",
  baseUrl: "https://api.example.com",
  apiKey: "sk-secret",
  model: "vendor-v2",
};

const realFetch = globalThis.fetch;

/**
 * 一个**保证不存在**的 keys.json 路径。
 *
 * 不给 keysPath 时网关会去读 `packages/llm/keys.json` —— 那是本机真实的密钥库。
 * 于是任何人只要在 Console 上签发过一把 key，这里每一个不带 Authorization 的
 * 测试就会变成 401，整套测试集体转红，而改动的却是别的东西。测试必须只依赖
 * 自己造的状态。
 */
const NO_KEYS = join(mkdtempSync(join(tmpdir(), "bcp-gw-nokeys-")), "keys.json");

test('request budgets preserve the default and accept bounded workload estimates', () => {
  assert.equal(resolveRequestTimeoutMs(undefined), 240_000);
  assert.equal(resolveRequestTimeoutMs('720000'), 720_000);
  assert.equal(resolveRequestTimeoutMs('3600000'), 1_800_000);
  for (const invalid of ['-1', '0', 'NaN', '1.5', 'nope', ['100', '200']]) {
    assert.throws(() => resolveRequestTimeoutMs(invalid), /positive integer/);
  }
});

test('the gateway enforces the caller budget on its upstream request', async () => {
  globalThis.fetch = (async (_url, init) => new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json({ message: { content: 'late' }, done: true })), 250);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('upstream deadline reached'));
    }, { once: true });
  })) as typeof fetch;
  await withGateway([LOCAL], async (base) => {
    const response = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BCP-Request-Timeout-Ms': '20' },
      body: JSON.stringify({ model: 'local', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 504);
    assert.match(await response.text(), /request budget exhausted/);
  });
});
after(() => {
  globalThis.fetch = realFetch;
});

test('in the desktop build the gateway answers only the desktop token, and never when that token is missing', async () => {
  const saved = { desktop: process.env.BCP_DESKTOP, token: process.env.BCP_DESKTOP_TOKEN };
  try {
    process.env.BCP_DESKTOP = '1';
    delete process.env.BCP_DESKTOP_TOKEN;
    await withGateway([LOCAL], async (base) => {
      const unset = await realFetch(`${base}/v1/models`, { headers: { Authorization: 'Bearer undefined' } });
      assert.equal(unset.status, 401, '令牌没有下发时，"Bearer undefined" 不能当成正确令牌');
      process.env.BCP_DESKTOP_TOKEN = 'desktop-token-fixture';
      assert.equal((await realFetch(`${base}/v1/models`)).status, 401);
      assert.equal((await realFetch(`${base}/v1/models`, { headers: { Authorization: 'Bearer wrong-token' } })).status, 401);
      assert.equal((await realFetch(`${base}/v1/models`, { headers: { Authorization: 'Bearer desktop-token-fixture' } })).status, 200);
    });
  } finally {
    for (const [key, value] of [['BCP_DESKTOP', saved.desktop], ['BCP_DESKTOP_TOKEN', saved.token]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

/**
 * 测试中正在监听的网关自身地址。
 *
 * 存在的理由：`/admin/keys/<id>/test` 是**网关打自己**——那正是它的价值，它要
 * 走外部调用方那条完整的路。但 mockUpstream 替换的是全局 fetch，会把这一发也
 * 一并拦下，于是测的就成了 mock 本身。这里让 mock 只拦「上游」，放行打自己的。
 */
const selfHosts = new Set<string>();

function mockUpstream(handler: (url: string, init: RequestInit) => Response): void {
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if ([...selfHosts].some((host) => href.includes(host))) {
      return realFetch(url as string, init);
    }
    return handler(href, init ?? {});
  }) as typeof fetch;
}

function ndjson(lines: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson" } },
  );
}

async function withGateway(
  channels: ChannelConfig[],
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = await createGateway({ channels, registry: await loadRegistry(), keysPath: NO_KEYS });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  selfHosts.add(`127.0.0.1:${port}`);
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    selfHosts.delete(`127.0.0.1:${port}`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withGatewayRegistry(
  channels: ChannelConfig[],
  registry: Awaited<ReturnType<typeof loadRegistry>>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = await createGateway({ channels, registry, keysPath: NO_KEYS });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  selfHosts.add(`127.0.0.1:${port}`);
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    selfHosts.delete(`127.0.0.1:${port}`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function post(base: string, body: unknown): Promise<Response> {
  return realFetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("an Ollama upstream is served back as an OpenAI completion", async () => {
  let seen: { url: string; body: JsonRecord } | undefined;
  mockUpstream((url, init) => {
    seen = { url, body: JSON.parse(String(init.body)) as JsonRecord };
    return Response.json({
      message: { content: "hello" },
      done: true,
      prompt_eval_count: 3,
      eval_count: 2,
    });
  });

  await withGateway([LOCAL], async (base) => {
    const res = await post(base, { model: "local", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as JsonRecord;
    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.model, "local");
    assert.equal(((payload.choices as JsonRecord[])[0].message as JsonRecord).content, "hello");
  });

  // The caller spoke OpenAI; the upstream was spoken to in Ollama, with the
  // context window the OpenAI protocol has no way to carry.
  assert.equal(seen?.url, "http://127.0.0.1:11437/api/chat");
  assert.equal((seen?.body.options as JsonRecord).num_ctx, 32768);
});

test("streaming comes back as SSE chunks terminated by [DONE]", async () => {
  mockUpstream(() =>
    ndjson([
      JSON.stringify({ message: { content: "he" }, done: false }),
      JSON.stringify({ message: { content: "llo" }, done: false }),
      JSON.stringify({ message: { content: "" }, done: true, done_reason: "stop" }),
    ]),
  );

  await withGateway([LOCAL], async (base) => {
    const res = await post(base, {
      model: "local",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    const frames = text
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => f.slice(6));
    assert.equal(frames.at(-1), "[DONE]");

    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f) as JsonRecord);
    const words = chunks.map((c) => ((c.choices as JsonRecord[])[0].delta as JsonRecord).content);
    assert.deepEqual(words, ["he", "llo", undefined]);
    assert.equal((chunks.at(-1)?.choices as JsonRecord[])[0].finish_reason, "stop");
    assert.equal(new Set(chunks.map((c) => c.id)).size, 1, "all chunks share one completion id");
  });
});

test("a mid-stream upstream failure is reported as an error frame, not a short answer", async () => {
  mockUpstream(() =>
    ndjson([
      JSON.stringify({ message: { content: "partial" }, done: false }),
      "{ this is not json",
    ]),
  );

  await withGateway([LOCAL], async (base) => {
    const res = await post(base, {
      model: "local",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    // Status is already 200 by then — the honesty has to live in the body.
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /malformed stream frame/);
    assert.doesNotMatch(text, /\[DONE\]/);
  });
});

test("未知模型是 404，且列出的是调用方能写的名字", async () => {
  mockUpstream(() => Response.json({}));
  await withGateway([LOCAL, VENDOR], async (base) => {
    const res = await post(base, { model: "nope", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 404);
    const payload = (await res.json()) as { error: { message: string } };
    // 列的是 id —— 也就是调用方写进 model 的那个名字。
    assert.match(payload.error.message, /available models: local, vendor/);
  });
});

test("an upstream HTTP failure surfaces as 502 with the upstream's own detail attached", async () => {
  mockUpstream(() => new Response("invalid api key", { status: 401 }));
  await withGateway([VENDOR], async (base) => {
    const res = await post(base, { model: "vendor", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 502);
    const payload = (await res.json()) as { error: { message: string } };
    assert.match(payload.error.message, /HTTP 401/);
    assert.match(payload.error.message, /invalid api key/);
  });
});

test("malformed requests are 400s, not 502s", async () => {
  mockUpstream(() => Response.json({}));
  await withGateway([LOCAL], async (base) => {
    const noMessages = await post(base, { model: "local" });
    assert.equal(noMessages.status, 400);

    const bad = await realFetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ nope",
    });
    assert.equal(bad.status, 400);
  });
});

test("/v1/models 列的是模型名，并说明每个模型由谁提供", async () => {
  mockUpstream(() => Response.json({}));
  // 同 id、不同来源 —— 这就是"一个模型两把 key"的写法。
  const DUP: ChannelConfig = { ...VENDOR, baseUrl: "https://backup.example.com" };
  await withGateway([LOCAL, VENDOR, DUP], async (base) => {
    const res = await realFetch(`${base}/v1/models`);
    const payload = (await res.json()) as {
      data: { id: string; owned_by: string; bcp: { sources: { channel: string; upstreamModel: string }[] } }[];
    };
    // id 就是调用方写进 model 的那个名字。两条同名渠道对外只是一个模型。
    assert.deepEqual(payload.data.map((m) => m.id), ["local", "vendor"]);
    assert.equal(payload.data[0].owned_by, "ollama");
    // 但"谁在提供它"要看得见，否则出问题时无从下手；同名的靠来源主机分开。
    assert.deepEqual(
      payload.data[1].bcp.sources.map((s) => s.channel),
      ["vendor@api.example.com", "vendor@backup.example.com"],
    );
    // 上游自己的模型名也带着 —— 对外叫 vendor，上游要的是 vendor-v2。
    assert.equal(payload.data[1].bcp.sources[0].upstreamModel, "vendor-v2");

    // 凭据永远不是路由描述的一部分。
    assert.doesNotMatch(JSON.stringify(payload), /sk-secret|apiKey/);
  });
});

test("a direct (CLI-backed) channel is served like any other, streaming included", async () => {
  // No upstream HTTP at all — proof the gateway's contract is "produce an
  // OpenAI response", not "make an HTTP request".
  let httpCalls = 0;
  mockUpstream(() => {
    httpCalls += 1;
    return Response.json({});
  });
  const registry = await loadRegistry();
  registry.set("fake-cli", {
    name: "fake-cli",
    kind: "direct",
    invoke: async () => ({
      id: "x",
      object: "chat.completion",
      model: "cli",
      choices: [{ index: 0, message: { role: "assistant", content: "整段答案" }, finish_reason: "stop" }],
    }),
  });
  const CLI: ChannelConfig = { id: "cli", adapter: "fake-cli", model: "some-model" };

  await withGatewayRegistry([CLI], registry, async (base) => {
    const plain = await post(base, { model: "cli", messages: [{ role: "user", content: "hi" }] });
    assert.equal(plain.status, 200);
    const payload = (await plain.json()) as JsonRecord;
    assert.equal(((payload.choices as JsonRecord[])[0].message as JsonRecord).content, "整段答案");

    // A CLI has no stream to forward, so the finished answer is re-cut as
    // chunks: the caller still gets complete, correct text under the protocol
    // it asked for.
    const streamed = await post(base, {
      model: "cli",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const frames = (await streamed.text())
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => f.slice(6));
    assert.equal(frames.at(-1), "[DONE]");
    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f) as JsonRecord);
    assert.equal(((chunks[0].choices as JsonRecord[])[0].delta as JsonRecord).content, "整段答案");
    assert.equal((chunks.at(-1)?.choices as JsonRecord[])[0].finish_reason, "stop");
    assert.equal(new Set(chunks.map((c) => c.id)).size, 1);
  });

  assert.equal(httpCalls, 0, "a direct adapter must not go through the HTTP path");
});

test("a direct channel needs no baseUrl, but an HTTP one is refused without it", async () => {
  const registry = await loadRegistry();
  await assert.rejects(
    createGateway({ channels: [{ id: "x", adapter: "openai", model: "m" }], registry }),
    /requires a baseUrl/,
  );
  // The opencode adapter is CLI-backed, so the same channel shape is fine.
  await createGateway({
    channels: [{ id: "oc", adapter: "opencode", model: "opencode/mimo-v2.5-free" }],
    registry,
  });
});

test("/health actually reaches every upstream and says which one is broken", async () => {
  mockUpstream((url) =>
    url.includes("11437")
      ? new Response("{}", { status: 200 })       // ollama /api/tags
      : new Response("nope", { status: 500 }),    // vendor /v1/models
  );
  await withGateway([LOCAL, VENDOR], async (base) => {
    const res = await realFetch(`${base}/health`);
    // Not 200: a health check that cannot fail is decoration.
    assert.equal(res.status, 503);
    const payload = (await res.json()) as {
      status: string;
      channels: { id: string; status: string; detail?: string }[];
    };
    assert.equal(payload.status, "degraded");
    assert.deepEqual(payload.channels.map((c) => `${c.id}:${c.status}`), ["local:ok", "vendor:down"]);
    assert.match(payload.channels[1].detail ?? "", /HTTP 500/);
  });
});

test("/health uses an adapter's own probe when it has no URL to GET", async () => {
  mockUpstream(() => new Response("{}", { status: 200 }));
  const registry = await loadRegistry();
  let probed = 0;
  registry.set("probe-ok", {
    name: "probe-ok", kind: "direct",
    invoke: async () => ({}),
    probe: async () => { probed += 1; },
  });
  registry.set("probe-fails", {
    name: "probe-fails", kind: "direct",
    invoke: async () => ({}),
    probe: async () => { throw new Error("binary not found"); },
  });
  registry.set("unprobeable", { name: "unprobeable", kind: "direct", invoke: async () => ({}) });

  await withGatewayRegistry(
    [
      { id: "a", adapter: "probe-ok", model: "m" },
      { id: "b", adapter: "probe-fails", model: "m" },
      { id: "c", adapter: "unprobeable", model: "m" },
    ],
    registry,
    async (base) => {
      const res = await realFetch(`${base}/health`);
      assert.equal(res.status, 503);
      const payload = (await res.json()) as { channels: { id: string; status: string; detail?: string }[] };
      assert.deepEqual(payload.channels.map((c) => `${c.id}:${c.status}`), ["a:ok", "b:down", "c:unknown"]);
      assert.match(payload.channels[1].detail ?? "", /binary not found/);
      // "cannot tell" is a real answer; claiming ok without checking is not.
      assert.match(payload.channels[2].detail ?? "", /cannot be probed/);
    },
  );
  assert.equal(probed, 1);
});

test("/health is 200 only when every upstream answers", async () => {
  mockUpstream(() => new Response("{}", { status: 200 }));
  await withGateway([LOCAL, VENDOR], async (base) => {
    const res = await realFetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, "ok");
  });
});

test("/v1/models stays a pure routing description — it issues no upstream calls", async () => {
  let calls = 0;
  mockUpstream(() => {
    calls += 1;
    return Response.json({});
  });
  await withGateway([LOCAL, VENDOR], async (base) => {
    await realFetch(`${base}/v1/models`);
  });
  assert.equal(calls, 0, "listing channels must not depend on upstreams being up");
});

test("a channel option the adapter does not declare stops startup", async () => {
  await assert.rejects(
    createGateway({
      channels: [{ ...LOCAL, options: { num_ctx: 32768 } }],
      registry: await loadRegistry(),
    }),
    /did you mean "numCtx"\?/,
  );
  await assert.rejects(
    createGateway({
      channels: [{ ...LOCAL, options: { numCtx: 32768, think: "true" } }],
      registry: await loadRegistry(),
    }),
    /must be a boolean, got string/,
  );
});

test("a channel naming an unregistered adapter fails at boot, not on the first request", async () => {
  await assert.rejects(
    createGateway({
      channels: [{ id: "x", adapter: "does-not-exist", baseUrl: "http://x", model: "x" }],
      registry: await loadRegistry(),
    }),
    /not registered/,
  );
});

// --- 鉴权 / 新端点 / failover ------------------------------------------

import { openAiAdapter } from "./adapters/openai.js";
import { createKey, writeKeyStore } from "./keys.js";

function tempKeys(): string {
  return join(mkdtempSync(join(tmpdir(), "bcp-gw-keys-")), "keys.json");
}

async function withOptions(
  options: Parameters<typeof createGateway>[0],
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = await createGateway({ registry: await loadRegistry(), keysPath: NO_KEYS, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  selfHosts.add(`127.0.0.1:${port}`);
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    selfHosts.delete(`127.0.0.1:${port}`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** 上游 + 埋点同时 mock：record() 走的也是全局 fetch，按 URL 分流。 */
function mockWithTelemetry(
  handler: (url: string, init: RequestInit) => Response,
  sink: JsonRecord[],
): void {
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("telemetry.test")) {
      sink.push(JSON.parse(String(init?.body)) as JsonRecord);
      return new Response("{}", { status: 200 });
    }
    return handler(href, init ?? {});
  }) as typeof fetch;
}

/** 埋点是 fire-and-forget，给它一拍落地。 */
async function flushTelemetry(): Promise<void> {
  process.env.BCP_LLM_TELEMETRY_URL = "off";
  await new Promise((resolve) => setTimeout(resolve, 60));
}

test("没有任何 key 时网关是敞开的 —— 全新 clone 零配置可用", async () => {
  mockUpstream(() => Response.json({ message: { content: "hi" }, done: true }));
  await withOptions({ channels: [LOCAL], keysPath: tempKeys() }, async (base) => {
    const res = await post(base, { model: "local", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
  });
});

test("签发第一把 key 之后，带对 key 才进得来；loopback 空手仍放行", async () => {
  mockUpstream(() => Response.json({ message: { content: "hi" }, done: true }));
  const path = tempKeys();
  const { store, plaintext } = createKey("外部调用方", { allowLoopback: true, keys: [] });
  writeKeyStore(store, path);

  await withOptions({ channels: [LOCAL], keysPath: path }, async (base) => {
    const body = { model: "local", messages: [{ role: "user", content: "hi" }] };
    const send = (headers: Record<string, string>) =>
      realFetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    // 测试客户端就是从 127.0.0.1 连过来的，allowLoopback 默认放行。
    assert.equal((await send({})).status, 200);
    assert.equal((await send({ Authorization: `Bearer ${plaintext}` })).status, 200);
    // 但一把**错的** key 永远被拒，哪怕来自本机 —— 否则吊销就不起作用了。
    const bad = await send({ Authorization: "Bearer bcp-wrong" });
    assert.equal(bad.status, 401);
    assert.match(await bad.text(), /invalid API key/);
  });
});

test("allowLoopback:false 时本机空手也会被拒", async () => {
  const path = tempKeys();
  const { store } = createKey("唯一入口", { allowLoopback: false, keys: [] });
  writeKeyStore(store, path);
  await withOptions({ channels: [LOCAL], keysPath: path }, async (base) => {
    const res = await post(base, { model: "local", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 401);
    assert.match(await res.text(), /missing API key/);
  });
});

test("allowLoopback:false 锁住 /v1，但锁不住本机的管理面", async () => {
  // 这里曾经断言管理面也 401，理由是「它能改渠道、能拿任意 baseUrl 发出站请求」。
  // 那条理由本身没错，但结论是错的：它把 Console 自己关在了门外——渠道读不到、
  // key 列表读不到，界面上「本机免 key」那个开关也点不回去，只剩手改 keys.json
  // 这一条路。而它锁不住任何东西：能连到 127.0.0.1 的进程与网关同机同用户，
  // 直接打开那个文件比走管理面还省事。
  //
  // 外部地址打管理面仍然要 key —— 那一半在 keys.test.ts 里钉（这里的测试客户端
  // 永远是 127.0.0.1，伪造不出外部来源）。
  const path = tempKeys();
  const { store } = createKey("k", { allowLoopback: false, keys: [] });
  writeKeyStore(store, path);
  await withOptions({ channels: [LOCAL], keysPath: path }, async (base) => {
    assert.equal((await realFetch(`${base}/admin/channels`)).status, 200);
    assert.equal((await realFetch(`${base}/admin/keys`)).status, 200);
    // 真正花钱的那些照样锁着。
    assert.equal((await realFetch(`${base}/v1/models`)).status, 401);
  });
});

test("/v1/embeddings：ollama 原生形状被翻成 OpenAI 形状", async () => {
  let seen: { url: string; body: JsonRecord } | undefined;
  mockUpstream((url, init) => {
    seen = { url, body: JSON.parse(String(init.body)) as JsonRecord };
    return Response.json({ model: "qwen3.5:4b", embeddings: [[0.1, 0.2], [0.3, 0.4]], prompt_eval_count: 7 });
  });

  await withOptions({ channels: [LOCAL] }, async (base) => {
    const res = await realFetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "local", input: ["一", "二"] }),
    });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as JsonRecord;
    assert.equal(seen?.url, "http://127.0.0.1:11437/api/embed");
    assert.deepEqual(seen?.body.input, ["一", "二"]);
    assert.equal(payload.object, "list");
    assert.deepEqual(payload.data, [
      { object: "embedding", index: 0, embedding: [0.1, 0.2] },
      { object: "embedding", index: 1, embedding: [0.3, 0.4] },
    ]);
    // 对外报的是调用方写的模型名，不是上游私有名。
    assert.equal(payload.model, "local");
    assert.deepEqual(payload.usage, { prompt_tokens: 7, total_tokens: 7 });
  });
});

test("/v1/embeddings：适配器没有这回事时是 501，且不会换渠道重试", async () => {
  const registry = await loadRegistry();
  registry.set("openai", { ...openAiAdapter, embed: undefined });
  let upstreamCalls = 0;
  mockUpstream(() => {
    upstreamCalls += 1;
    return Response.json({});
  });

  await withOptions({ channels: [VENDOR, { ...VENDOR, baseUrl: "https://b.example.com" }], registry }, async (base) => {
    const res = await realFetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "vendor", input: "hi" }),
    });
    assert.equal(res.status, 501);
    assert.match(await res.text(), /不支持 embeddings/);
    assert.equal(upstreamCalls, 0, "「这个上游没有这回事」不该拿另一条渠道再试一遍");
  });
});

test("/v1/completions：老形状进、老形状出，中间走的是同一条 chat 链路", async () => {
  let sentToUpstream: JsonRecord | undefined;
  mockUpstream((_url, init) => {
    sentToUpstream = JSON.parse(String(init.body)) as JsonRecord;
    return Response.json({
      choices: [{ index: 0, message: { role: "assistant", content: "答案" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  });

  await withOptions({ channels: [VENDOR] }, async (base) => {
    const res = await realFetch(`${base}/v1/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "vendor", prompt: "问题", max_tokens: 32 }),
    });
    assert.equal(res.status, 200);
    // 上游收到的是 chat 形状。
    assert.deepEqual(sentToUpstream?.messages, [{ role: "user", content: "问题" }]);
    const payload = (await res.json()) as JsonRecord;
    assert.equal(payload.object, "text_completion");
    assert.deepEqual(payload.choices, [
      { index: 0, text: "答案", finish_reason: "stop", logprobs: null },
    ]);
  });
});

test("/v1/completions：无法翻译的老参数是 400，不是静默忽略", async () => {
  mockUpstream(() => Response.json({ choices: [{ message: { content: "x" } }] }));
  await withOptions({ channels: [VENDOR] }, async (base) => {
    const res = await realFetch(`${base}/v1/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "vendor", prompt: "hi", echo: true }),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /echo/);
  });
});

test("failover：第一条 429 自动换第二条，且两次尝试各留一条日志", async () => {
  const sink: JsonRecord[] = [];
  process.env.BCP_LLM_TELEMETRY_URL = "http://telemetry.test/hook";
  const hosts: string[] = [];
  mockWithTelemetry((url) => {
    hosts.push(new URL(url).host);
    if (url.startsWith("https://a.example.com")) {
      return new Response("rate limited", { status: 429 });
    }
    return Response.json({
      choices: [{ index: 0, message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    });
  }, sink);

  const a: ChannelConfig = { ...VENDOR, baseUrl: "https://a.example.com" };
  const b: ChannelConfig = {
    ...VENDOR,
    baseUrl: "https://b.example.com",
    pricing: { inputPer1M: 3, outputPer1M: 15, currency: "USD" },
  };

  try {
    await withOptions({ channels: [a, b] }, async (base) => {
      const res = await realFetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BCP-Caller": "product-preprocess" },
        body: JSON.stringify({ model: "vendor", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 200);
    });
  } finally {
    await flushTelemetry();
  }

  assert.deepEqual(hosts, ["a.example.com", "b.example.com"]);
  assert.equal(sink.length, 2, "失败那次也必须留痕，否则重试会把故障掩盖成健康");

  const [failed, ok] = sink;
  assert.equal(failed.status, "error");
  assert.equal(failed.attempt, 1);
  assert.equal(failed.channel, "vendor@a.example.com");
  assert.equal(failed.httpStatus, 429, "上游的 429 原样透出，调用方据它退避");
  assert.equal(failed.caller, "product-preprocess");

  assert.equal(ok.status, "ok");
  assert.equal(ok.attempt, 2);
  assert.equal(ok.channel, "vendor@b.example.com");
  assert.equal(ok.caller, "product-preprocess");
  // 成本跟着**真正服务它的那条**渠道的单价算：1000×3 + 500×15 = 10500 micros。
  assert.equal(ok.costMicros, 10_500);
  assert.equal(ok.costCurrency, "USD");
});

test("不可重试的失败只记一条，不会把失败数凭空翻倍", async () => {
  const sink: JsonRecord[] = [];
  process.env.BCP_LLM_TELEMETRY_URL = "http://telemetry.test/hook";
  mockWithTelemetry(() => new Response("bad key", { status: 401 }), sink);

  const a: ChannelConfig = { ...VENDOR, baseUrl: "https://a.example.com" };
  const b: ChannelConfig = { ...VENDOR, baseUrl: "https://b.example.com" };
  try {
    await withOptions({ channels: [a, b] }, async (base) => {
      const res = await post(base, { model: "vendor", messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 502);
    });
  } finally {
    await flushTelemetry();
  }
  assert.equal(sink.length, 1);
  assert.equal(sink[0].attempt, 1);
});

test("用途别名把请求落到它指向的那条渠道上", async () => {
  mockUpstream(() => Response.json({ choices: [{ message: { content: "ok" } }] }));
  await withOptions(
    { channels: [VENDOR], aliases: { "task.vision": ["vendor"] } },
    async (base) => {
      const res = await post(base, {
        model: "task.vision",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 200);
    },
  );
});

test("别名指向不存在的模型 = 网关起不来（不是运行时 404）", async () => {
  await assert.rejects(
    createGateway({
      channels: [VENDOR],
      registry: await loadRegistry(),
      aliases: { "task.vision": ["gone"] },
    }),
    /alias "task\.vision" -> "gone"/,
  );
});

test("渠道并发上限把同一条渠道上的请求排成队", async () => {
  let inFlight = 0;
  let peak = 0;
  mockUpstream(
    () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 30));
            inFlight -= 1;
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
              ),
            );
            controller.close();
          },
        }),
      ),
  );

  const limited: ChannelConfig = { ...VENDOR, maxConcurrency: 2 };
  await withOptions({ channels: [limited] }, async (base) => {
    await Promise.all(
      Array.from({ length: 6 }, () =>
        post(base, { model: "vendor", messages: [{ role: "user", content: "hi" }] }),
      ),
    );
  });
  assert.ok(peak <= 2, `并发上限没生效，峰值 ${peak}`);
});

test("/admin/runtime 报的是网关自己的状态，不打任何上游", async () => {
  let upstreamCalls = 0;
  mockUpstream(() => {
    upstreamCalls += 1;
    return Response.json({});
  });
  await withOptions({ channels: [VENDOR], limits: { maxConcurrency: 8 } }, async (base) => {
    const res = await realFetch(`${base}/admin/runtime`);
    assert.equal(res.status, 200);
    const payload = (await res.json()) as JsonRecord;
    assert.equal((payload.concurrency as JsonRecord).limit, 8);
    assert.equal(upstreamCalls, 0, "它是纯内存快照，/health 才是去问上游的那个");
  });
});

// --- key 级限制端到端 ---------------------------------------------------

test("超出每分钟上限时回 429，并带上 Retry-After", async () => {
  mockUpstream(() => Response.json({ choices: [{ message: { content: "ok" } }] }));
  const path = tempKeys();
  const { store, plaintext } = createKey("限流的", { allowLoopback: false, keys: [] }, {
    rateLimitPerMinute: 2,
  });
  writeKeyStore(store, path);

  await withOptions({ channels: [VENDOR], keysPath: path }, async (base) => {
    const send = () =>
      realFetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ model: "vendor", messages: [{ role: "user", content: "hi" }] }),
      });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);

    const limited = await send();
    assert.equal(limited.status, 429);
    // 不带 Retry-After 的 429 会让调用方自己瞎猜退避时长，而我们精确知道答案。
    assert.equal(limited.headers.get("Retry-After"), "60");
    assert.match(await limited.text(), /超出每分钟 2 次的上限/);
  });
});

test("白名单之外的模型回 403，而且说得出它能用什么", async () => {
  mockUpstream(() => Response.json({ choices: [{ message: { content: "ok" } }] }));
  const path = tempKeys();
  const { store, plaintext } = createKey("只许本机", { allowLoopback: false, keys: [] }, {
    allowedModels: ["local"],
  });
  writeKeyStore(store, path);

  await withOptions({ channels: [LOCAL, VENDOR], keysPath: path }, async (base) => {
    const send = (model: string) =>
      realFetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
      });

    const denied = await send("vendor");
    assert.equal(denied.status, 403);
    assert.match(await denied.text(), /不允许访问 vendor[\s\S]*可用的是：local/);
  });
});

test("别名的备胎不能成为绕过白名单的路径", async () => {
  // 这是白名单做成「候选过滤器」而不是「前置检查」的全部理由：只校验调用方写的
  // 那个名字时，一条 [被允许的, 没被允许的] 备胎链会在首选失败后打到未授权的
  // 模型上，而且一声不吭。
  let vendorCalls = 0;
  mockUpstream((url) => {
    if (url.startsWith("https://api.example.com")) {
      vendorCalls += 1;
      return Response.json({ choices: [{ message: { content: "不该到这里" } }] });
    }
    return new Response("local down", { status: 503 });
  });

  const path = tempKeys();
  const { store, plaintext } = createKey("只许本机", { allowLoopback: false, keys: [] }, {
    allowedModels: ["local"],
  });
  writeKeyStore(store, path);

  await withOptions(
    { channels: [LOCAL, VENDOR], keysPath: path, aliases: { task: ["local", "vendor"] } },
    async (base) => {
      const res = await realFetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ model: "task", messages: [{ role: "user", content: "hi" }] }),
      });
      // local 挂了，但 vendor 不在白名单里，所以只能如实报错，不能偷偷降级过去。
      assert.equal(res.status, 502);
      assert.equal(vendorCalls, 0, "未授权的备胎一次都不该被打到");
    },
  );
});

test("别名备胎：首选全挂时自动落到下一个模型", async () => {
  mockUpstream((url) => {
    if (url.startsWith("https://api.example.com")) {
      return new Response("rate limited", { status: 429 });
    }
    return Response.json({ message: { content: "备胎接住了" }, done: true });
  });

  await withOptions(
    { channels: [VENDOR, LOCAL], aliases: { task: ["vendor", "local"] } },
    async (base) => {
      const res = await post(base, { model: "task", messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 200);
      const payload = (await res.json()) as JsonRecord;
      const choice = (payload.choices as JsonRecord[])[0];
      assert.equal((choice.message as JsonRecord).content, "备胎接住了");
    },
  );
});

test("每把 key 的并发上限把它自己的请求排成队", async () => {
  let inFlight = 0;
  let peak = 0;
  mockUpstream(
    () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 30));
            inFlight -= 1;
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: "ok" } }] })),
            );
            controller.close();
          },
        }),
      ),
  );

  const path = tempKeys();
  const { store, plaintext } = createKey("慢一点", { allowLoopback: false, keys: [] }, {
    maxConcurrency: 2,
  });
  writeKeyStore(store, path);

  await withOptions({ channels: [VENDOR], keysPath: path }, async (base) => {
    await Promise.all(
      Array.from({ length: 6 }, () =>
        realFetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
          body: JSON.stringify({ model: "vendor", messages: [{ role: "user", content: "hi" }] }),
        }),
      ),
    );
  });
  assert.ok(peak <= 2, `每 key 并发上限没生效，峰值 ${peak}`);
});

test("过期的 key 被拒，且网关不会因此变敞开", async () => {
  mockUpstream(() => Response.json({ choices: [{ message: { content: "ok" } }] }));
  const path = tempKeys();
  const { store, plaintext } = createKey("过期了", { allowLoopback: false, keys: [] }, {
    expiresAt: new Date(Date.now() - 3600_000).toISOString(),
  });
  writeKeyStore(store, path);

  await withOptions({ channels: [VENDOR], keysPath: path }, async (base) => {
    const withKey = await realFetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({ model: "vendor", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(withKey.status, 401);
    assert.match(await withKey.text(), /过期/);

    // 更要紧的一条：所有 key 都过期时，网关继续鉴权而不是退回「没有 key = 敞开」。
    const noKey = await post(base, { model: "vendor", messages: [{ role: "user", content: "hi" }] });
    assert.equal(noKey.status, 401);
  });
});

// --- key 的回显与一键测试 ------------------------------------------------

test("明文按需取：列表不带，单独端点才给", async () => {
  mockUpstream(() => Response.json({ choices: [{ message: { content: "ok" } }] }));
  const path = tempKeys();
  const { store, plaintext, record } = createKey("可回显", { allowLoopback: true, keys: [] });
  writeKeyStore(store, path);

  await withOptions({ channels: [VENDOR], keysPath: path }, async (base) => {
    const list = await (await realFetch(`${base}/admin/keys`)).text();
    assert.ok(!list.includes(plaintext), "列表每几秒刷一次，明文不该跟着走");
    assert.match(list, /"revealable":true/);

    const revealed = (await (
      await realFetch(`${base}/admin/keys/${record.id}/secret`)
    ).json()) as JsonRecord;
    assert.equal(revealed.secret, plaintext);
  });
});

test("旧版 key 回显时给出原因，不给空字符串", async () => {
  const path = tempKeys();
  const { store } = createKey("旧的", { allowLoopback: true, keys: [] });
  // 升级前写下的 keys.json：没有 secret 字段。
  writeKeyStore({ ...store, keys: store.keys.map(({ secret: _d, ...rest }) => rest) }, path);

  await withOptions({ channels: [VENDOR], keysPath: path }, async (base) => {
    const id = store.keys[0].id;
    const revealed = (await (await realFetch(`${base}/admin/keys/${id}/secret`)).json()) as JsonRecord;
    assert.equal(revealed.secret, null);
    assert.match(String(revealed.reason), /旧版本签发/);
  });
});

test("一键测试走的是外部调用方那条路：白名单挡住时它就该失败", async () => {
  // 测试若从内部直调，就绕过了这把 key 上的每一项限制——也就绕过了人真正想验证
  // 的东西。这条断言钉的正是「它确实打了自己的 /v1」。
  mockUpstream(() => Response.json({ choices: [{ message: { content: "不该到这里" } }] }));
  const path = tempKeys();
  const { store, record } = createKey("只许 local", { allowLoopback: true, keys: [] }, {
    allowedModels: ["local"],
  });
  writeKeyStore(store, path);

  // 网关只服务 vendor，而这把 key 只准打 local → 403。
  await withOptions({ channels: [VENDOR], keysPath: path }, async (base) => {
    const result = (await (
      await realFetch(`${base}/admin/keys/${record.id}/test`, { method: "POST" })
    ).json()) as JsonRecord;
    assert.equal(result.ok, false);
    // 这把 key 只准打 local，而网关只服务 vendor：候选里一条都挑不出来，
    // 于是先撞上 404（没有这个模型）。要紧的是它**真的走了 /v1 那条路**——
    // 内部直调根本不会碰到白名单，也就测不出这件事。
    assert.equal(result.httpStatus, 404);
    assert.match(String(result.error), /unknown model "local"/);
  });
});

test("一键测试成功时报出耗时与上游回答（key 名是中文也要能测）", async () => {
  // 名字**刻意用中文**：测试请求会带一个 X-BCP-Caller 头，而 HTTP header 的值
  // 只能是 ASCII。早先那里放的是 key 的名字，于是所有中文命名的 key 一点「测试」
  // 就抛 `Cannot convert argument to a ByteString`，报错还完全不指向名字。
  let sentCaller: string | undefined;
  mockUpstream((_url, init) => {
    sentCaller = (init.headers as Record<string, string> | undefined)?.["X-BCP-Caller"];
    return Response.json({ choices: [{ message: { content: "收到" } }] });
  });
  const path = tempKeys();
  const { store, record } = createKey("能用的", { allowLoopback: true, keys: [] });
  writeKeyStore(store, path);

  await withOptions({ channels: [VENDOR], keysPath: path }, async (base) => {
    const result = (await (
      await realFetch(`${base}/admin/keys/${record.id}/test`, { method: "POST" })
    ).json()) as JsonRecord;
    assert.equal(result.ok, true);
    assert.equal(result.model, "vendor");
    assert.equal(result.reply, "收到");
    assert.equal(typeof result.latencyMs, "number");
    // 上游收到的 caller 标记必须是纯 ASCII。
    assert.ok(sentCaller === undefined || /^[\x20-\x7e]*$/.test(sentCaller), sentCaller);
  });
});

test("测试一把过期的 key：失败也回 200，因为那是「测试的结果」", async () => {
  mockUpstream(() => Response.json({ choices: [{ message: { content: "ok" } }] }));
  const path = tempKeys();
  const { store, record } = createKey("过期的", { allowLoopback: true, keys: [] }, {
    expiresAt: new Date(Date.now() - 3600_000).toISOString(),
  });
  writeKeyStore(store, path);

  await withOptions({ channels: [VENDOR], keysPath: path }, async (base) => {
    const res = await realFetch(`${base}/admin/keys/${record.id}/test`, { method: "POST" });
    // 接口本身没坏，坏的是那把 key —— 界面要显示这段原文。
    assert.equal(res.status, 200);
    const result = (await res.json()) as JsonRecord;
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 401);
    assert.match(String(result.error), /过期/);
  });
});
