/**
 * Channel table tests.
 *
 * The load-bearing assertions here are the fail-closed ones: an unresolved
 * `env.NAME` and an unknown model must both stop the request rather than
 * proceed with something plausible. Mutation check — make resolveSecret fall
 * back to undefined, or pickChannel return channels[0], and these go red.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ollamaAdapter } from "./adapters/ollama.js";
import {
  LOCAL_CHANNEL_ID,
  candidateChannels,
  loadChannels,
  localChannel,
  parseAliases,
  parseChannel,
  parseLimits,
  patchConfig,
  pickChannel,
  readRawAliases,
  readRawChannels,
  readRawLimits,
  resolveModel,
  resolveSecret,
  channelLabel,
  managedChannels,
  servedModels,
  validateAliases,
  validateChannelOptions,
  writeRawChannels,
} from "./channels.js";
import type { EffectiveRuntime } from "./runtime-profile.js";

const OLLAMA_RUNTIME: EffectiveRuntime = {
  profile: "legacy-local",
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11435",
  apiStyle: "ollama",
  model: "qwen3.5:4b",
  contextLength: 0,
};

const LMSTUDIO_RUNTIME: EffectiveRuntime = {
  ...OLLAMA_RUNTIME,
  profile: "mac-apple-silicon-16gb",
  provider: "lmstudio",
  model: "qwen3.5-9b",
  contextLength: 32768,
};

function withFile(contents: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "bcp-channels-"));
  const path = join(dir, "channels.json");
  writeFileSync(path, contents);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveSecret dereferences env.NAME and fails closed when unset", () => {
  assert.equal(resolveSecret("env.MY_KEY", { MY_KEY: "sk-abc" }, "c[0]"), "sk-abc");
  assert.equal(resolveSecret("sk-literal", {}, "c[0]"), "sk-literal");
  assert.equal(resolveSecret(undefined, {}, "c[0]"), undefined);
  // Not "resolves to undefined and gets sent without auth" — that would surface
  // as an opaque 401 from the vendor much later.
  assert.throws(() => resolveSecret("env.MISSING", {}, "c[0]"), /MISSING is not set/);
});

test("parseChannel defaults model to id and strips trailing slashes from baseUrl", () => {
  const channel = parseChannel(
    { id: "vendor", adapter: "openai", baseUrl: "https://api.example.com//" },
    0,
    {},
  );
  assert.equal(channel.model, "vendor");
  assert.equal(channel.baseUrl, "https://api.example.com");
});

test("a misspelled key is rejected with the key it was probably meant to be", () => {
  // Silently ignoring it is how `modle` leaves model defaulting to the channel
  // id, and `num_ctx` leaves the context window unset — both failing far from
  // their cause.
  assert.throws(
    () => parseChannel({ id: "x", adapter: "openai", baseUrl: "http://h", baseURL: "http://h" }, 0, {}),
    /unknown key "baseURL" — did you mean "baseUrl"\?/,
  );
  assert.throws(
    () => parseChannel({ id: "x", adapter: "openai", baseUrl: "http://h", modle: "m" }, 0, {}),
    /unknown key "modle" — valid keys: id, adapter, baseUrl, apiKey, model, options/,
  );
});

test("options must be an object, not a string that looks like one", () => {
  assert.throws(
    () => parseChannel({ id: "x", adapter: "openai", baseUrl: "http://h", options: "numCtx=1" }, 0, {}),
    /options must be an object/,
  );
});

test("channel options are checked against what the adapter declares", () => {
  const ok = parseChannel(
    { id: "x", adapter: "ollama", baseUrl: "http://h", options: { numCtx: 32768, think: true } },
    0,
    {},
  );
  assert.doesNotThrow(() => validateChannelOptions(ok, ollamaAdapter));

  // The one-character typo that used to cost 30k of context on every request.
  const typo = parseChannel(
    { id: "x", adapter: "ollama", baseUrl: "http://h", options: { num_ctx: 32768 } },
    0,
    {},
  );
  assert.throws(() => validateChannelOptions(typo, ollamaAdapter), /did you mean "numCtx"\?/);

  // `"think": "true"` reads as enabled and behaves as disabled.
  const wrongType = parseChannel(
    { id: "x", adapter: "ollama", baseUrl: "http://h", options: { think: "true" } },
    0,
    {},
  );
  assert.throws(() => validateChannelOptions(wrongType, ollamaAdapter), /must be a boolean, got string/);

  // An adapter that declares nothing keeps accepting anything.
  assert.doesNotThrow(() => validateChannelOptions(typo, { ...ollamaAdapter, options: undefined }));
});

test("parseChannel rejects entries missing a required field", () => {
  assert.throws(() => parseChannel({ adapter: "openai", baseUrl: "x" }, 3, {}), /channels\[3\]: 至少要有 model/);
  assert.throws(() => parseChannel({ id: "a", baseUrl: "x" }, 0, {}), /adapter/);
  // baseUrl is NOT required here — a CLI-backed channel has no URL. The boot
  // check requires it for the adapters that speak HTTP, where the error can
  // name which adapter needed it.
  assert.equal(parseChannel({ id: "a", adapter: "opencode" }, 0, {}).baseUrl, undefined);
  // Present but empty is still a mistake.
  assert.throws(() => parseChannel({ id: "a", adapter: "openai", baseUrl: "" }, 0, {}), /baseUrl/);
});

test("local channel: ollama gets its internal port and the numCtx the OpenAI wire has no field for", () => {
  const channel = localChannel(OLLAMA_RUNTIME, { BCP_LLM_NUM_CTX: "32768" });
  // 对外就叫它自己的模型名——"本机后端"不是调用方要学的概念。
  assert.equal(channel.id, OLLAMA_RUNTIME.model);
  assert.equal(channel.adapter, "ollama");
  // Not BCP_LLM_PORT — that belongs to the gateway now.
  assert.equal(channel.baseUrl, "http://127.0.0.1:11437");
  assert.equal(channel.options?.numCtx, 32768);
});

test("local channel: lmstudio carries no numCtx (the window is fixed at load time)", () => {
  const channel = localChannel(LMSTUDIO_RUNTIME, {});
  assert.equal(channel.adapter, "lmstudio");
  assert.equal(channel.baseUrl, "http://127.0.0.1:11436");
  assert.equal(channel.options?.numCtx, undefined);
});

test("loadChannels appends the derived local channel and resolves secrets", () => {
  withFile(
    JSON.stringify({
      channels: [
        { id: "vendor", adapter: "openai", baseUrl: "https://api.example.com", apiKey: "env.VK" },
      ],
    }),
    (path) => {
      const channels = loadChannels({
        channelsPath: path,
        env: { VK: "sk-real", BCP_LLM_NUM_CTX: "8192" },
        runtime: OLLAMA_RUNTIME,
      });
      assert.deepEqual(channels.map((c) => c.id), ["vendor", OLLAMA_RUNTIME.model]);
      assert.equal(channels[0].apiKey, "sk-real");
      assert.equal(channels[1].options?.numCtx, 8192);
    },
  );
});

test("管理视图单独返回运行时派生的本地渠道", () => {
  const declared = [{ id: "vendor", adapter: "openai", baseUrl: "https://api.example.com" }];
  const effective = [
    parseChannel(declared[0], 0, {}),
    localChannel(OLLAMA_RUNTIME, { BCP_LLM_NUM_CTX: "32768" }),
  ];

  assert.deepEqual(managedChannels(declared, effective), [effective[1]]);
});

test("重名不再是错误 —— 它就是「多个来源」的写法", () => {
  withFile(
    JSON.stringify({
      channels: [
        { id: "dup", adapter: "openai", baseUrl: "http://a" },
        { id: "dup", adapter: "openai", baseUrl: "http://b" },
      ],
    }),
    (path) => {
      const channels = loadChannels({ channelsPath: path, env: {}, runtime: OLLAMA_RUNTIME });
      assert.equal(channels.filter((c) => c.id === "dup").length, 2);
      assert.deepEqual(servedModels(channels), ["dup", "qwen3.5:4b"]);
    },
  );
});

test("loadChannels 仍然拒绝坏 JSON", () => {
  withFile("{ not json", (path) => {
    assert.throws(() => loadChannels({ channelsPath: path, env: {} }), /not valid JSON/);
  });
});

test("a missing channels.json is not an error — the local channel still serves", () => {
  const channels = loadChannels({
    channelsPath: join(tmpdir(), "definitely-absent-channels.json"),
    env: {},
    runtime: OLLAMA_RUNTIME,
  });
  assert.deepEqual(channels.map((c) => c.id), [OLLAMA_RUNTIME.model]);
});

test("id 就是调用方写的模型名；不写就默认等于上游模型名", () => {
  // 大多数时候你不用起名。
  const plain = parseChannel({ adapter: "openai", baseUrl: "http://h", model: "gpt-5.6" }, 0, {});
  assert.equal(plain.id, "gpt-5.6");
  assert.equal(plain.model, "gpt-5.6");
  // 想把两个同名上游区分开，就给它起个对外的名字。
  const named = parseChannel({ id: "gpt-5.6-aihub", adapter: "openai", baseUrl: "http://h", model: "gpt-5.6" }, 0, {});
  assert.equal(named.id, "gpt-5.6-aihub");
  assert.equal(named.model, "gpt-5.6", "上游要的仍然是它自己的名字");
  // 反过来只给 id 也行，上游按同名请求。
  assert.equal(parseChannel({ id: "solo", adapter: "openai", baseUrl: "http://h" }, 0, {}).model, "solo");
  // 两个都没有就没法路由，也没法请求。
  assert.throws(() => parseChannel({ adapter: "openai", baseUrl: "http://h" }, 0, {}), /至少要有 model/);
});

test("按调用方写的模型名路由；错了就列出所有能写的", () => {
  const channels = loadChannels({ channelsPath: "/nope", env: {}, runtime: OLLAMA_RUNTIME });
  assert.equal(pickChannel(channels, "qwen3.5:4b").adapter, "ollama");
  assert.throws(() => pickChannel(channels, "qwen3.5:9b"), /available models: qwen3\.5:4b/);
  assert.throws(() => pickChannel(channels, ""), /"model" must be a non-empty string/);
});

test("同名 = 同一个模型的多个来源，请求轮流落地", () => {
  const channels = [
    { id: "gpt", adapter: "openai", baseUrl: "https://a.example", model: "gpt", apiKey: "k1" },
    { id: "gpt", adapter: "openai", baseUrl: "https://b.example", model: "gpt", apiKey: "k2" },
    { id: "other", adapter: "openai", baseUrl: "https://c.example", model: "other" },
  ];
  const cursor = new Map<string, number>();
  // 不用配权重、不用起组名：加一条同名渠道就自动分摊。
  assert.deepEqual(
    [0, 1, 2, 3].map(() => channelLabel(pickChannel(channels, "gpt", cursor))),
    ["gpt@a.example", "gpt@b.example", "gpt@a.example", "gpt@b.example"],
  );
  // 只有一条来源时不消耗游标 —— 免得单来源的模型把 Map 撑大。
  assert.equal(pickChannel(channels, "other", cursor).id, "other");
  assert.equal(cursor.has("other"), false);
});

test("不给 cursor 时稳定落在第一条，不是随机", () => {
  const channels = [
    { id: "gpt", adapter: "openai", baseUrl: "https://a.example", model: "gpt" },
    { id: "gpt", adapter: "openai", baseUrl: "https://b.example", model: "gpt" },
  ];
  assert.deepEqual(
    [0, 1, 2].map(() => channelLabel(pickChannel(channels, "gpt"))),
    ["gpt@a.example", "gpt@a.example", "gpt@a.example"],
  );
});

test("channelLabel 让同名的多个来源在日志里分得开", () => {
  // 出问题时第一个要回答的就是"这次是哪条渠道服务的"。
  assert.equal(
    channelLabel({ id: "gpt-5.6", adapter: "openai", baseUrl: "https://aihub.top", model: "gpt-5.6" }),
    "gpt-5.6@aihub.top",
  );
  // CLI 渠道没有 URL，用适配器名兜底，而不是留空。
  assert.equal(
    channelLabel({ id: "oc", adapter: "opencode", model: "m" }),
    "oc@opencode",
  );
});

test("servedModels 去重 —— 两条渠道提供同一个模型，对外只是一个模型", () => {
  assert.deepEqual(
    servedModels([
      { id: "gpt", adapter: "openai", baseUrl: "http://a", model: "gpt" },
      { id: "gpt", adapter: "openai", baseUrl: "http://b", model: "gpt" },
      { id: "other", adapter: "openai", baseUrl: "http://c", model: "other" },
    ]),
    ["gpt", "other"],
  );
});

test("你自己配了同名模型时，推导的本机渠道不再挤进来", () => {
  withFile(
    JSON.stringify({ channels: [{ id: "qwen3.5:4b", adapter: "openai", baseUrl: "http://mine" }] }),
    (path) => {
      const channels = loadChannels({ channelsPath: path, env: {}, runtime: OLLAMA_RUNTIME });
      // 你显式配了它，说明你想自己控制；推导的那条不该再和它轮询。
      assert.equal(channels.length, 1);
      assert.equal(channels[0].baseUrl, "http://mine");
    },
  );
});

// --- 渠道新增字段（并发 / 单价 / 能力标签）-------------------------------

test("maxConcurrency 必须是正整数，写错就别启动", () => {
  const ok = parseChannel({ adapter: "openai", model: "m", maxConcurrency: 4 }, 0, {});
  assert.equal(ok.maxConcurrency, 4);
  for (const bad of [0, -1, 1.5, "4", null]) {
    // 0 不是「更小的上限」，它是一个会让这条渠道上每个请求永远排队的 typo。
    assert.throws(
      () => parseChannel({ adapter: "openai", model: "m", maxConcurrency: bad }, 0, {}),
      /maxConcurrency must be a positive integer/,
      JSON.stringify(bad),
    );
  }
});

test("pricing 收非负数字，拒字符串与未知键", () => {
  const ok = parseChannel(
    { adapter: "openai", model: "m", pricing: { inputPer1M: 3, outputPer1M: 15, currency: "USD" } },
    0,
    {},
  );
  assert.deepEqual(ok.pricing, { inputPer1M: 3, outputPer1M: 15, currency: "USD" });

  // 0 是合法的：免费档「声明为免费」和「没声明」是两件不同的事。
  assert.deepEqual(
    parseChannel({ adapter: "openai", model: "m", pricing: { inputPer1M: 0, outputPer1M: 0 } }, 0, {})
      .pricing,
    { inputPer1M: 0, outputPer1M: 0 },
  );

  // "0.5" 会在乘法里变成字符串拼接，算出一个看着很正常的错数字。
  assert.throws(
    () => parseChannel({ adapter: "openai", model: "m", pricing: { inputPer1M: "0.5", outputPer1M: 1 } }, 0, {}),
    /inputPer1M must be a non-negative number/,
  );
  assert.throws(
    () => parseChannel({ adapter: "openai", model: "m", pricing: { inputPer1M: -1, outputPer1M: 1 } }, 0, {}),
    /inputPer1M must be a non-negative number/,
  );
  assert.throws(
    () => parseChannel({ adapter: "openai", model: "m", pricing: { input: 1, outputPer1M: 1 } }, 0, {}),
    /unknown key "input"/,
  );
  assert.throws(
    () => parseChannel({ adapter: "openai", model: "m", pricing: [1, 2] }, 0, {}),
    /pricing must be an object/,
  );
});

test("capabilities 是字符串数组，别的形状一律拒", () => {
  assert.deepEqual(
    parseChannel({ adapter: "openai", model: "m", capabilities: ["vision", " json "] }, 0, {})
      .capabilities,
    ["vision", "json"],
  );
  assert.throws(
    () => parseChannel({ adapter: "openai", model: "m", capabilities: "vision" }, 0, {}),
    /capabilities must be an array of strings/,
  );
  assert.throws(
    () => parseChannel({ adapter: "openai", model: "m", capabilities: [1] }, 0, {}),
    /capabilities\[0\] must be a non-empty string/,
  );
});

// --- 用途别名 -------------------------------------------------------------

test("parseAliases 收一层映射，拒空名与非字符串目标", () => {
  assert.deepEqual(parseAliases({ "task.vision": " opencode/x " }), { "task.vision": ["opencode/x"] });
  // 数组是完整形态，字符串只是单元素的简写。
  assert.deepEqual(parseAliases({ a: ["m1", "m2"] }), { a: ["m1", "m2"] });
  assert.deepEqual(parseAliases({ a: ["m", "m"] }), { a: ["m"] }, "同一条链里重复列一个模型没有意义");
  assert.deepEqual(parseAliases(undefined), {});
  assert.throws(() => parseAliases(["a"]), /"aliases" must be an object/);
  assert.throws(() => parseAliases({ "": "m" }), /别名不能是空字符串/);
  assert.throws(() => parseAliases({ a: 1 }), /\[0\] must be a non-empty string/);
  assert.throws(() => parseAliases({ a: [] }), /至少要指向一个模型/);
});

test("别名指向不存在的模型 = 拒绝启动（`local` 那次事故的正解）", () => {
  const channels = [parseChannel({ adapter: "openai", baseUrl: "http://x", model: "real" }, 0, {})];
  // 当年这条别名坏掉时不报错在定义处，只在每一次调用处变成 404。
  assert.throws(
    () => validateAliases({ "task.text": ["gone"] }, channels),
    /alias "task\.text" -> "gone"[\s\S]*real/,
  );
  assert.doesNotThrow(() => validateAliases({ "task.text": ["real"] }, channels));
});

test("别名与真实模型重名 = 拒绝启动（否则它永远不生效且一声不吭）", () => {
  const channels = [parseChannel({ adapter: "openai", baseUrl: "http://x", model: "real" }, 0, {})];
  // pickChannel 先匹配真实模型名，所以这条别名一辈子轮不到——「配错了却能跑」
  // 比「跑不起来」难查得多。
  assert.throws(() => validateAliases({ real: ["real"] }, channels), /与一个真实模型名重名/);
});

test("resolveModel 只翻一层，返回的是一条链", () => {
  assert.deepEqual(resolveModel("task.v", { "task.v": ["m"] }), ["m"]);
  assert.deepEqual(resolveModel("task.v", { "task.v": ["a", "b"] }), ["a", "b"]);
  // 不是别名就返回它自己（单元素链）。
  assert.deepEqual(resolveModel("m", { "task.v": ["m"] }), ["m"]);
  assert.deepEqual(resolveModel("m", undefined), ["m"]);
});

test("candidateChannels 按轮询起点旋转出完整的尝试顺序", () => {
  const a = parseChannel({ id: "m", adapter: "openai", baseUrl: "http://a", model: "u" }, 0, {});
  const b = parseChannel({ id: "m", adapter: "openai", baseUrl: "http://b", model: "u" }, 1, {});
  const c = parseChannel({ id: "m", adapter: "openai", baseUrl: "http://c", model: "u" }, 2, {});
  const cursor = new Map<string, number>();
  const hosts = () => candidateChannels([a, b, c], "m", cursor).map((x) => x.baseUrl);

  // 每次换一个起点，但**整条列表**都在——failover 要的正是后面那几条。
  assert.deepEqual(hosts(), ["http://a", "http://b", "http://c"]);
  assert.deepEqual(hosts(), ["http://b", "http://c", "http://a"]);
  assert.deepEqual(hosts(), ["http://c", "http://a", "http://b"]);
});

test("candidateChannels 走别名，404 里同时说清别名与解析结果", () => {
  const real = parseChannel({ adapter: "openai", baseUrl: "http://x", model: "real" }, 0, {});
  const aliases = { "task.text": ["real"] };
  assert.equal(candidateChannels([real], "task.text", undefined, aliases)[0], real);

  assert.throws(
    () => candidateChannels([real], "task.missing", undefined, aliases),
    /unknown model "task\.missing"[\s\S]*available models: real[\s\S]*aliases: task\.text/,
  );
});

test("parseLimits 校验全局上限", () => {
  assert.deepEqual(parseLimits({ maxConcurrency: 8 }), { maxConcurrency: 8 });
  assert.deepEqual(parseLimits(undefined), {});
  assert.throws(() => parseLimits({ maxConcurrency: 0 }), /positive integer/);
  // 拼写建议只覆盖大小写 / 分隔符这类差异（normaliseKey 的定义），那也正是
  // 配置文件里真正会发生的那类手误。
  assert.throws(() => parseLimits({ max_concurrency: 8 }), /did you mean "maxConcurrency"/);
  // 差得更远的就只列出可选键，不硬猜。
  assert.throws(() => parseLimits({ maxConcurrent: 8 }), /valid keys: maxConcurrency/);
});

// --- 配置文件的三块互不覆盖 ----------------------------------------------

test("保存渠道不会抹掉别名 / 上限 / _readme", () => {
  withFile(
    JSON.stringify({
      _readme: ["说明"],
      aliases: { "task.text": "real" },
      limits: { maxConcurrency: 8 },
      channels: [{ adapter: "openai", baseUrl: "http://x", model: "real" }],
    }),
    (path) => {
      writeRawChannels([{ adapter: "openai", baseUrl: "http://y", model: "real2" }], path);
      // 三块配置由三个不同的管理面动作分别保存；任何一个「整份重写」都会静默
      // 干掉另外两块，而那种丢失没有报错，只会在下次启动时表现成「我配的别名呢」。
      assert.deepEqual(readRawAliases(path), { "task.text": "real" });
      assert.deepEqual(readRawLimits(path), { maxConcurrency: 8 });
      assert.deepEqual(readRawChannels(path), [
        { adapter: "openai", baseUrl: "http://y", model: "real2" },
      ]);
    },
  );
});

test("patchConfig 只动它提到的那个顶层键", () => {
  withFile(JSON.stringify({ channels: [], aliases: { a: "b" } }), (path) => {
    patchConfig({ limits: { maxConcurrency: 2 } }, path);
    assert.deepEqual(readRawAliases(path), { a: "b" });
    assert.deepEqual(readRawLimits(path), { maxConcurrency: 2 });
  });
});

// --- 别名备胎链 ---------------------------------------------------------

test("备胎链把候选跨模型拼起来：首选的渠道排在前面", () => {
  const a1 = parseChannel({ id: "A", adapter: "openai", baseUrl: "http://a1", model: "u" }, 0, {});
  const a2 = parseChannel({ id: "A", adapter: "openai", baseUrl: "http://a2", model: "u" }, 1, {});
  const b1 = parseChannel({ id: "B", adapter: "openai", baseUrl: "http://b1", model: "u" }, 2, {});
  const aliases = { task: ["A", "B"] };

  // 首选 A 的**每一条**渠道都排在备胎 B 的前面：failover 照着列表往下走，于是
  // 「A 全试过了才动 B」这件事不需要它知道备胎的存在。
  assert.deepEqual(
    candidateChannels([a1, a2, b1], "task", undefined, aliases).map((c) => c.baseUrl),
    ["http://a1", "http://a2", "http://b1"],
  );
});

test("备胎链里每个目标各自轮询，互不带偏", () => {
  const a1 = parseChannel({ id: "A", adapter: "openai", baseUrl: "http://a1", model: "u" }, 0, {});
  const a2 = parseChannel({ id: "A", adapter: "openai", baseUrl: "http://a2", model: "u" }, 1, {});
  const b1 = parseChannel({ id: "B", adapter: "openai", baseUrl: "http://b1", model: "u" }, 2, {});
  const b2 = parseChannel({ id: "B", adapter: "openai", baseUrl: "http://b2", model: "u" }, 3, {});
  const cursor = new Map<string, number>();
  const hosts = () =>
    candidateChannels([a1, a2, b1, b2], "task", cursor, { task: ["A", "B"] }).map((c) => c.baseUrl);

  assert.deepEqual(hosts(), ["http://a1", "http://a2", "http://b1", "http://b2"]);
  // 两个目标各自推进自己的游标。
  assert.deepEqual(hosts(), ["http://a2", "http://a1", "http://b2", "http://b1"]);
});

test("链上少了一个目标不影响其余，全都没有才 404", () => {
  const b1 = parseChannel({ id: "B", adapter: "openai", baseUrl: "http://b1", model: "u" }, 0, {});
  // A 没有任何渠道（比如刚被删掉），但 B 还在 —— 这时仍然要能服务。
  assert.deepEqual(
    candidateChannels([b1], "task", undefined, { task: ["A", "B"] }).map((c) => c.baseUrl),
    ["http://b1"],
  );
  assert.throws(
    () => candidateChannels([b1], "task", undefined, { task: ["A", "C"] }),
    /unknown model "task" \(alias -> A -> C\)/,
  );
});

test("备胎链上的每一个都要在启动时校验，不只是首选", () => {
  const real = parseChannel({ adapter: "openai", baseUrl: "http://x", model: "real" }, 0, {});
  // 一条永远指不到东西的备胎，只会在首选真的挂掉的那一刻才暴露 —— 那正是最不该
  // 再出意外的时刻。
  assert.throws(() => validateAliases({ t: ["real", "gone"] }, [real]), /-> "gone"/);
  assert.doesNotThrow(() => validateAliases({ t: ["real"] }, [real]));
});
