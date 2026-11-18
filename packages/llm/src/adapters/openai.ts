/**
 * Generic OpenAI-compatible upstream.
 *
 * This covers the "url + apikey" channels — every vendor that already speaks
 * /v1/chat/completions — and LM Studio, whose native server is OpenAI-shaped.
 * There is almost nothing to translate here, which is the point: once the
 * gateway's own protocol is OpenAI, most of the world is already a passthrough
 * and only the odd upstream needs real adapter work.
 *
 * Provider-specific parameters need no special mechanism here. The ecosystem
 * convention is that they ride as extra TOP-LEVEL keys of the request body —
 * what the OpenAI SDKs call `extra_body`, whose contents they merge into the
 * body root (this is how vLLM documents guided_json, repetition_penalty and
 * friends). Since this adapter forwards everything it does not itself rewrite,
 * those keys arrive at the upstream unchanged and untouched.
 */
import {
  baseUrlOf,
  maxTokensOf,
  UpstreamError,
  type ChannelConfig,
  type ChatRequest,
  type HttpAdapter,
  type JsonRecord,
} from "./types.js";

/**
 * Which spelling of the generation cap this upstream honours.
 *
 * `max_tokens` is the default because it is what Ollama's compatibility layer,
 * LM Studio and most vendors accept. Point a channel at OpenAI itself — where
 * `max_tokens` is deprecated and silently ignored by reasoning models — and set
 * `options.maxTokensField` to "max_completion_tokens".
 */
function maxTokensField(channel: ChannelConfig): string {
  const configured = channel.options?.maxTokensField;
  return typeof configured === "string" && configured ? configured : "max_tokens";
}

function body(req: ChatRequest, channel: ChannelConfig, stream: boolean): JsonRecord {
  // Both spellings are removed and one is re-emitted, so a caller that sends
  // the field this upstream ignores still gets its cap honoured.
  const { max_tokens: _mt, max_completion_tokens: _mct, ...rest } = req;
  const cap = maxTokensOf(req);
  return {
    ...rest,
    model: channel.model,
    stream,
    ...(cap !== undefined ? { [maxTokensField(channel)]: cap } : {}),
  };
}

/**
 * Report the channel id the caller asked for, not the upstream's private model
 * name. The two differ by design (see ChannelConfig) and leaking the upstream
 * name back would make responses disagree with the request that produced them.
 */
function withChannelModel(payload: JsonRecord, channel: ChannelConfig): JsonRecord {
  return { ...payload, model: channel.id };
}

export const openAiAdapter: HttpAdapter = {
  name: "openai",

  options: [{ key: "maxTokensField", type: "string" }],

  healthUrl: (channel) => `${baseUrlOf(channel)}/v1/models`,

  async listModels(channel, signal) {
    const res = await fetch(`${baseUrlOf(channel)}/v1/models`, {
      headers: channel.apiKey ? { Authorization: `Bearer ${channel.apiKey}` } : {},
      signal,
    });
    if (!res.ok) throw new Error(`upstream /v1/models failed: HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  },

  /**
   * 向量化。上游已经是 OpenAI 协议，所以这里只换 `model`、原样转发其余字段
   * （`encoding_format` / `dimensions` / `user` 等各家扩展一并带过去）。
   */
  async embed(req, channel, signal) {
    const { model: _model, ...rest } = req;
    const res = await fetch(`${baseUrlOf(channel)}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(channel.apiKey ? { Authorization: `Bearer ${channel.apiKey}` } : {}),
      },
      body: JSON.stringify({ ...rest, model: channel.model }),
      signal,
    });
    if (!res.ok) {
      throw new UpstreamError(channel.id, res.status, await res.text().catch(() => ""));
    }
    return withChannelModel((await res.json()) as JsonRecord, channel);
  },

  buildRequest(req, channel, stream) {
    return {
      url: `${baseUrlOf(channel)}/v1/chat/completions`,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(channel.apiKey ? { Authorization: `Bearer ${channel.apiKey}` } : {}),
        },
        body: JSON.stringify(body(req, channel, stream)),
      },
    };
  },

  parseResponse(raw, channel) {
    const payload = (raw ?? {}) as JsonRecord;
    if (!Array.isArray(payload.choices)) {
      throw new Error(
        `upstream returned no choices (channel=${channel.id}, model=${channel.model})`,
      );
    }
    return withChannelModel(payload, channel);
  },

  parseStreamFrame(frame, channel) {
    // Keep-alives and bookkeeping frames carry no choices; they are not chunks.
    if (!Array.isArray(frame.choices)) return null;
    return withChannelModel(frame, channel);
  },
};

/**
 * LM Studio speaks the same protocol; the separate name exists so channels.json
 * reads honestly and so LM Studio-specific quirks have somewhere to land.
 *
 * Known open item: the old Ollama-facing proxy routed `think:false` requests to
 * LM Studio's Core REST endpoint because its OpenAI-compatible endpoint ignored
 * the equivalent switch for the GGUF Qwen3.5 build. Reasoning text now rides
 * back in the non-standard `reasoning_content` field, which OpenAI clients
 * ignore, so nothing breaks — but suppressing it at the source still needs a
 * live check on the Mac profile.
 */
export const lmStudioAdapter: HttpAdapter = { ...openAiAdapter, name: "lmstudio" };
