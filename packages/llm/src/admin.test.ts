/**
 * 管理面测试。
 *
 * 只钉「坏了也看不出来」的那几处，其中第一条是全部里最要紧的：
 *
 *  1. **保存的顺序**：校验 → 落盘 → 切换。校验不过时，磁盘和内存都必须没被碰过。
 *     顺序反了（先写再重载）不会立刻报错——它会在重载失败时留下一个坏 channels.json，
 *     症状是「界面说保存成功，下次启动起不来」。
 *  2. **密钥不出机器**：管理面读写的是原始声明，apiKey 保持 `env.NAME`。从加载后的
 *     表往回写会把真密钥印进配置文件，而那个错误一旦发生就进了 git。
 *  3. **测试失败不是接口失败**：一键测试要把上游的报错当"结果"回给界面，不是抛。
 *  4. **拉不到模型就说拉不到**：编一份列表比没有列表更糟，它会让人选中不存在的模型。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 同 gateway.test.ts 的理由：testChannel 现在也走 record()，每次调用都现读
// env，这一行必须在 admin.js 导入前生效，否则测试会真的打一次网络请求。
process.env.BCP_LLM_TELEMETRY_URL = "off";

import { loadRegistry } from "./adapters/index.js";
import { RequestError, type ChannelConfig } from "./adapters/types.js";
import {
  describeAdapters,
  listSecretEnvNames,
  probeUpstreamModels,
  saveChannels,
  testChannel,
  type AdminDeps,
} from "./admin.js";

const OK_ENTRY = {
  id: "vendor",
  adapter: "openai",
  baseUrl: "https://api.example.com",
  model: "m",
};

async function harness(seed: unknown[] = [OK_ENTRY]) {
  const dir = mkdtempSync(join(tmpdir(), "bcp-admin-"));
  const path = join(dir, "channels.json");
  writeFileSync(path, JSON.stringify({ _readme: ["keep me"], channels: seed }, null, 2));
  const registry = await loadRegistry();
  let reloads = 0;
  const deps: AdminDeps = {
    registry,
    path,
    current: () => [{ id: "vendor", adapter: "openai", baseUrl: "https://api.example.com", model: "m" }],
    reload: () => { reloads += 1; },
    chat: async () => ({ choices: [{ message: { content: "收到" } }] }),
  };
  return {
    deps,
    path,
    onDisk: () => JSON.parse(readFileSync(path, "utf8")) as { _readme?: unknown; channels: unknown[] },
    reloads: () => reloads,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("校验不过时，磁盘和内存都没被碰过", async () => {
  const h = await harness();
  try {
    const before = h.onDisk();
    // 拼错的 option key —— 正是那个会让 32k 上下文无声消失的输入。
    assert.throws(
      () => saveChannels([{ ...OK_ENTRY, adapter: "ollama", options: { num_ctx: 32768 } }], h.deps),
      /did you mean "numCtx"\?/,
    );
    assert.deepEqual(h.onDisk(), before, "文件必须原样");
    assert.equal(h.reloads(), 0, "没切换过表");
  } finally {
    h.cleanup();
  }
});

test("重复 id / 未注册适配器同样在落盘前被拦下", async () => {
  const h = await harness();
  try {
    assert.throws(() => saveChannels([OK_ENTRY, OK_ENTRY], h.deps), /duplicate channel id "vendor"/);
    assert.throws(
      () => saveChannels([{ ...OK_ENTRY, adapter: "nope" }], h.deps),
      /not registered/,
    );
    assert.equal(h.reloads(), 0);
  } finally {
    h.cleanup();
  }
});

test("HTTP 适配器缺 baseUrl 被拦；direct 适配器不需要它", async () => {
  const h = await harness();
  try {
    assert.throws(
      () => saveChannels([{ id: "x", adapter: "openai", model: "m" }], h.deps),
      /requires a baseUrl/,
    );
    // opencode 是 CLI，没有 URL 可填。
    assert.doesNotThrow(() => saveChannels([{ id: "oc", adapter: "opencode", model: "m" }], h.deps));
  } finally {
    h.cleanup();
  }
});

test("校验通过才落盘并切换，_readme 保留", async () => {
  const h = await harness();
  try {
    const out = saveChannels([{ ...OK_ENTRY, id: "next" }], h.deps);
    assert.equal(out.ok, true);
    assert.deepEqual(h.onDisk().channels, [{ ...OK_ENTRY, id: "next" }]);
    // _readme 是字段说明，不是我们的东西，不能顺手丢掉。
    assert.deepEqual(h.onDisk()._readme, ["keep me"]);
    assert.equal(h.reloads(), 1);
  } finally {
    h.cleanup();
  }
});

test("apiKey 以 env.NAME 形态往返，真密钥不进配置文件", async () => {
  process.env.BCP_TEST_ADMIN_KEY = "sk-super-secret";
  const h = await harness();
  try {
    const entry = { ...OK_ENTRY, apiKey: "env.BCP_TEST_ADMIN_KEY" };
    const out = saveChannels([entry], h.deps) as { channels: { apiKey?: string }[] };
    // 落盘的是引用。
    assert.equal((h.onDisk().channels[0] as { apiKey?: string }).apiKey, "env.BCP_TEST_ADMIN_KEY");
    // 回给界面的也是引用 —— 管理面读的是原始声明，不是解析后的表。
    assert.equal(out.channels[0].apiKey, "env.BCP_TEST_ADMIN_KEY");
    assert.doesNotMatch(JSON.stringify(out), /sk-super-secret/);
    assert.doesNotMatch(readFileSync(h.path, "utf8"), /sk-super-secret/);
  } finally {
    delete process.env.BCP_TEST_ADMIN_KEY;
    h.cleanup();
  }
});

test("env 引用解不出来时拒绝保存 —— 保存成功却起不来是最糟的结果", async () => {
  const h = await harness();
  try {
    assert.throws(
      () => saveChannels([{ ...OK_ENTRY, apiKey: "env.DEFINITELY_NOT_SET_XYZ" }], h.deps),
      /DEFINITELY_NOT_SET_XYZ is not set/,
    );
    assert.equal(h.reloads(), 0);
  } finally {
    h.cleanup();
  }
});

test("body 不是数组时是 400 级错误，不是 500", async () => {
  const h = await harness();
  try {
    assert.throws(() => saveChannels({ nope: true }, h.deps), RequestError);
  } finally {
    h.cleanup();
  }
});

test("一键测试走完整调用链；上游报错是「结果」不是「接口坏了」", async () => {
  const h = await harness();
  try {
    const ok = await testChannel("vendor", h.deps);
    assert.equal(ok.ok, true);
    assert.equal(ok.reply, "收到");

    // 打 /v1/models 通不代表这条渠道能出货：模型名写错、鉴权过期、适配器映射坏掉
    // 都只在真发一次时才暴露。所以失败也要如实带回报错文本。
    const failing: AdminDeps = {
      ...h.deps,
      chat: async () => { throw new Error("HTTP 401 — invalid api key"); },
    };
    const bad = await testChannel("vendor", failing);
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /invalid api key/);
  } finally {
    h.cleanup();
  }
});

test("测试一个不存在的渠道是 404", async () => {
  const h = await harness();
  try {
    await assert.rejects(testChannel("nope", h.deps), /unknown channel "nope"/);
  } finally {
    h.cleanup();
  }
});

test("拉模型：能拉就拉，拉不了如实说，绝不编一份列表", async () => {
  const h = await harness();
  const realFetch = globalThis.fetch;
  const DRAFT = { adapter: "openai", baseUrl: "https://api.example.com", model: "m" };
  try {
    globalThis.fetch = (async () =>
      Response.json({ data: [{ id: "gpt-5.6" }, { id: "gpt-6" }, { id: 42 }] })) as typeof fetch;
    const listed = await probeUpstreamModels(DRAFT, h.deps);
    assert.equal(listed.supported, true);
    // 非字符串的 id 被过滤掉，不是原样塞进下拉。
    assert.deepEqual(listed.models, ["gpt-5.6", "gpt-6"]);

    // 适配器没有这个能力时说 supported:false —— 编一份比没有更糟。
    const none = await probeUpstreamModels({ adapter: "opencode", model: "m" }, h.deps);
    assert.equal(none.supported, false);
    assert.deepEqual(none.models, []);

    // 上游挂了也不编：带上报错，列表为空。
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const broken = await probeUpstreamModels(DRAFT, h.deps);
    assert.deepEqual(broken.models, []);
    assert.match(String(broken.error), /HTTP 500/);
  } finally {
    globalThis.fetch = realFetch;
    h.cleanup();
  }
});

test("拉模型不要求渠道已保存 —— 这正是那个鸡生蛋", async () => {
  const h = await harness();
  const realFetch = globalThis.fetch;
  let sentTo = "";
  let sentAuth = "";
  process.env.PROBE_KEY = "probe-secret";
  try {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      sentTo = String(url);
      sentAuth = String(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({ data: [{ id: "gemini-3.1-pro" }] });
    }) as unknown as typeof fetch;

    // 连 id 和 model 都没有——新增一行、只填了 baseUrl 与 apiKey 的那一刻。
    // 旧接口按 id 从运行中的表里 find，这里必然 404；而保存又要求先有模型名。
    const fresh = await probeUpstreamModels(
      { adapter: "openai", baseUrl: "https://vendor.example", apiKey: "env.PROBE_KEY" },
      { ...h.deps, current: () => [] },
    );
    assert.deepEqual(fresh.models, ["gemini-3.1-pro"], "没保存也该拉得到");
    assert.equal(sentTo, "https://vendor.example/v1/models", "打的是这份声明里的 baseUrl");
    // `env.NAME` 必须在网关这一侧解引用：界面只知道名字，真值不出这台机器。
    assert.equal(sentAuth, "Bearer probe-secret", "env 引用被解成了真值再发出去");

    // 半截声明是常态（用户正在打字），要给一句人话，不是把占位 id 端到脸上。
    const noUrl = await probeUpstreamModels({ adapter: "openai" }, h.deps);
    assert.deepEqual(noUrl.models, []);
    assert.match(String(noUrl.reason), /baseUrl/);
    assert.doesNotMatch(JSON.stringify(noUrl), /probe/, "占位 id 不该泄漏到文案里");

    // 未知键照样拒——这份声明下一步就要拿去发真实请求。
    const typo = await probeUpstreamModels({ adapter: "openai", baseURL: "https://x" }, h.deps);
    assert.match(String(typo.error), /baseURL/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.PROBE_KEY;
    h.cleanup();
  }
});

test("describeAdapters 告诉界面每种适配器要填什么", async () => {
  const registry = await loadRegistry();
  const described = describeAdapters(registry) as {
    name: string; kind: string; needsBaseUrl: boolean; canListModels: boolean; options: unknown[];
  }[];
  const byName = new Map(described.map((d) => [d.name, d]));
  // HTTP 的要 baseUrl 且能列模型；CLI 的两样都没有——界面据此隐藏输入框和下拉。
  const openai = byName.get("openai");
  assert.equal(openai?.kind, "http");
  assert.equal(openai?.needsBaseUrl, true);
  assert.equal(openai?.canListModels, true);
  // options 是给界面画表单用的，必须带着声明过的那些键。
  assert.deepEqual(openai?.options, [{ key: "maxTokensField", type: "string" }]);
  assert.equal(byName.get("opencode")?.kind, "direct");
  assert.equal(byName.get("opencode")?.needsBaseUrl, false);
  assert.equal(byName.get("opencode")?.canListModels, false);
});

test("listSecretEnvNames 只回名字，且不回不该回的", () => {
  const names = listSecretEnvNames({
    AIHUB_API_KEY: "sk-real-secret",
    VULCAN_TOKEN: "tok-real-secret",
    DB_PASSWORD: "pw",
    // 这台机器上装了什么、内网服务叫什么，下拉一栏没必要知道。
    HOME: "/root",
    PATH: "/usr/bin",
    BCP_LLM_PORT: "11435",
    // 空值的名字选了也会在 parseChannel 里 fail closed，不如不给。
    EMPTY_API_KEY: "",
    UNSET_TOKEN: undefined,
  });
  assert.deepEqual(names, ["AIHUB_API_KEY", "DB_PASSWORD", "VULCAN_TOKEN"], "按名字过滤 + 排序");
  // 最要紧的一条：这个接口的返回值会原样发到浏览器。任何一个真值漏进去，
  // 密钥就从「不出这台机器」变成了「在别人的 devtools 里」。
  const serialized = JSON.stringify(names);
  assert.doesNotMatch(serialized, /sk-real-secret|tok-real-secret|\bpw\b/, "绝不能带上值");
});
