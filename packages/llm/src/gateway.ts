/**
 * The gateway — one OpenAI-protocol endpoint in front of every channel.
 *
 * Inbound and outbound it speaks nothing but OpenAI: callers point an OpenAI
 * client at this port and never learn whether the answer came from Ollama on
 * the same machine, LM Studio, a vendor behind url+apikey, or somebody's custom
 * adapter. Routing is by `model`, which names a channel (see channels.ts).
 *
 * Run it:  node dist/gateway.js --port 11435
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { loadRegistry, type Registry } from "./adapters/index.js";
import {
  isDirect,
  RequestError,
  UpstreamError,
  type Adapter,
  type ChannelConfig,
  type ChatRequest,
  type EmbeddingRequest,
  type HttpAdapter,
  type JsonRecord,
  type StreamContext,
} from "./adapters/types.js";
import {
  describeAdapters,
  listSecretEnvNames,
  probeUpstreamModels,
  saveAliases,
  saveChannels,
  saveLimits,
  testChannel,
  type AdminDeps,
} from "./admin.js";
import {
  candidateChannels,
  channelLabel,
  loadAliases,
  loadChannels,
  loadLimits,
  effectiveChannelId,
  parseAliases,
  managedChannels,
  readRawAliases,
  readRawChannels,
  readRawLimits,
  servedModels,
  validateAliases,
  validateChannelOptions,
  type AliasTable,
  type GatewayLimits,
} from "./channels.js";
import { fromChatChunk, fromChatCompletion, toChatRequest } from "./completions.js";
import {
  allowsModel,
  authenticate,
  authRequired,
  createKey,
  deleteKey,
  describeKeys,
  isLoopback,
  readKeyStore,
  restoreKey,
  revealKey,
  revokeKey,
  updateKey,
  writeKeyStore,
  type ApiKeyRecord,
  type KeySettings,
  type KeyStore,
} from "./keys.js";
import {
  createGate,
  createRateLimiter,
  RateLimitError,
  type ConcurrencyGate,
  type GateScope,
  type RateLimiter,
} from "./limits.js";
import { createHealthTracker, withFailover, type HealthTracker } from "./routing.js";
import { readFrames } from "./stream.js";
import { costOf, fromCompletion, fromRequest, preview, record, type CallRecord } from "./telemetry.js";

/** Callers without a work estimate retain the established request timeout. */
export const REQUEST_TIMEOUT_MS = 240_000;
const MAX_REQUEST_TIMEOUT_MS = 1_800_000;

export function resolveRequestTimeoutMs(value: string | string[] | undefined): number {
  if (value === undefined) return REQUEST_TIMEOUT_MS;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RequestError('X-BCP-Request-Timeout-Ms must be a positive integer', 400);
  }
  return Math.min(parsed, MAX_REQUEST_TIMEOUT_MS);
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Health probes must answer fast or be useless; they are liveness, not work. */
const HEALTH_TIMEOUT_MS = 5_000;

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

/** OpenAI-shaped error envelope, so OpenAI clients can read our failures too. */
function errorBody(message: string, type: string): JsonRecord {
  return { error: { message, type, code: null, param: null } };
}

async function readJsonBody(req: IncomingMessage): Promise<JsonRecord> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new RequestError("request body too large", 413);
    chunks.push(buf);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RequestError("request body must be a JSON object");
    }
    return parsed as JsonRecord;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError("request body is not valid JSON");
  }
}

function asChatRequest(body: JsonRecord): ChatRequest {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new RequestError('"messages" must be a non-empty array');
  }
  if (typeof body.model !== "string" || !body.model) {
    throw new RequestError('"model" must be a non-empty string');
  }
  return body as ChatRequest;
}

/** 一个错误对应的 HTTP 状态。日志与响应必须用同一个判断，否则页面上的状态码
 *  和调用方看到的对不上，而那种偏差没有报错、只能靠盯着看发现。 */
function statusOf(error: unknown): number {
  if (error instanceof RequestError) return error.status;
  // 上游的 429 原样透出去 —— 调用方据它退避，而一个 502 会让它以为是网关坏了，
  // 于是立刻重试，把限流撞得更死。其余状态仍然收敛成 502：网关没有资格代表
  // 上游对调用方说「你的请求有问题」。
  if (error instanceof UpstreamError && error.upstreamStatus === 429) return 429;
  return 502;
}

function errorKindOf(error: unknown): string {
  if (error instanceof RequestError && error.status === 504) return 'timeout_error';
  // 401 单独成类：调用日志里「key 不对」和「参数写错」是两种完全不同的排查动作，
  // 而 OpenAI 的信封本来就有 authentication_error 这个类型。
  if (error instanceof RequestError && error.status === 401) return 'authentication_error';
  return error instanceof RequestError ? "invalid_request_error" : "upstream_error";
}

function resolveAdapter(registry: Registry, channel: ChannelConfig): Adapter {
  const adapter = registry.get(channel.adapter);
  if (!adapter) {
    const known = [...registry.keys()].join(", ");
    throw new Error(
      `channel "${channel.id}" wants adapter "${channel.adapter}", which is not registered — available: ${known}`,
    );
  }
  return adapter;
}

/**
 * Issue the upstream call.
 *
 * A non-2xx upstream is reported with its own status text attached. Swallowing
 * it into a bare 502 is what turns "your API key expired" into an afternoon.
 */
async function callUpstream(
  adapter: HttpAdapter,
  channel: ChannelConfig,
  request: ChatRequest,
  stream: boolean,
  signal: AbortSignal,
): Promise<Response> {
  const call = adapter.buildRequest(request, channel, stream);
  const res = await fetch(call.url, { ...call.init, signal });
  if (!res.ok) {
    // UpstreamError 而不是裸 Error：failover 要按状态码决定「换一条再试」还是
    // 「停下来，这个错换谁都一样」，而从一句人话里 grep 出 429 是那种能一直好用
    // 到有人改了措辞为止的写法。
    throw new UpstreamError(channel.id, res.status, await res.text().catch(() => ""));
  }
  return res;
}

function openStream(res: ServerResponse): StreamContext {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // One identity for the whole completion — see StreamContext.
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, "")}`,
    created: Math.floor(Date.now() / 1000),
  };
}

/**
 * The status line is already on the wire, so the only honest way left to report
 * a mid-stream failure is an error frame. Ending silently would look to the
 * caller like a complete, shorter answer.
 */
function writeStreamError(res: ServerResponse, error: unknown): void {
  res.write(
    `data: ${JSON.stringify(errorBody(error instanceof Error ? error.message : String(error), "upstream_error"))}\n\n`,
  );
}

/**
 * Re-cut a finished completion as stream chunks.
 *
 * A direct adapter has no stream to forward — a CLI's answer arrives whole. The
 * caller still gets the complete, correct text under the protocol it asked for;
 * only the arrival granularity differs, and granularity is not part of what a
 * completion promises. Pretending we had TOKENS we did not is the line, and
 * this does not cross it.
 */
function completionAsChunks(completion: JsonRecord, envelope: StreamContext): JsonRecord[] {
  const choice = ((completion.choices as JsonRecord[] | undefined)?.[0] ?? {}) as JsonRecord;
  const message = (choice.message ?? {}) as JsonRecord;
  const base = {
    id: envelope.id,
    object: "chat.completion.chunk",
    created: envelope.created,
    model: completion.model,
  };
  return [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: message.content ?? "" },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? "stop" }],
    },
  ];
}

/**
 * 响应形状翻译 + 「已经开始写了」的通知。
 *
 * 两件事放一起，是因为它们都只在「把字节交给调用方」的那一刻才有意义：
 *  - `translate` 让 /v1/completions 复用整条 chat 服务链路，只在两端换形状；
 *  - `onCommit` 是 failover 的红线。响应一旦开始写出，换渠道重来就无法收回已
 *    发出的状态行与分片，拼接出来的答案会读起来像一个完整的答案。
 */
type Wire = {
  translate: { completion(p: JsonRecord): JsonRecord; chunk(p: JsonRecord): JsonRecord };
  onCommit(): void;
};

const PASSTHROUGH: Wire["translate"] = { completion: (p) => p, chunk: (p) => p };

async function serveDirect(
  res: ServerResponse,
  adapter: Extract<Adapter, { kind: "direct" }>,
  channel: ChannelConfig,
  request: ChatRequest,
  stream: boolean,
  signal: AbortSignal,
  wire: Wire,
): Promise<Partial<CallRecord>> {
  const completion = await adapter.invoke(request, channel, signal);
  const telemetry = fromCompletion(completion);
  if (!stream) {
    wire.onCommit();
    sendJson(res, 200, wire.translate.completion(completion));
    return telemetry;
  }
  wire.onCommit();
  const envelope = openStream(res);
  for (const chunk of completionAsChunks(completion, envelope)) {
    res.write(`data: ${JSON.stringify(wire.translate.chunk(chunk))}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
  return telemetry;
}

/** 不经过 res 的一次调用。`/admin/.../test` 与 serveHttp 的非流式分支共用它——
 *  否则「测试通过」证明不了「真调用能通过」。 */
async function invokeChannel(
  adapter: Adapter,
  channel: ChannelConfig,
  request: ChatRequest,
  signal: AbortSignal,
): Promise<JsonRecord> {
  if (isDirect(adapter)) return adapter.invoke(request, channel, signal);
  const upstream = await callUpstream(adapter, channel, request, false, signal);
  return adapter.parseResponse(await upstream.json(), channel);
}

async function serveHttp(
  res: ServerResponse,
  adapter: HttpAdapter,
  channel: ChannelConfig,
  request: ChatRequest,
  stream: boolean,
  signal: AbortSignal,
  wire: Wire,
): Promise<Partial<CallRecord>> {
  if (!stream) {
    const completion = await invokeChannel(adapter, channel, request, signal);
    wire.onCommit();
    sendJson(res, 200, wire.translate.completion(completion));
    return fromCompletion(completion);
  }
  // 上游先连上再开流：callUpstream 抛错时一个字节都还没写出去，所以这一步失败
  // 仍然可以换一条渠道重来。openStream 之后就不行了。
  const upstream = await callUpstream(adapter, channel, request, stream, signal);
  wire.onCommit();
  const envelope = openStream(res);
  // 流式的遥测只能边发边攒：TTFB 是第一帧落地的时刻，正文要把 delta 拼回来。
  let ttfbMs: number | undefined;
  const started = Date.now();
  let text = "";
  try {
    for await (const frame of readFrames(upstream)) {
      const chunk = adapter.parseStreamFrame(frame, channel, envelope);
      if (!chunk) continue;
      ttfbMs ??= Date.now() - started;
      // 正文在**翻译前**取：翻译后 content 可能已经改叫 text（老接口形状），
      // 而这里攒的是「模型说了什么」，与对外形状无关。
      const delta = ((chunk.choices as JsonRecord[] | undefined)?.[0]?.delta ?? {}) as JsonRecord;
      if (typeof delta.content === "string") text += delta.content;
      res.write(`data: ${JSON.stringify(wire.translate.chunk(chunk))}\n\n`);
    }
    res.write("data: [DONE]\n\n");
  } catch (error) {
    writeStreamError(res, error);
  }
  res.end();
  return { ttfbMs, responsePreview: preview(text) };
}

/**
 * 谁打的这一发。
 *
 * 显式的 `X-BCP-Caller` 优先于 key 名：一把 key 完全可能同时服务好几条流程
 * （现在本机这三个调用方就共用同一个"没有 key"的身份），所以 key 只是**没人
 * 自报家门时**的兜底答案，不是更权威的答案。
 */
function callerOf(req: IncomingMessage, key: ApiKeyRecord | undefined): string | undefined {
  const raw = req.headers["x-bcp-caller"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value || key?.name;
}

/** 一次请求要用到的全部运行时状态。热加载换的是里面的引用，不是这个对象。 */
type ServeContext = {
  table: { channels: ChannelConfig[]; aliases: AliasTable };
  registry: Registry;
  cursor: Map<string, number>;
  gate: ConcurrencyGate;
  rateLimiter: RateLimiter;
  tracker: HealthTracker;
  caller?: string;
  /** 本次请求命中的那把 key；未开鉴权或 loopback 豁免时为 undefined。 */
  authKey?: ApiKeyRecord;
};

/**
 * 这次请求该穿过哪几道并发闸。
 *
 * key 那道排在渠道前面：它更窄（限的是一个调用方），先被它挡住的请求就不必再
 * 去占渠道的名额。顺序对所有调用点一致，这是不死锁的全部理由。
 */
function gateScopes(ctx: ServeContext, channel: ChannelConfig): GateScope[] {
  const scopes: GateScope[] = [];
  if (ctx.authKey?.maxConcurrency) {
    scopes.push({ id: `key:${ctx.authKey.id}`, limit: ctx.authKey.maxConcurrency });
  }
  scopes.push({ id: channelLabel(channel), limit: channel.maxConcurrency });
  return scopes;
}

/** 撞上这把 key 的每分钟上限就停下，并把还要等多久一并告诉调用方。 */
function assertWithinRateLimit(ctx: ServeContext): void {
  const key = ctx.authKey;
  if (!key?.rateLimitPerMinute) return;
  const retryAfter = ctx.rateLimiter.take(key.id, key.rateLimitPerMinute);
  if (retryAfter !== undefined) {
    throw new RateLimitError(
      retryAfter,
      `API key「${key.name}」超出每分钟 ${key.rateLimitPerMinute} 次的上限，请 ${retryAfter} 秒后重试`,
    );
  }
}

/**
 * 这次请求能落到哪些渠道上。
 *
 * 白名单在这里变成一个**候选过滤器**，而不是一道单独的前置检查——这是它能和
 * 别名备胎链正确共存的唯一写法：别名可以指向一串模型，若只校验调用方写的那个
 * 名字，备胎就成了绕过白名单的路径。过滤之后，failover 天然只在这把 key 被允许
 * 的范围内切换。
 */
function allowedCandidates(ctx: ServeContext, model: string): ChannelConfig[] {
  const all = candidateChannels(ctx.table.channels, model, ctx.cursor, ctx.table.aliases);
  const allowed = all.filter((c) => allowsModel(ctx.authKey, c.id));
  if (allowed.length === 0) {
    const wanted = [...new Set(all.map((c) => c.id))].join(" / ");
    throw new RequestError(
      `API key「${ctx.authKey?.name ?? "?"}」不允许访问 ${wanted} —— 它可用的是：${
        ctx.authKey?.allowedModels?.join(", ") || "(未设置)"
      }`,
      403,
    );
  }
  return allowed;
}

/**
 * 一个入口端点与 chat 服务链路之间的形状适配。
 *
 * `/v1/completions` 就是靠这两个函数复用整条链路的：进来时把老形状翻成
 * ChatRequest，出去时把 chat 形状翻回老形状，中间的路由 / 并发闸 / failover /
 * 遥测一行都不用重写。
 */
type EndpointShape = {
  parse(body: JsonRecord): ChatRequest;
  translate: Wire["translate"];
};

const CHAT_SHAPE: EndpointShape = { parse: asChatRequest, translate: PASSTHROUGH };

const COMPLETIONS_SHAPE: EndpointShape = {
  parse: (body) => asChatRequest(toChatRequest(body)),
  translate: { completion: fromChatCompletion, chunk: fromChatChunk },
};

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServeContext,
  shape: EndpointShape = CHAT_SHAPE,
): Promise<void> {
  const startedAt = Date.now();
  // 逐步填：路由失败时后面的字段就是空的，而那条记录恰恰是最该被看见的
  // （"有人把 model 写错了、网关回了 404"），所以 entry 先于路由存在。
  const entry: Partial<CallRecord> = { startedAt, caller: ctx.caller };
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  // A caller that hangs up should not leave us holding an upstream connection.
  res.on("close", () => controller.abort());

  // 响应一旦开始写出，换渠道重来就收不回已发出的字节 —— 见 Wire。
  let committed = false;
  // 每次尝试各记一条，所以外层 catch 不能把最后那次再记一遍。
  let loggedByAttempt = false;

  try {
    timeout = setTimeout(
      () => controller.abort(new RequestError('LLM request budget exhausted', 504)),
      resolveRequestTimeoutMs(req.headers['x-bcp-request-timeout-ms']),
    );
    const request = shape.parse(await readJsonBody(req));
    entry.stream = request.stream === true;
    entry.requestPreview = fromRequest(request.messages);

    // 每分钟上限在这里查：已经建好 entry，所以被限流的那一发照样会留一条日志。
    assertWithinRateLimit(ctx);

    // 整条候选列表，不是一条：轮询决定从哪条开始，failover 决定失败后往哪走。
    // 别名配了备胎链时它跨模型拼接，白名单则把不允许的渠道过滤掉。
    const candidates = allowedCandidates(ctx, request.model);

    let attempt = 0;
    let servedChannel: ChannelConfig | undefined;
    const served = await withFailover(
      candidates,
      async (channel) => {
        attempt += 1;
        servedChannel = channel;
        // 闸在 attempt 里面：换渠道意味着重新排一次队，而每条渠道的队是各自的。
        const release = await ctx.gate.acquire(gateScopes(ctx, channel), controller.signal);
        try {
          const adapter = resolveAdapter(ctx.registry, channel);
          const stream = request.stream === true;
          const wire: Wire = { translate: shape.translate, onCommit: () => { committed = true; } };
          return isDirect(adapter)
            ? await serveDirect(res, adapter, channel, request, stream, controller.signal, wire)
            : await serveHttp(res, adapter, channel, request, stream, controller.signal, wire);
        } finally {
          release();
        }
      },
      {
        tracker: ctx.tracker,
        committed: () => committed,
        // 失败的每一次都单独落一条。不记的话，一个「一半时间 429、另一半被重试
        // 救回来」的上游在监控页上看着完全健康 —— 那正是重试最擅长掩盖的事实。
        onAttemptFailed: ({ channel, attempt: n, error }) => {
          loggedByAttempt = true;
          const reason =
            controller.signal.reason instanceof RequestError ? controller.signal.reason : error;
          record({
            ...entry,
            // 日志记的是**渠道调试名**（带来源主机），不是对外模型名——同名多
            // 来源时只有它能回答"这次是哪条渠道服务的"。
            channel: channelLabel(channel),
            adapter: channel.adapter,
            model: channel.model,
            attempt: n,
            status: "error",
            httpStatus: statusOf(reason),
            errorKind: errorKindOf(reason),
            errorMessage: reason instanceof Error ? reason.message : String(reason),
            latencyMs: Date.now() - startedAt,
          });
        },
      },
    );

    // 能走到这里就一定有一条渠道成功过，servedChannel 必然已被赋值。
    const channel = servedChannel as ChannelConfig;
    record({
      ...entry,
      channel: channelLabel(channel),
      adapter: channel.adapter,
      model: channel.model,
      attempt,
      ...served,
      // 成本跟着**真正服务它的那条渠道**的单价算，不是跟着调用方写的模型名——
      // 同名多来源时两条渠道的价格可以完全不同。
      ...costOf(
        { promptTokens: served.promptTokens, completionTokens: served.completionTokens },
        channel.pricing,
      ),
      status: "ok",
      httpStatus: 200,
      latencyMs: Date.now() - startedAt,
    });
  } catch (caught) {
    const error = controller.signal.reason instanceof RequestError ? controller.signal.reason : caught;
    // 路由之后的失败已经在 onAttemptFailed 里逐次记过了；这里只补记**还没选上
    // 渠道**就失败的那些（body 坏掉、model 写错、鉴权不过）。两边都记会让监控
    // 页上的失败数凭空翻倍。
    if (!loggedByAttempt) {
      record({
        ...entry,
        status: "error",
        httpStatus: statusOf(error),
        errorKind: errorKindOf(error),
        errorMessage: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function asEmbeddingRequest(body: JsonRecord): EmbeddingRequest {
  if (typeof body.model !== "string" || !body.model) {
    throw new RequestError('"model" must be a non-empty string');
  }
  if (body.input === undefined || body.input === null || body.input === "") {
    throw new RequestError('"input" must be a non-empty string or array');
  }
  return body as EmbeddingRequest;
}

/** 提示词预览：embeddings 的"问了什么"就是它的 input。 */
function previewInput(input: unknown): string | undefined {
  if (typeof input === "string") return preview(input);
  if (Array.isArray(input)) {
    // 数字数组是已经向量化过的 token id，没有预览价值。
    return preview(input.filter((v): v is string => typeof v === "string").join("\n"));
  }
  return undefined;
}

/**
 * 向量化。
 *
 * 和 chat 走同一套治理（候选轮询 / 并发闸 / failover / 逐次留痕），但**没有
 * committed 这一说**——embeddings 不流式，响应是最后一步一次性写出的，所以在
 * 写出之前的任何失败都还可以换一条渠道重来。
 */
async function handleEmbeddings(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServeContext,
): Promise<void> {
  const startedAt = Date.now();
  const entry: Partial<CallRecord> = { startedAt, caller: ctx.caller };
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  res.on("close", () => controller.abort());
  let loggedByAttempt = false;

  try {
    timeout = setTimeout(
      () => controller.abort(new RequestError("LLM request budget exhausted", 504)),
      resolveRequestTimeoutMs(req.headers["x-bcp-request-timeout-ms"]),
    );
    const request = asEmbeddingRequest(await readJsonBody(req));
    entry.requestPreview = previewInput(request.input);

    assertWithinRateLimit(ctx);
    const candidates = allowedCandidates(ctx, request.model);

    let attempt = 0;
    let servedChannel: ChannelConfig | undefined;
    const payload = await withFailover(
      candidates,
      async (channel) => {
        attempt += 1;
        servedChannel = channel;
        const adapter = resolveAdapter(ctx.registry, channel);
        if (!adapter.embed) {
          // RequestError 而不是上游错误，所以 isRetryable 会拒绝重试 —— 这是
          // 「这个上游没有 embeddings 这回事」，不是「这次不行」，换同一个适配器
          // 的另一把 key 也还是没有。
          throw new RequestError(
            `adapter "${adapter.name}" 不支持 embeddings（渠道 "${channel.id}"）`,
            501,
          );
        }
        const release = await ctx.gate.acquire(gateScopes(ctx, channel), controller.signal);
        try {
          return await adapter.embed(request, channel, controller.signal);
        } finally {
          release();
        }
      },
      {
        tracker: ctx.tracker,
        onAttemptFailed: ({ channel, attempt: n, error }) => {
          loggedByAttempt = true;
          const reason =
            controller.signal.reason instanceof RequestError ? controller.signal.reason : error;
          record({
            ...entry,
            channel: channelLabel(channel),
            adapter: channel.adapter,
            model: channel.model,
            attempt: n,
            status: "error",
            httpStatus: statusOf(reason),
            errorKind: errorKindOf(reason),
            errorMessage: reason instanceof Error ? reason.message : String(reason),
            latencyMs: Date.now() - startedAt,
          });
        },
      },
    );

    sendJson(res, 200, payload);

    const channel = servedChannel as ChannelConfig;
    const usage = (payload.usage ?? {}) as JsonRecord;
    const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
    record({
      ...entry,
      channel: channelLabel(channel),
      adapter: channel.adapter,
      model: channel.model,
      attempt,
      promptTokens,
      // embeddings 没有输出 token。0 在这里是**真的 0**，不是"没报"——所以它
      // 该被写下来，而不是像缺失字段那样留空。
      completionTokens: promptTokens === undefined ? undefined : 0,
      totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : promptTokens,
      ...costOf({ promptTokens, completionTokens: 0 }, channel.pricing),
      status: "ok",
      httpStatus: 200,
      latencyMs: Date.now() - startedAt,
    });
  } catch (caught) {
    const error =
      controller.signal.reason instanceof RequestError ? controller.signal.reason : caught;
    if (!loggedByAttempt) {
      record({
        ...entry,
        status: "error",
        httpStatus: statusOf(error),
        errorKind: errorKindOf(error),
        errorMessage: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 网关能跑哪些模型。
 *
 * `id` 就是模型名 —— 调用方把它原样填进请求的 `model` 里，此外不需要知道任何
 * 东西。「渠道」是内部概念（模型总得知道从哪个地址、用哪把 key 取），不出现在
 * 这里的 `id` 上。
 *
 * `bcp` 块补上"这个模型由谁提供"：几条渠道提供它、走哪个适配器、打哪个地址。
 * 有多条时说明请求会在它们之间轮流落地。`apiKey` 永远不在其中——这个端点描述
 * 的是路由，不是凭据。
 */
function handleModels(res: ServerResponse, channels: ChannelConfig[]): void {
  sendJson(res, 200, {
    object: "list",
    data: servedModels(channels).map((model) => {
      // 按 id 分组：id 就是调用方写的名字，同名即同一个模型的多个来源。
      const sources = channels.filter((c) => c.id === model);
      return {
        id: model,
        object: "model",
        created: 0,
        owned_by: sources[0].adapter,
        bcp: {
          adapter: sources[0].adapter,
          baseUrl: sources[0].baseUrl ?? null,
          // 能力标签是几条来源的并集。**人工声明，仅供调用方挑选**——网关既不
          // 据它路由，也不据它拒绝请求（见 ChannelConfig.capabilities）。所以
          // 一个写错的标签会误导人，但不会让任何请求失败。
          capabilities: [...new Set(sources.flatMap((c) => c.capabilities ?? []))],
          // 多条来源时轮流用；一条时就是它自己。`channel` 是调试名，与日志里
          // 那一列同一个值，方便对照。
          sources: sources.map((c) => ({
            channel: channelLabel(c),
            adapter: c.adapter,
            baseUrl: c.baseUrl ?? null,
            upstreamModel: c.model,
          })),
        },
      };
    }),
  });
}

type ChannelHealth = {
  id: string;
  status: "ok" | "down" | "unknown";
  detail?: string;
};

async function probeChannel(adapter: Adapter, channel: ChannelConfig): Promise<ChannelHealth> {
  const signal = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
  try {
    if (adapter.probe) {
      await adapter.probe(channel, signal);
      return { id: channel.id, status: "ok" };
    }
    if (!adapter.healthUrl) {
      return {
        id: channel.id,
        status: "unknown",
        detail: `adapter "${adapter.name}" cannot be probed`,
      };
    }
    const res = await fetch(adapter.healthUrl(channel), {
      headers: channel.apiKey ? { Authorization: `Bearer ${channel.apiKey}` } : {},
      signal,
    });
    return res.ok
      ? { id: channel.id, status: "ok" }
      : { id: channel.id, status: "down", detail: `HTTP ${res.status}` };
  } catch (error) {
    return {
      id: channel.id,
      status: "down",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Liveness, per channel.
 *
 * This used to alias /v1/models, which meant it answered 200 while every
 * upstream behind it was dead — a health check that cannot fail is decoration.
 * It now actually reaches each upstream and reports which one is broken, and
 * returns 503 when any is, because "mostly up" is not something a caller can
 * act on without knowing WHICH part is down.
 */
async function handleHealth(
  res: ServerResponse,
  channels: ChannelConfig[],
  registry: Registry,
): Promise<void> {
  const results = await Promise.all(
    channels.map((c) => probeChannel(resolveAdapter(registry, c), c)),
  );
  const down = results.filter((r) => r.status === "down");
  sendJson(res, down.length ? 503 : 200, {
    status: down.length ? "degraded" : "ok",
    channels: results,
  });
}

/** 「一键测试」要等的时间。它是界面上的一次点击，不能久等。 */
const KEY_TEST_TIMEOUT_MS = 30_000;

/**
 * 用一把 key 真打一次网关自己。
 *
 * **走的是外部调用方会走的那条路**：HTTP 打自己的 `/v1/chat/completions`，带上
 * 这把 key 的 Authorization。于是鉴权、有效期、每分钟上限、并发闸、模型白名单、
 * 路由与上游全都被同一发覆盖到——而从内部直接调一次 invokeChannel 只能证明「上
 * 游活着」，恰好绕过了这把 key 上的每一项限制，也就绕过了人真正想验证的东西。
 *
 * 失败同样回 200：这是「测试的结果」，不是「测试接口坏了」。界面要显示那段原文
 * （401 / 403 / 429 各自说的话都不同），而不是收到一个自己还要处理的 HTTP 错误。
 */
async function testKey(
  id: string,
  keys: KeyStore,
  channels: ChannelConfig[],
  host: string | undefined,
): Promise<JsonRecord> {
  const { secret, reason } = revealKey(id, keys);
  if (!secret) {
    // 没有明文就没法模拟外部调用方。可以改成内部直调，但那测的是另一件事。
    return { ok: false, error: reason ?? "这把 key 没有留存明文，无法发起测试" };
  }
  const key = keys.keys.find((k) => k.id === id);
  // 白名单限定了范围就在范围里挑，否则用网关此刻服务的第一个模型。
  const model = key?.allowedModels?.[0] ?? servedModels(channels)[0];
  if (!model) return { ok: false, error: "网关当前没有任何可用模型" };

  const base = `http://${host ?? "127.0.0.1"}`;
  const started = Date.now();
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
        // 让这一发在调用日志里认得出来，不至于混进真实流量的统计里。
        //
        // 用 prefix 而不是 name：**HTTP header 的值只能是 ASCII**，而 key 的名字
        // 是人起的，可以是中文、emoji、任何东西。塞进去会让 fetch 直接抛
        // `Cannot convert argument to a ByteString`——于是「测试」按钮对所有中文
        // 命名的 key 永远失败，而报错完全不指向名字。prefix 是我们自己生成的
        // base64url，天然 ASCII，且一样认得出是哪一把。
        "X-BCP-Caller": `admin-test:${key?.prefix ?? id}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "只回两个字：收到" }],
      }),
      signal: AbortSignal.timeout(KEY_TEST_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    const payload = (await res.json().catch(() => null)) as JsonRecord | null;
    if (!res.ok) {
      const message = ((payload?.error as JsonRecord | undefined)?.message as string | undefined) ?? "";
      return { ok: false, model, latencyMs, httpStatus: res.status, error: message || `HTTP ${res.status}` };
    }
    const choice = ((payload?.choices as JsonRecord[] | undefined)?.[0] ?? {}) as JsonRecord;
    const message = (choice.message ?? {}) as JsonRecord;
    return {
      ok: true,
      model,
      latencyMs,
      reply: typeof message.content === "string" ? message.content.slice(0, 200) : "",
    };
  } catch (error) {
    return {
      ok: false,
      model,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type GatewayOptions = {
  channels?: ChannelConfig[];
  registry?: Registry;
  aliases?: AliasTable;
  limits?: GatewayLimits;
  /** 测试注入用；生产走 keys.json 的默认位置。 */
  keysPath?: string;
};

/** 启动与热加载共用的一组检查。 */
function validateLoaded(
  channels: ChannelConfig[],
  registry: Registry,
  aliases: AliasTable = {},
): void {
  for (const channel of channels) {
    const adapter = resolveAdapter(registry, channel);
    validateChannelOptions(channel, adapter);
    // A CLI-backed channel legitimately has no URL; an HTTP one without it
    // would otherwise fetch "http://undefined/..." on its first request.
    if (!isDirect(adapter) && !channel.baseUrl) {
      throw new Error(`channel "${channel.id}": adapter "${adapter.name}" requires a baseUrl`);
    }
  }
  // 别名在这里校验，而不是在 parseAliases 里：只有拿到渠道表才知道一个别名
  // 指得到东西没有。挂在这条**启动与热加载共用**的路径上，是为了让坏别名在
  // 定义处就把网关拦下来——`local` 那次事故的全部教训就在这一行。
  validateAliases(aliases, channels);
}

export async function createGateway(options: GatewayOptions = {}): Promise<Server> {
  const channels = options.channels ?? loadChannels();
  const registry = options.registry ?? (await loadRegistry());
  const aliases = options.aliases ?? loadAliases();
  const limits = options.limits ?? loadLimits();

  // Fail closed at boot rather than on the first request that happens to route
  // to the broken channel. Hot reload runs the SAME check — two copies would
  // drift, and the symptom of drift is "the UI saved it, the next boot won't
  // start".
  validateLoaded(channels, registry, aliases);

  // The live table. Mutable so /admin can swap it, but only ever replaced
  // wholesale by a table that already passed validation — a request must never
  // observe a half-applied edit.
  const table = { channels, aliases };
  // 轮询游标，随渠道表一起换：热加载后从头开始，不会指向已经不存在的渠道。
  let cursor = new Map<string, number>();
  let activeLimits = limits;
  let gate = createGate(limits.maxConcurrency);
  // 限流窗口跨热加载保留：改一行配置不该把所有人的额度重置成满格。
  const rateLimiter = createRateLimiter();
  // 失败计数跨热加载保留：改一行配置不该让"这条渠道刚才连挂三次"这个事实归零。
  const tracker = createHealthTracker();
  // key 库与渠道表各自热加载：改渠道不该顺手重读凭据，改凭据也不该重算渠道。
  let keys: KeyStore = readKeyStore(options.keysPath);

  const reload = (): void => {
    const nextChannels = loadChannels();
    const nextAliases = loadAliases();
    const nextLimits = loadLimits();
    validateLoaded(nextChannels, registry, nextAliases);
    table.channels = nextChannels;
    table.aliases = nextAliases;
    if (nextLimits.maxConcurrency !== activeLimits.maxConcurrency) {
      // 信号量的容量是创建时定死的，改上限只能换一把新闸。旧闸上在途的请求各自
      // 释放回旧闸（release 是闭包捕获的），所以热加载后的极短窗口里实际在飞的
      // 请求可能略多于新上限——这比让在途请求把名额丢在一把没人再看的闸上要好。
      gate = createGate(nextLimits.maxConcurrency);
    }
    activeLimits = nextLimits;
    cursor = new Map();
  };

  const admin: AdminDeps = {
    registry,
    current: () => table.channels,
    reload,
    chat: (channel, prompt, signal) =>
      invokeChannel(resolveAdapter(registry, channel), channel, {
        model: channel.id,
        messages: [{ role: "user", content: prompt }],
      }, signal),
  };

  /** key 库的读改写。与渠道表同一条纪律：先校验（在 keys.ts 里）→ 再落盘 → 再切换。 */
  const commitKeys = (next: KeyStore): void => {
    writeKeyStore(next, options.keysPath);
    keys = next;
  };

  return createServer((req, res) => {
    if (process.env.BCP_DESKTOP === '1' && req.headers.authorization !== `Bearer ${process.env.BCP_DESKTOP_TOKEN}`) {
      res.writeHead(401).end('Unauthorized');
      return;
    }
    const path = (req.url ?? "").split("?")[0];
    void (async () => {
      try {
        // 鉴权在所有路由之前，**包括管理面**：管理面能改渠道、能拿任意 baseUrl
        // 发出站请求，它从来就不比 /v1 更适合敞开。
        //
        // 没有任何启用中的 key 时这一步直接放行——那是"对内、零配置"那档，也是
        // 现在的实际部署形态。一旦签发了第一把 key，除 allowLoopback 放行的本机
        // 调用外，所有请求都要带 key。
        // 管理面对本机永远开放（见 AuthContext.adminSurface）：`allowLoopback`
        // 管的是 /v1/* 那些真正花钱的调用，不该把 Console 自己关在门外。
        const authKey = authenticate(keys, req.headers.authorization, req.socket.remoteAddress, {
          adminSurface: path.startsWith("/admin/"),
        });

        // 每条请求现取 table：热加载换的是这个对象里的引用，不是副本。
        const ctx: ServeContext = {
          table,
          registry,
          cursor,
          gate,
          rateLimiter,
          tracker,
          authKey,
          caller: callerOf(req, authKey),
        };

        if (req.method === "POST" && path === "/v1/chat/completions") {
          await handleChat(req, res, ctx);
          return;
        }
        if (req.method === "POST" && path === "/v1/completions") {
          // 老接口：两端换形状，中间完全复用上面那条链路（见 completions.ts）。
          await handleChat(req, res, ctx, COMPLETIONS_SHAPE);
          return;
        }
        if (req.method === "POST" && path === "/v1/embeddings") {
          await handleEmbeddings(req, res, ctx);
          return;
        }
        if (req.method === "GET" && path === "/v1/models") {
          handleModels(res, table.channels);
          return;
        }
        if (req.method === "GET" && path === "/health") {
          await handleHealth(res, table.channels, registry);
          return;
        }
        // --- 管理面 ---
        // 运行时快照：闸上有多少在飞 / 多少在排队、哪条渠道正因连续失败被降级。
        // 与 /health 分开：那个问"上游活着吗"（会打网络），这个问"网关自己现在
        // 什么状态"（纯内存，永远秒回）。
        if (req.method === "GET" && path === "/admin/runtime") {
          sendJson(res, 200, {
            concurrency: { limit: activeLimits.maxConcurrency ?? null, ...gate.stats() },
            channelHealth: tracker.snapshot(),
            // 每把 key 最近一分钟打了多少发。纯内存、重启归零，与限流器同源。
            rateWindow: rateLimiter.stats(),
          });
          return;
        }
        if (req.method === "GET" && path === "/admin/keys") {
          sendJson(res, 200, describeKeys(keys));
          return;
        }
        if (req.method === "POST" && path === "/admin/keys") {
          const body = await readJsonBody(req);
          const name = typeof body.name === "string" ? body.name : "";
          const minted = createKey(name, keys, body.settings as KeySettings | undefined ?? {});
          commitKeys(minted.store);
          // **明文只在这里出现这一次**。之后任何接口都只回得出 prefix，因为
          // 磁盘上存的就只有哈希。界面必须当场让用户复制走。
          sendJson(res, 200, {
            ...describeKeys(minted.store),
            created: { ...minted.record, plaintext: minted.plaintext },
          });
          return;
        }
        if (req.method === "PUT" && path === "/admin/keys/settings") {
          const body = await readJsonBody(req);
          commitKeys({ ...keys, allowLoopback: body.allowLoopback !== false });
          sendJson(res, 200, describeKeys(keys));
          return;
        }
        const keyReveal = /^\/admin\/keys\/([^/]+)\/secret$/.exec(path);
        if (req.method === "GET" && keyReveal) {
          // 明文只在这里露面，不进 /admin/keys 的列表——那个列表每几秒刷一次，
          // 明文会跟着进网络面板、日志和前端缓存。
          sendJson(res, 200, revealKey(decodeURIComponent(keyReveal[1]), keys));
          return;
        }
        const keyTest = /^\/admin\/keys\/([^/]+)\/test$/.exec(path);
        if (req.method === "POST" && keyTest) {
          sendJson(
            res,
            200,
            await testKey(decodeURIComponent(keyTest[1]), keys, table.channels, req.headers.host),
          );
          return;
        }
        const keyUpdate = /^\/admin\/keys\/([^/]+)$/.exec(path);
        if (req.method === "PUT" && keyUpdate) {
          const body = await readJsonBody(req);
          commitKeys(
            updateKey(
              decodeURIComponent(keyUpdate[1]),
              (body.settings as KeySettings | undefined) ?? {},
              keys,
            ),
          );
          sendJson(res, 200, describeKeys(keys));
          return;
        }
        const keyAction = /^\/admin\/keys\/([^/]+)\/(revoke|restore)$/.exec(path);
        if (req.method === "POST" && keyAction) {
          const id = decodeURIComponent(keyAction[1]);
          commitKeys(keyAction[2] === "revoke" ? revokeKey(id, keys) : restoreKey(id, keys));
          sendJson(res, 200, describeKeys(keys));
          return;
        }
        const keyDelete = /^\/admin\/keys\/([^/]+)$/.exec(path);
        if (req.method === "DELETE" && keyDelete) {
          commitKeys(deleteKey(decodeURIComponent(keyDelete[1]), keys));
          sendJson(res, 200, describeKeys(keys));
          return;
        }
        if (req.method === "PUT" && path === "/admin/aliases") {
          const body = await readJsonBody(req);
          sendJson(res, 200, saveAliases(body.aliases, admin));
          return;
        }
        if (req.method === "PUT" && path === "/admin/limits") {
          const body = await readJsonBody(req);
          sendJson(res, 200, saveLimits(body.limits, admin));
          return;
        }
        if (req.method === "GET" && path === "/admin/channels") {
          // 原始声明 + 可选适配器；apiKey 保持 `env.NAME` 形态，真值不出这台机器。
          // effectiveIds 与 channels 同序：界面要显示「这条渠道实际叫什么」，
          // 规则归网关（effectiveChannelId），界面不再自己推一份。
          const raw = readRawChannels();
          sendJson(res, 200, {
            channels: raw,
            effectiveIds: raw.map((c) => effectiveChannelId(c)),
            // 受管渠道来自运行时，绝不能和 channels 一起回写：后者才是可编辑的
            // 原始声明，前者只是当前机器根据本地适配器计算出的有效配置。
            managedChannels: managedChannels(raw, table.channels).map((channel) => ({
              id: channel.id,
              adapter: channel.adapter,
              ...(channel.baseUrl ? { baseUrl: channel.baseUrl } : {}),
              model: channel.model,
              ...(channel.options ? { options: channel.options } : {}),
            })),
            adapters: describeAdapters(registry),
            // 只有**名字**。apiKey 那一栏允许直接手打明文，下拉只是省掉
            // 「我那个 key 叫什么来着」的翻文件；真值任何时候都不出这台机器。
            secretEnvNames: listSecretEnvNames(),
            // 别名与并发上限跟渠道表在同一个文件里，也就跟着同一个 GET 一起回：
            // 界面画的是一整页配置，分三个请求取只会让它们出现"半新半旧"的瞬间。
            //
            // 这里回**归一化后**的形态（值一律是数组），不像 channels 那样回原始
            // 声明——原始声明保留是为了 `env.NAME` 不被解引用，别名没有那个顾虑，
            // 而让界面同时应付「字符串」和「数组」两种写法只会多一处能写错的地方。
            aliases: parseAliases(readRawAliases()),
            limits: readRawLimits(),
          });
          return;
        }
        if (req.method === "PUT" && path === "/admin/channels") {
          const body = await readJsonBody(req);
          sendJson(res, 200, saveChannels(body.channels, admin));
          return;
        }
        const test = /^\/admin\/channels\/([^/]+)\/test$/.exec(path);
        if (req.method === "POST" && test) {
          sendJson(res, 200, await testChannel(decodeURIComponent(test[1]), admin));
          return;
        }
        // 不挂在 `/admin/channels/<id>/` 下面：它问的是「这份声明打到的那个上游
        // 有什么模型」，一条还没保存、还没有 id 的草稿同样该问得到。按 id 找
        // 渠道是「测试」那条路的事——测试测的才是**正在服务的**那条渠道。
        if (req.method === "POST" && path === "/admin/models") {
          const body = await readJsonBody(req);
          sendJson(res, 200, await probeUpstreamModels(body.channel, admin));
          return;
        }
        sendJson(res, 404, errorBody(`no route for ${req.method} ${path}`, "invalid_request_error"));
      } catch (error) {
        if (res.headersSent) {
          res.end();
          return;
        }
        sendJson(
          res,
          statusOf(error),
          errorBody(error instanceof Error ? error.message : String(error), errorKindOf(error)),
          // 429 必须带上退避时长：不带的话调用方只能自己瞎猜，而我们精确知道
          // 答案——最早那一发滑出窗口的时刻。
          error instanceof RateLimitError
            ? { "Retry-After": String(error.retryAfterSeconds) }
            : {},
        );
      }
    })();
  });
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function cli(): Promise<void> {
  const args = process.argv.slice(2);
  const port = Number(flag(args, "--port") ?? process.env.BCP_LLM_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("usage: gateway --port <port> [--host <addr>]");
    process.exitCode = 2;
    return;
  }
  // 监听地址可配，默认仍是 127.0.0.1 —— 现有部署一个字都不用改。
  // 它存在是因为 key 功能否则无处可用：只监听 loopback 的端口，外面根本连不上，
  // 再完备的鉴权也只是摆设。把"对外"做成一个显式动作（改这个值），而不是某天
  // 某人顺手改了 listen 的默认参数。
  const host = flag(args, "--host") ?? process.env.BCP_LLM_HOST ?? "127.0.0.1";
  const channels = loadChannels();
  const server = await createGateway({ channels });
  server.listen(port, host, () => {
    const address = server.address();
    if (process.env.BCP_DESKTOP === '1' && address && typeof address !== 'string') {
      const parent = (process as unknown as { parentPort?: { postMessage(message: unknown): void } }).parentPort;
      parent?.postMessage({ type: 'ready', version: 1, generation: process.env.BCP_DESKTOP_GENERATION, service: 'llm', endpoints: { llm: `http://127.0.0.1:${address.port}` } });
    }
    const summary = channels.map((c) => `${c.id}->${c.adapter}`).join(", ");
    console.error(`[llm-gateway] listening on ${host}:${address && typeof address !== 'string' ? address.port : port} — channels: ${summary}`);
    // 对外敞开却没有任何 key = 谁都能用你的额度。这一条必须在启动时喊出来，
    // 因为它没有任何其它症状：一切工作正常，只是对全世界工作正常。
    if (!isLoopback(host) && host !== "localhost" && !authRequired(readKeyStore())) {
      console.error(
        `[llm-gateway] ⚠ 正在监听 ${host}（非本机），但一把 API key 都没签发 —— ` +
          `任何能连到这个端口的人都可以直接用你的上游额度。` +
          `在 Console 的 LLM 页签发一把 key，或改回 --host 127.0.0.1。`,
      );
    }
  });
}

if (process.argv[1]?.endsWith("gateway.js")) {
  void cli().catch((error: unknown) => {
    console.error(`[llm-gateway] failed to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
