/**
 * opencode adapter tests — a fake server, no subprocess and no network.
 *
 * Two groups of assertions matter here:
 *
 *   - the isolation layers this file still owns (`tools`, `system`). The other
 *     two (working directory, HOME) are properties of the server PROCESS and
 *     belong to scripts/opencode.sh; asserting them here would only test a
 *     constant.
 *   - statelessness. A fresh session per request, deleted afterwards, is what
 *     keeps this channel a plain model rather than a box with hidden memory.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { composeSystem, createOpenCodeAdapter, splitMessages, splitModel } from "./opencode.js";
import { type ChannelConfig, type JsonRecord } from "./types.js";

const CHANNEL: ChannelConfig = {
  id: "oc",
  adapter: "opencode",
  model: "opencode/mimo-v2.5-free",
};

type Call = { method: string; url: string; body: JsonRecord | undefined };

/** A server that answers `text`, recording every call it received. */
function withFakeServer(reply: string | JsonRecord | (() => never)) {
  const calls: Call[] = [];
  const adapter = createOpenCodeAdapter(async (method, url, body) => {
    calls.push({ method, url, body });
    if (method === "POST" && url.endsWith("/session")) return { id: "ses_test" };
    if (method === "DELETE") return {};
    if (typeof reply === "function") return reply();
    if (typeof reply === "object") return reply;
    return { parts: [{ type: "text", text: reply }] };
  });
  return { adapter, calls };
}

const HI = { model: "oc", messages: [{ role: "user", content: "你好" }] };
const prompted = (calls: Call[]): Call => calls.find((c) => c.url.includes("/message"))!;

test("the isolation layers this adapter owns ride in the request body", async () => {
  const { adapter, calls } = withFakeServer("答案");
  await adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000));

  const body = prompted(calls).body!;
  // 1. tools are pinned per REQUEST, not delegated to the agent definition — a
  //    change there could go silent and the model starts emitting tool calls
  //    into what we treat as prose.
  //
  //    The set must be NON-EMPTY: `{"*": false}` is a whitelist with no keys,
  //    and Zen's free tier answers an empty tool set with 403 FreeTierError
  //    ("free tier can only be used from within OpenCode"). `todoread` is the
  //    one harmless key — read-only, over a list this channel never fills.
  //    Full matrix in the adapter's `tools` comment; this assertion is what
  //    stops someone "tidying" it back into `{"*": false}`.
  assert.deepEqual(body.tools, { todoread: true });
  assert.ok(Object.keys(body.tools as JsonRecord).length > 0, "non-empty tool set is load-bearing");
  // 4. the preamble is always present, whether or not the caller sent a system
  //    message. Without it the model falls back to opencode's agent framing.
  assert.match(String(body.system), /没有文件读写/);
});

test("沙盒 agent 定义里的工具集同样必须非空 —— 两侧是合并不是二选一", () => {
  // A request-level `{"todoread": true}` under an agent-level `{"*": false}` is
  // STILL a 403 (measured). The two are merged, so an empty set on either side
  // empties the result — assert the shipped agent config keeps a key in it.
  const config = readFileSync(
    fileURLToPath(new URL("../../opencode-sandbox/opencode.json", import.meta.url)),
    "utf8",
  );
  const agent = JSON.parse(config.replace(/^\s*\/\/.*$/gm, "")) as JsonRecord;
  const tools = ((agent.agent as JsonRecord).llm as JsonRecord).tools as JsonRecord;
  assert.deepEqual(tools, { todoread: true });
});

test("agent 必须带上 —— 少了它 opencode 会用自己的框架回答", async () => {
  // 这条钉的是一次真实回归：把 agent 默认值去掉之后，短提示词的回答看着完全
  // 正常（"北京"），只有 252KB 的长提示词才暴露 —— 模型回了「我是 opencode，
  // 专注于帮助软件工程工作」。prompt_tokens 也从 5817 涨到 9870，因为 opencode
  // 自带的 agent 提示词还在。`system` 字段是【追加】在它旁边，不是取代它；
  // 取代它的是工作目录里 opencode.json 定义的这个 agent。
  const { adapter, calls } = withFakeServer("答案");
  await adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000));
  assert.equal(prompted(calls).body!.agent, "llm");

  const custom = withFakeServer("答案");
  await custom.adapter.invoke(HI, { ...CHANNEL, options: { agent: "other" } }, AbortSignal.timeout(5000));
  assert.equal(prompted(custom.calls).body!.agent, "other");
});

test("每次调用都是全新 session，用完即删 —— 渠道必须是纯函数", async () => {
  const { adapter, calls } = withFakeServer("答案");
  await adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000));

  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url.replace(/^https?:\/\/[^/]+/, "")}`),
    ["POST /session", "POST /session/ses_test/message", "DELETE /session/ses_test"],
  );
  // 复用 session 会让同一个请求因为看不见的历史给出不同答案，两个调用方共用
  // 这条渠道还会互相污染。session 是一次性信封，不是记忆。
  assert.equal(prompted(calls).body!.sessionID, undefined);
});

test("session 在调用失败时同样被删掉，不留垃圾", async () => {
  const { adapter, calls } = withFakeServer(() => {
    throw new Error("opencode server returned HTTP 500: boom");
  });
  await assert.rejects(adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000)), /boom/);
  assert.ok(
    calls.some((c) => c.method === "DELETE"),
    "失败路径漏删 session，库会随着每次报错一直涨",
  );
});

test("提示词不再有长度上限 —— 这是整次改造的目的", async () => {
  // argv 时代这里会抛 `caps at 131072`：Linux 单个 argv 字符串卡在 32 页。
  // 走 HTTP body 之后没有这个天花板，实测 252082 字节可以往返。
  const { adapter, calls } = withFakeServer("ok");
  const huge = "把这段话重复很多遍。".repeat(30_000);
  assert.ok(Buffer.byteLength(huge) > 131_072, "这条测试的输入必须真的超过 argv 上限才有意义");
  await adapter.invoke(
    { model: "oc", messages: [{ role: "user", content: huge }] },
    CHANNEL,
    AbortSignal.timeout(5000),
  );
  const parts = prompted(calls).body!.parts as JsonRecord[];
  assert.equal(parts[0].text, huge, "提示词必须原样送达，不能被截断");
});

test("模型按 provider/model 拆成两个字段；variant 只在配置了才带", async () => {
  const plain = withFakeServer("ok");
  await plain.adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000));
  assert.deepEqual(prompted(plain.calls).body!.model, {
    providerID: "opencode",
    modelID: "mimo-v2.5-free",
  });
  assert.equal(prompted(plain.calls).body!.variant, undefined);

  const variant = withFakeServer("ok");
  await variant.adapter.invoke(HI, { ...CHANNEL, options: { variant: "high" } }, AbortSignal.timeout(5000));
  assert.equal(prompted(variant.calls).body!.variant, "high");
});

test("splitModel 只切第一个斜杠 —— 吃掉后面的会静默打到别的模型", () => {
  assert.deepEqual(splitModel("opencode/mimo-v2.5-free"), {
    providerID: "opencode",
    modelID: "mimo-v2.5-free",
  });
  // 三段式的 id 是真实存在的，modelID 必须保留剩下的全部。
  assert.deepEqual(splitModel("openrouter/anthropic/claude-sonnet-4"), {
    providerID: "openrouter",
    modelID: "anthropic/claude-sonnet-4",
  });
  for (const bad of ["mimo", "/mimo", "opencode/", ""]) {
    assert.throws(() => splitModel(bad), /provider\/model/, `should refuse ${JSON.stringify(bad)}`);
  }
});

test("默认打本机受管端口；channels.json 不必写 baseUrl", async () => {
  const { adapter, calls } = withFakeServer("ok");
  await adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000));
  // 端口归 scripts/opencode.sh 管，两边读同一个环境变量。
  assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:\d+\/session$/);

  const custom = withFakeServer("ok");
  await custom.adapter.invoke(HI, { ...CHANNEL, baseUrl: "http://oc.local:9999/" }, AbortSignal.timeout(5000));
  // 末尾斜杠要吃掉，否则拼出 `//session`。
  assert.equal(custom.calls[0].url, "http://oc.local:9999/session");
});

test("the answer comes back as an OpenAI completion under the channel id", async () => {
  const { adapter } = withFakeServer("  Service worker 会被回收。  ");
  const out = (await adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000))) as JsonRecord;
  assert.equal(out.object, "chat.completion");
  // Not "opencode/mimo-v2.5-free" — callers asked for `oc` and must see `oc`.
  assert.equal(out.model, "oc");
  const choice = (out.choices as JsonRecord[])[0];
  assert.equal((choice.message as JsonRecord).content, "Service worker 会被回收。");
  assert.equal(choice.finish_reason, "stop");
});

test("多个 text part 按顺序拼接 —— 只读第一个会丢掉后半段回答", async () => {
  const { adapter } = withFakeServer({
    parts: [
      { type: "reasoning", text: "（思考过程，不该出现在答案里）" },
      { type: "text", text: "前半段。" },
      { type: "text", text: "后半段。" },
    ],
  });
  const out = (await adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000))) as JsonRecord;
  const choice = (out.choices as JsonRecord[])[0];
  assert.equal((choice.message as JsonRecord).content, "前半段。后半段。");
});

test("服务端报了 token 就带上；没报就保持缺失，绝不补零", async () => {
  const reported = withFakeServer({
    parts: [{ type: "text", text: "ok" }],
    info: { tokens: { input: 120, output: 34 } },
  });
  const out = (await reported.adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000))) as JsonRecord;
  assert.deepEqual(out.usage, { prompt_tokens: 120, completion_tokens: 34, total_tokens: 154 });

  // 补 0 不会报错，只会把控制台里所有均值和总量悄悄拽低。
  const silent = withFakeServer("ok");
  const bare = (await silent.adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000))) as JsonRecord;
  assert.equal(bare.usage, undefined);
});

test("缓存命中的部分必须算进 prompt_tokens —— 只取 input 会少算几十倍", async () => {
  // opencode 的 `input` 不含缓存服务的那部分，OpenAI 的 prompt_tokens 含。
  // 实测：同一个 25 万字节的提示词第二次发，input 掉到 1、cache.read 顶上去；
  // 直接搬 input 会让控制台给一个 250KB 请求记上 `prompt_tokens: 1`。
  const { adapter } = withFakeServer({
    parts: [{ type: "text", text: "ok" }],
    info: { tokens: { total: 62134, input: 29055, output: 311, reasoning: 12, cache: { read: 32768, write: 0 } } },
  });
  const out = (await adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000))) as JsonRecord;
  assert.deepEqual(out.usage, {
    prompt_tokens: 29055 + 32768,
    // reasoning 算在 completion 里面，不是并列在旁边。
    completion_tokens: 311 + 12,
    total_tokens: 29055 + 32768 + 311 + 12,
    prompt_tokens_details: { cached_tokens: 32768 },
    completion_tokens_details: { reasoning_tokens: 12 },
  });
});

test("an empty answer is an error, not an empty completion", async () => {
  const { adapter } = withFakeServer("   ");
  await assert.rejects(adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000)), /no output/);
});

test("空回答带着 info.error 时，错因原样浮上来 —— 八种失败不能长成同一句话", async () => {
  // 服务端在这条路径上返回的是 200：失败写在 info.error 里，不在 HTTP 状态码上。
  // 这八个 name 抄自运行中 opencode 的 /doc，不是推测的；少一个就意味着那类故障
  // 会退回成"no output"这句什么都没说的话。真实代价见 errorOf 上面那段。
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ name: "ProviderAuthError", data: { providerID: "opencode", message: "invalid api key" } }, /ProviderAuthError.*invalid api key/],
    [{ name: "UnknownError", data: { message: "socket hang up" } }, /UnknownError.*socket hang up/],
    [{ name: "MessageAbortedError", data: { message: "aborted" } }, /MessageAbortedError.*aborted/],
    [{ name: "StructuredOutputError", data: { message: "schema mismatch", retries: 3 } }, /StructuredOutputError.*schema mismatch/],
    [{ name: "ContextOverflowError", data: { message: "prompt too long" } }, /ContextOverflowError.*prompt too long/],
    [{ name: "ContentFilterError", data: { message: "blocked" } }, /ContentFilterError.*blocked/],
    // data 为空是这一种的设计，不是缺字段 —— 至少要把 name 说出来。
    [{ name: "MessageOutputLengthError", data: {} }, /MessageOutputLengthError/],
  ];
  for (const [error, expected] of cases) {
    const { adapter } = withFakeServer({ info: { error }, parts: [] });
    await assert.rejects(adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000)), expected, JSON.stringify(error));
  }
});

test("APIError 的状态码和可重试标记要带上 —— 它们决定下一步是重试还是去修配置", async () => {
  const { adapter } = withFakeServer({
    info: { error: { name: "APIError", data: { message: "rate limited", statusCode: 429, isRetryable: true } } },
    parts: [],
  });
  await assert.rejects(
    adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000)),
    /APIError.*rate limited.*HTTP 429.*可重试/,
  );
  const dead = withFakeServer({
    info: { error: { name: "APIError", data: { message: "model gone", statusCode: 404, isRetryable: false } } },
    parts: [],
  });
  await assert.rejects(dead.adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000)), /HTTP 404.*重试无用/);
});

test("info.error 不是文档里那八种对象形状时，原样渲染而不是当作没有错因", async () => {
  // 八种形状都是对象，所以字符串 / 数字都属于服务端跑出自己的契约。这时候说
  // 「服务端没有给出 info.error」是睁眼说瞎话 —— 它给了，只是形状没见过。
  for (const [error, expected] of [["boom", /boom/], [500, /500/]] as Array<[unknown, RegExp]>) {
    const { adapter } = withFakeServer({ info: { error }, parts: [] });
    await assert.rejects(adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000)), expected);
  }
  // name 缺失同理：形状对但没名字，也得说点什么。
  const { adapter } = withFakeServer({ info: { error: { data: { message: "无名氏" } } }, parts: [] });
  await assert.rejects(adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000)), /未具名错误.*无名氏/);
});

test("真的没有 info.error 时要明说，别让人以为错因被吞了", async () => {
  // 区分「服务端没给理由」和「给了但我们扔掉了」—— 后者是这次修的 bug，前者
  // 得留一句话说清楚，否则下一个人会来这里再找一遍同一个不存在的错因。
  const { adapter } = withFakeServer({ info: { tokens: {} }, parts: [] });
  await assert.rejects(
    adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000)),
    /没有给出 info\.error/,
  );
});

test("拿不到 session id 要立刻报错，而不是继续往一个空 id 上发消息", async () => {
  const adapter = createOpenCodeAdapter(async (_method, url) =>
    url.endsWith("/session") ? {} : { parts: [{ type: "text", text: "ok" }] },
  );
  await assert.rejects(adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000)), /did not return a session id/);
});

test("服务端的报错原样浮上来，不被吞成一句泛泛的失败", async () => {
  const { adapter } = withFakeServer(() => {
    throw new Error("opencode server returned HTTP 400: unknown model: nope");
  });
  await assert.rejects(adapter.invoke(HI, CHANNEL, AbortSignal.timeout(5000)), /unknown model: nope/);
});

test("probe 打真实端点 —— 服务没起要报下线，不能乐观地报 ok", async () => {
  const { adapter, calls } = withFakeServer("ok");
  await adapter.probe!(CHANNEL, AbortSignal.timeout(5000));
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /\/session$/);

  const down = createOpenCodeAdapter(async () => {
    throw new Error("opencode server unreachable at http://127.0.0.1:11438/session");
  });
  await assert.rejects(down.probe!(CHANNEL, AbortSignal.timeout(5000)), /unreachable/);
});

test("splitMessages keeps system turns OUT of the user prompt", () => {
  assert.deepEqual(splitMessages([{ role: "user", content: "问题" }]), { prompt: "问题", images: [] });
  assert.deepEqual(
    splitMessages([
      { role: "system", content: "只用中文" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "你好" },
      { role: "user", content: "再来" },
    ]),
    // Instructions belong in the `system` field, not folded into what the user said.
    { prompt: "hi\n\n[assistant]\n你好\n\n再来", system: "只用中文", images: [] },
  );
});

test("多模态：文本进提示词，图片作为 file part 原样带上 data: URI", () => {
  const split = splitMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "这是什么？" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } },
      ],
    },
  ]);
  assert.equal(split.prompt, "这是什么？");
  assert.deepEqual(split.images.map((i) => i.mime), ["image/png", "image/jpeg"]);
  // 文件名按 MIME 给扩展名 —— opencode 靠它认类型，一律写 .png 会喂错。
  assert.deepEqual(split.images.map((i) => i.filename), ["image-0.png", "image-1.jpg"]);
  // data: URI 原样透传，不再解码落盘。
  assert.equal(split.images[0].url, "data:image/png;base64,iVBORw0KGgo=");
});

test("图片以 file part 进请求体，和文本并列", async () => {
  const { adapter, calls } = withFakeServer("一只猫");
  await adapter.invoke(
    {
      model: "oc",
      messages: [{ role: "user", content: [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ] }],
    },
    CHANNEL,
    AbortSignal.timeout(5000),
  );
  const parts = prompted(calls).body!.parts as JsonRecord[];
  assert.deepEqual(parts, [
    { type: "text", text: "看图" },
    { type: "file", mime: "image/png", url: "data:image/png;base64,iVBORw0KGgo=", filename: "image-0.png" },
  ]);
});

test("只发图不给文字也合法，给个中性问句兜底", () => {
  const split = splitMessages([
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] },
  ]);
  assert.equal(split.prompt, "描述这张图片。");
  assert.equal(split.images.length, 1);
});

test("splitMessages refuses what this channel cannot carry", () => {
  // 这条渠道没有能力去网上取图：URL 要由调用方自己取好再内联进来。
  assert.throws(
    () => splitMessages([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }]),
    /取不了远程 URL/,
  );

  // 空 base64 必须报"图片是空的"，不能报"取不了远程 URL"——后者会把人引向
  // 完全错误的方向。真实成因：shell 里 `base64 <路径>` 路径写错、输出为空。
  assert.throws(
    () => splitMessages([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64," } }] }]),
    /base64 是空的/,
  );
  // 报错要带上第几张图与 url 开头，否则多图请求里你不知道是哪一张坏了。
  assert.throws(
    () => splitMessages([{ role: "user", content: [
      { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } },
      { type: "image_url", image_url: { url: "ftp://nope" } },
    ] }]),
    /第 2 张图.*ftp:\/\/nope/s,
  );
  assert.throws(() => splitMessages([{ role: "user", content: "" }]), /no text content/);
});

test("the preamble is infrastructure only — the gateway imposes no style", () => {
  // An OpenAI caller who sends no system message expects the MODEL's default
  // behaviour. Shipping opinions like "do not show your reasoning" would be a
  // persona nobody asked for, applied invisibly.
  const preamble = readFileSync(
    fileURLToPath(new URL("../../opencode-sandbox/system.md", import.meta.url)),
    "utf8",
  );
  // 措辞在 2026-09-20 改过一次：原文说「没有任何可用工具」，而请求体里现在挂着
  // todoread（见上面那条 tools 断言）—— 沙盒里有一句与事实不符的话，比没有这句
  // 更坏。约束本身没变，且必须留着：它拦的是模型把工具调用写进散文。
  assert.match(preamble, /没有文件读写/, "the no-tools framing is load-bearing");
  assert.match(preamble, /不要去调用它/, "the one tool that exists must be told not to be used");
  for (const opinion of ["不复述问题", "不解释推理过程", "不输出计划"]) {
    assert.doesNotMatch(preamble, new RegExp(opinion), `style opinion leaked: ${opinion}`);
  }
});

test("composeSystem keeps the preamble AND the caller's system prompt", () => {
  // Not either/or: dropping the preamble when a caller sends a system message
  // is how a coding agent starts emitting tool-call blocks again.
  assert.equal(composeSystem("PREAMBLE", "海盗船长"), "PREAMBLE\n\n海盗船长\n");
  assert.equal(composeSystem("PREAMBLE", undefined), "PREAMBLE\n");
  assert.equal(composeSystem("  PREAMBLE  ", "  X  "), "PREAMBLE\n\nX\n");
});

test("调用方的 system 追加在 preamble 之后，两者都在", async () => {
  const { adapter, calls } = withFakeServer("啊哈！");
  await adapter.invoke(
    {
      model: "oc",
      messages: [
        { role: "system", content: "你是海盗船长。任何回答都必须以「啊哈！」开头。" },
        { role: "user", content: "什么是 service worker" },
      ],
    },
    CHANNEL,
    AbortSignal.timeout(5000),
  );
  const system = String(prompted(calls).body!.system);
  assert.match(system, /没有文件读写/);
  assert.match(system, /海盗船长/);
  assert.ok(system.indexOf("没有文件读写") < system.indexOf("海盗船长"), "preamble 必须在前");
});
