/**
 * The adapter plane.
 *
 * Everything the gateway serves is OpenAI protocol on the wire, inbound and
 * outbound. An adapter's whole job is to make one upstream *look* like that:
 * translate an OpenAI chat request into whatever the upstream speaks, and
 * translate its answer back. Callers never learn which adapter served them.
 *
 * There is no privileged path: the bundled ollama / lmstudio / openai adapters
 * implement exactly the interface a developer implements for their own channel.
 */

import { randomUUID } from "node:crypto";

export type JsonRecord = Record<string, unknown>;

/**
 * One configured upstream — a single entry of channels.json.
 *
 * `id` is the public model name. Callers put it in the OpenAI request's `model`
 * field and the gateway routes on it; `model` is what the upstream is actually
 * asked for. Keeping them separate is what lets the local channel stay named
 * `local` while the box behind it swaps between qwen3.5:4b and qwen3.5-9b.
 */
export type ChannelConfig = {
  id: string;
  /** Adapter name, resolved through the registry. */
  adapter: string;
  /**
   * Upstream root, no trailing slash.
   *
   * Optional because not every upstream is reachable over HTTP — an adapter
   * that shells out to a CLI has no URL to point at. Boot-time validation
   * requires it for the adapters that do speak HTTP, so the field being absent
   * is caught there rather than becoming a "http://undefined/..." request.
   */
  baseUrl?: string;
  /** Bearer credential, already dereferenced from `env.NAME` at load time. */
  apiKey?: string;
  /** The upstream's own model identifier. */
  model: string;
  /**
   * Adapter-private settings.
   *
   * This key exists because of `numCtx`. The OpenAI wire protocol has no field
   * for the context window — that is deliberate on OpenAI's side, where the
   * window is a property of the model, not of the request. Ollama's own docs
   * say the same thing about their compatibility layer ("The OpenAI API does
   * not have a way of setting the context size for a model"), and its default
   * is 2048, so a request that says nothing gets silently truncated input.
   *
   * So anything with no OpenAI field lands here, at the layer that owns it:
   * the channel. Never the request.
   */
  options?: JsonRecord;

  /**
   * How many requests may be in flight against this upstream at once.
   *
   * A property of the UPSTREAM, not of the gateway: a local Ollama shares one
   * box's VRAM and serialises anyway, while a paid vendor endpoint is bounded
   * by whatever RPM the account gets. Both are facts about the other side, so
   * they belong on the channel that describes it.
   *
   * Absent means unbounded for this channel — the global limit still applies.
   */
  maxConcurrency?: number;

  /**
   * What this upstream charges, per 1,000,000 tokens.
   *
   * Declared rather than discovered: no upstream reports its own prices, and a
   * table of them baked into the gateway would be wrong the week after it was
   * written. Absent means "we cannot cost this channel", which is reported as
   * unknown rather than as free — see costMicros in telemetry.ts.
   */
  pricing?: ChannelPricing;

  /**
   * What this channel can do, as free-form tags (`vision`, `json`, `tools`, …).
   *
   * Deliberately NOT an enum, for the same reason `adapter` is not one: a new
   * capability should not require editing this file. Deliberately also not
   * probed — no upstream answers "do you accept images" without being sent one,
   * so this is a human statement and is treated as such. It is advisory: the
   * gateway never routes on it and never rejects a request because of it, it
   * only reports it so a caller can choose. A wrong tag therefore misleads;
   * it does not break.
   */
  capabilities?: string[];
};

/**
 * Per-1M-token prices for one channel.
 *
 * Per MILLION rather than per token because that is the unit every vendor
 * publishes; converting at the point of entry is how the numbers in the config
 * file stay comparable to the numbers on the pricing page.
 */
export type ChannelPricing = {
  inputPer1M: number;
  outputPer1M: number;
  /** Free-form ("USD", "CNY", …). Purely a display label — never converted. */
  currency?: string;
};

/**
 * An inbound OpenAI chat request.
 *
 * Only the two fields the gateway itself routes on are named. Everything else
 * rides through in the index signature on purpose: a gateway that enumerates
 * the fields it forwards silently drops every parameter added after it was
 * written. Adapters pick what their upstream understands.
 */
export type ChatRequest = {
  model: string;
  messages: unknown[];
  stream?: boolean;
  [key: string]: unknown;
};

/** A ready-to-issue upstream HTTP call. */
export type UpstreamCall = {
  url: string;
  init: RequestInit;
};

/**
 * An inbound OpenAI embeddings request.
 *
 * Same index-signature stance as ChatRequest: only what the gateway routes on
 * is named, everything else (`encoding_format`, `dimensions`, `user`, …) rides
 * through so a field added upstream next month is not silently dropped here.
 */
export type EmbeddingRequest = {
  model: string;
  /** string | string[] | number[][] — the upstream validates its own shapes. */
  input: unknown;
  [key: string]: unknown;
};

/**
 * Envelope identity for one streamed completion.
 *
 * Every chunk of a completion must report the SAME id and created stamp —
 * clients group chunks by id, so minting a fresh one per frame turns a single
 * answer into a pile of one-token completions. The gateway owns this because it
 * owns the OpenAI envelope; adapters that synthesize chunks stamp it in.
 */
export type StreamContext = {
  id: string;
  created: number;
};

/**
 * One setting an adapter accepts in a channel's `options`.
 *
 * Declaring these is what lets a misspelled or mistyped option be REJECTED at
 * boot instead of silently ignored. That distinction is not cosmetic: writing
 * `num_ctx` where `numCtx` was meant used to drop the context window back to
 * Ollama's 2048 default and truncate input with no error anywhere — the exact
 * failure the ollama adapter exists to prevent, re-openable by one typo.
 */
export type OptionSpec = {
  key: string;
  type: "number" | "boolean" | "string";
};

type AdapterBase = {
  name: string;

  /**
   * Channel options this adapter understands. Declaring them opts the adapter
   * into boot-time validation; omitting the field skips it, so a custom adapter
   * is free to accept anything.
   */
  options?: readonly OptionSpec[];

  /**
   * A cheap upstream URL to GET for liveness — the shorthand for the common
   * case, where the upstream is HTTP.
   */
  healthUrl?(channel: ChannelConfig): string;

  /**
   * Liveness for upstreams that are not a URL. Throws when unhealthy.
   *
   * Takes precedence over healthUrl. An adapter offering neither is reported as
   * unknown rather than as healthy — "we cannot tell" is a real answer, and the
   * one thing /health must never do is claim OK it has not checked.
   */
  probe?(channel: ChannelConfig, signal: AbortSignal): Promise<void>;

  /**
   * 上游自己声明支持哪些模型，供界面上的下拉用。
   *
   * 可选：不是每个上游都能问（opencode 的模型来自它的 provider 配置，不在
   * 网关这一侧）。答不上来就不答，**不要猜一份列表出来**——一个编造的下拉
   * 比没有下拉更糟，它会让人选中一个根本不存在的模型。
   */
  listModels?(channel: ChannelConfig, signal: AbortSignal): Promise<string[]>;

  /**
   * 向量化，返回一个 OpenAI 形状的 embeddings 响应。
   *
   * 可选，因为**不是每个上游都有这回事**：opencode 是个编码 agent，它没有可以
   * 叫作 embedding 的东西。没实现的适配器由网关回一个说明原因的 501 —— 与
   * `listModels` 同一条立场：答不上来就不答，不要猜一份出来。
   *
   * 与 chat 不同，这里没有拆成 buildRequest / parseResponse 两半：embeddings
   * 不流式，一来一回就结束，拆开只会多两个需要对齐的形状。
   */
  embed?(
    req: EmbeddingRequest,
    channel: ChannelConfig,
    signal: AbortSignal,
  ): Promise<JsonRecord>;
};

/**
 * The common case: the upstream is an HTTP endpoint, so the adapter's job is
 * request-in / response-out translation and the gateway owns the transport.
 */
export type HttpAdapter = AdapterBase & {
  kind?: "http";

  /** OpenAI request -> upstream HTTP call. */
  buildRequest(req: ChatRequest, channel: ChannelConfig, stream: boolean): UpstreamCall;

  /** Upstream non-streaming body -> OpenAI ChatCompletion. */
  parseResponse(raw: unknown, channel: ChannelConfig): JsonRecord;

  /**
   * Upstream stream frame -> OpenAI chunk, or null to drop the frame.
   *
   * Dropping is the common case, not the exception: keep-alive comments, empty
   * deltas and terminal markers all arrive as frames and none of them should
   * reach the caller as a chunk.
   */
  parseStreamFrame(
    frame: JsonRecord,
    channel: ChannelConfig,
    stream: StreamContext,
  ): JsonRecord | null;
};

/**
 * The other case: the upstream does not fit one-request-one-response — a CLI, a
 * local binary, an SDK, or an API that needs several round trips per call. Such
 * an adapter owns its own transport and hands back a finished OpenAI
 * ChatCompletion.
 *
 * This shape exists because the HTTP one structurally cannot express it, not to
 * be general. `HttpAdapter` describes ONE request producing ONE response;
 * `opencode` needs three round trips per call (create session → post message →
 * delete session), and no amount of request-building describes that.
 */
export type DirectAdapter = AdapterBase & {
  kind: "direct";
  invoke(
    req: ChatRequest,
    channel: ChannelConfig,
    signal: AbortSignal,
  ): Promise<JsonRecord>;
};

export type Adapter = HttpAdapter | DirectAdapter;

export function isDirect(adapter: Adapter): adapter is DirectAdapter {
  return adapter.kind === "direct";
}

/** The upstream root, or a clear failure instead of "http://undefined/...". */
export function baseUrlOf(channel: ChannelConfig): string {
  if (!channel.baseUrl) {
    throw new Error(`channel "${channel.id}" has no baseUrl`);
  }
  return channel.baseUrl;
}

/**
 * Wrap finished text in the OpenAI completion envelope.
 *
 * Shared by every adapter that synthesizes a response rather than forwarding
 * one, so the envelope is written once and cannot drift between them.
 */
export function openAiCompletion(args: {
  model: string;
  content: string;
  finishReason?: string;
  reasoning?: string;
  toolCalls?: unknown[];
  usage?: JsonRecord;
}): JsonRecord {
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: args.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: args.content,
          ...(args.reasoning !== undefined ? { reasoning_content: args.reasoning } : {}),
          ...(args.toolCalls ? { tool_calls: args.toolCalls } : {}),
        },
        finish_reason: args.finishReason ?? "stop",
      },
    ],
    ...(args.usage ? { usage: args.usage } : {}),
  };
}

/** Raised for caller mistakes — surfaces as 4xx, never as a 502. */
export class RequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

/**
 * A non-2xx from an upstream, with its status kept as a NUMBER.
 *
 * This used to be a plain Error carrying `HTTP 429` inside its message, which
 * was fine while nothing read it back. Failover has to: "retry this one" and
 * "stop, the key is wrong" are 429 and 401, and telling them apart by matching
 * a substring of a human-readable sentence is the kind of thing that keeps
 * working until someone improves the wording.
 */
export class UpstreamError extends Error {
  readonly channelId: string;
  readonly upstreamStatus: number;
  constructor(channelId: string, upstreamStatus: number, detail?: string) {
    super(
      `channel "${channelId}" upstream failed: HTTP ${upstreamStatus}${
        detail ? ` — ${detail.slice(0, 500)}` : ""
      }`,
    );
    this.name = "UpstreamError";
    this.channelId = channelId;
    this.upstreamStatus = upstreamStatus;
  }
}

/**
 * Per-request generation cap, read from either spelling.
 *
 * OpenAI deprecated `max_tokens` in favour of `max_completion_tokens`, and on
 * o-series / reasoning models the old name silently does nothing. Most other
 * upstreams — Ollama's compatibility layer included — still only know
 * `max_tokens`. The gateway therefore accepts both inbound and lets each
 * adapter emit the spelling its upstream actually honours.
 */
export function maxTokensOf(req: ChatRequest): number | undefined {
  const value = req.max_completion_tokens ?? req.max_tokens;
  return typeof value === "number" ? value : undefined;
}
