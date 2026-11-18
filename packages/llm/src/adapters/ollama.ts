/**
 * Ollama upstream, spoken through its NATIVE /api/chat — not its
 * OpenAI-compatible /v1.
 *
 * That choice is the entire reason this adapter has any code in it. Ollama does
 * ship a /v1/chat/completions, and pointing the generic openai adapter at it
 * would work — right up until the context window. The OpenAI request schema has
 * no field for it, so Ollama's compatibility layer cannot accept one either
 * (their docs: "The OpenAI API does not have a way of setting the context size
 * for a model"), and the server default is 2048. A project that pins 32k would
 * get silent input truncation with no error anywhere.
 *
 * /api/chat takes `options.num_ctx`. So the window stays a channel property —
 * which is what it is on OpenAI too, just decided by the vendor instead of by
 * us — and the public protocol needs no extension.
 */
import { randomUUID } from "node:crypto";

import {
  baseUrlOf,
  maxTokensOf,
  RequestError,
  UpstreamError,
  type ChannelConfig,
  type ChatRequest,
  type HttpAdapter,
  type JsonRecord,
} from "./types.js";

type OllamaMessage = { role: string; content: string; images?: string[] };

const DATA_URI = /^data:([^;,]+);base64,(.+)$/s;

function textPart(part: JsonRecord): string {
  return typeof part.text === "string" ? part.text : "";
}

function imagePart(part: JsonRecord): string {
  const url = (part.image_url as JsonRecord | undefined)?.url;
  if (typeof url !== "string") {
    throw new RequestError("image_url part is missing its url");
  }
  const match = DATA_URI.exec(url);
  if (!match) {
    // Ollama takes raw base64 bytes, so it cannot fetch a remote image itself.
    // Saying so beats forwarding a URL the upstream will reject obscurely.
    throw new RequestError("this channel accepts only base64 data: image URLs, not remote ones");
  }
  return match[2];
}

/** OpenAI messages, whose content may be a string or an array of parts. */
export function toOllamaMessages(messages: unknown[]): OllamaMessage[] {
  return messages.map((raw, i) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new RequestError(`messages[${i}] must be an object`);
    }
    const message = raw as JsonRecord;
    const role = typeof message.role === "string" ? message.role : "user";
    const content = message.content;

    if (typeof content === "string" || content === undefined) {
      return { role, content: typeof content === "string" ? content : "" };
    }
    if (!Array.isArray(content)) {
      throw new RequestError(`messages[${i}].content must be a string or an array of parts`);
    }

    const text: string[] = [];
    const images: string[] = [];
    for (const entry of content) {
      if (!entry || typeof entry !== "object") continue;
      const part = entry as JsonRecord;
      if (part.type === "text") text.push(textPart(part));
      else if (part.type === "image_url") images.push(imagePart(part));
    }
    return { role, content: text.join(""), ...(images.length ? { images } : {}) };
  });
}

/**
 * OpenAI response_format -> Ollama format.
 *
 * Ollama takes the bare JSON Schema object, or the literal "json" for
 * unconstrained JSON mode.
 */
export function toOllamaFormat(req: ChatRequest): object | "json" | undefined {
  const responseFormat = req.response_format;
  if (!responseFormat || typeof responseFormat !== "object") return undefined;
  const spec = responseFormat as JsonRecord;
  if (spec.type === "json_object") return "json";
  if (spec.type === "json_schema") {
    const schema = (spec.json_schema as JsonRecord | undefined)?.schema;
    if (schema && typeof schema === "object") return schema as object;
  }
  return undefined;
}

/**
 * Request keys this adapter maps itself, plus the OpenAI-only ones Ollama has
 * no counterpart for. Everything NOT listed here is treated as a provider knob
 * and forwarded — see providerExtras.
 *
 * `presence_penalty` and `frequency_penalty` are deliberately absent: they are
 * OpenAI-standard AND real Ollama options under the same names, so letting them
 * fall through to the passthrough puts them exactly where they belong.
 */
const RESERVED = new Set([
  // Consumed by this adapter.
  "model", "messages", "stream", "temperature", "top_p", "top_k", "seed", "stop",
  "max_tokens", "max_completion_tokens", "response_format", "tools", "reasoning_effort",
  // OpenAI routing / metadata with nothing to map onto.
  "n", "user", "logit_bias", "logprobs", "top_logprobs", "stream_options",
  "store", "metadata", "tool_choice", "parallel_tool_calls",
  "modalities", "audio", "prediction", "service_tier",
]);

/** The Ollama knobs that sit at the top level of /api/chat rather than in options. */
const TOP_LEVEL_EXTRAS = new Set(["keep_alive"]);

/**
 * Forward provider-specific parameters.
 *
 * The OpenAI protocol has no field for `repeat_penalty` or `mirostat`, and it
 * never will — but callers legitimately need them. The convention the ecosystem
 * settled on is that such parameters ride as EXTRA TOP-LEVEL KEYS of the request
 * body; the OpenAI SDKs expose it as `extra_body`, whose contents they merge
 * into the body root (vLLM documents its own extra sampling params this way).
 *
 * So anything the adapter does not recognise is a provider knob, and the only
 * question left is where Ollama wants it. Its body has two levels: a small fixed
 * set of top-level fields, and the `options` bag holding the ~22 sampling and
 * runtime parameters. Unknown keys therefore go to `options`, with an explicit
 * exception list for the top-level ones — a rule, not a guess.
 */
function providerExtras(req: ChatRequest): { options: JsonRecord; topLevel: JsonRecord } {
  const options: JsonRecord = {};
  const topLevel: JsonRecord = {};
  for (const [key, value] of Object.entries(req)) {
    if (RESERVED.has(key) || value === undefined) continue;
    (TOP_LEVEL_EXTRAS.has(key) ? topLevel : options)[key] = value;
  }
  return { options, topLevel };
}

/**
 * Refuse OpenAI features Ollama cannot honour.
 *
 * The alternative is what this adapter used to do: drop them. A caller who asks
 * for three completions and receives one, with a 200 and no warning, has been
 * given a wrong answer dressed as a right one — the same class of failure as a
 * silently truncated prompt. Metadata-only fields (`user`, `store`, `metadata`,
 * `service_tier`) are still ignored, because ignoring them changes nothing
 * about the answer.
 */
function rejectUnsupported(req: ChatRequest): void {
  if (typeof req.n === "number" && req.n > 1) {
    throw new RequestError(`this channel cannot return n=${req.n} completions; Ollama returns one`);
  }
  for (const key of ["logprobs", "top_logprobs", "logit_bias", "modalities", "audio", "prediction"]) {
    if (req[key] !== undefined && req[key] !== null && req[key] !== false) {
      throw new RequestError(`this channel does not support "${key}"`);
    }
  }
  // "auto" is Ollama's only behaviour, so it is the one value we can honour.
  if (req.tool_choice !== undefined && req.tool_choice !== "auto") {
    throw new RequestError(
      `this channel cannot honour tool_choice=${JSON.stringify(req.tool_choice)}; only "auto"`,
    );
  }
}

function inferenceOptions(req: ChatRequest, channel: ChannelConfig): JsonRecord {
  const options: JsonRecord = {};
  for (const key of ["temperature", "top_p", "top_k", "seed", "stop"]) {
    if (req[key] !== undefined) options[key] = req[key];
  }
  const cap = maxTokensOf(req);
  if (cap !== undefined) options.num_predict = cap;
  // The channel's window, not the caller's — see the file header.
  const numCtx = channel.options?.numCtx;
  if (typeof numCtx === "number" && numCtx > 0) options.num_ctx = numCtx;
  // Last: an explicitly sent knob beats a configured default. Overriding the
  // window this way is loud and deliberate, which is the opposite of the silent
  // fallback this adapter exists to prevent.
  return { ...options, ...providerExtras(req).options };
}

/**
 * Whether to let the model emit a reasoning chain.
 *
 * Defaults to off: qwen3.x otherwise returns a long chain that every caller
 * would have to step around. `reasoning_effort: "none"` is the OpenAI-side
 * spelling of the same intent, so it is honoured too.
 */
function think(req: ChatRequest, channel: ChannelConfig): boolean {
  if (req.reasoning_effort === "none") return false;
  const configured = channel.options?.think;
  return typeof configured === "boolean" ? configured : false;
}

function usageOf(payload: JsonRecord): JsonRecord | undefined {
  const prompt = payload.prompt_eval_count;
  const completion = payload.eval_count;
  if (typeof prompt !== "number" && typeof completion !== "number") return undefined;
  const promptTokens = typeof prompt === "number" ? prompt : 0;
  const completionTokens = typeof completion === "number" ? completion : 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

/** Ollama's done_reason vocabulary is narrower than OpenAI's finish_reason. */
function finishReason(payload: JsonRecord): string {
  return payload.done_reason === "length" ? "length" : "stop";
}

export const ollamaAdapter: HttpAdapter = {
  name: "ollama",

  options: [
    { key: "numCtx", type: "number" },
    { key: "think", type: "boolean" },
  ],

  healthUrl: (channel) => `${baseUrlOf(channel)}/api/tags`,

  // Ollama 报的是「本机装了哪些」，不是「理论上支持哪些」——这正是你想在
  // 下拉里看到的那份。
  async listModels(channel, signal) {
    const res = await fetch(`${baseUrlOf(channel)}/api/tags`, { signal });
    if (!res.ok) throw new Error(`upstream /api/tags failed: HTTP ${res.status}`);
    const body = (await res.json()) as { models?: { name?: unknown }[] };
    return (body.models ?? [])
      .map((m) => m.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0);
  },

  /**
   * 向量化，走原生 `/api/embed`。
   *
   * Ollama 也有 OpenAI 兼容的 `/v1/embeddings`，但这个适配器的既定立场是全程
   * 走原生（chat 打 `/api/chat`、探活与列模型打 `/api/tags`，理由见文件头）。
   * 单把 embeddings 拐到 `/v1` 会让 baseUrl 同时指两套 API，而那种"大部分原生、
   * 个别兼容"的混搭正是下一个人读代码时会读错的地方。
   *
   * 形状翻译（原生 → OpenAI）：`embeddings: [[…]]` 逐条带上 index；
   * `prompt_eval_count` 填 usage —— embeddings 没有输出 token，所以 prompt 与
   * total 是同一个数，而不是漏了一项。
   */
  async embed(req, channel, signal) {
    const res = await fetch(`${baseUrlOf(channel)}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: channel.model,
        input: req.input,
        ...(typeof req.dimensions === "number" ? { dimensions: req.dimensions } : {}),
      }),
      signal,
    });
    if (!res.ok) {
      throw new UpstreamError(channel.id, res.status, await res.text().catch(() => ""));
    }
    const payload = (await res.json()) as {
      embeddings?: unknown;
      prompt_eval_count?: unknown;
    };
    if (!Array.isArray(payload.embeddings)) {
      throw new Error(`upstream /api/embed returned no embeddings (channel=${channel.id})`);
    }
    const promptTokens = payload.prompt_eval_count;
    return {
      object: "list",
      data: payload.embeddings.map((embedding, index) => ({
        object: "embedding",
        index,
        embedding,
      })),
      model: channel.id,
      ...(typeof promptTokens === "number"
        ? { usage: { prompt_tokens: promptTokens, total_tokens: promptTokens } }
        : {}),
    };
  },

  buildRequest(req, channel, stream) {
    rejectUnsupported(req);
    const messages = toOllamaMessages(req.messages);
    if (messages.length === 0) throw new RequestError("messages must be a non-empty array");
    const format = toOllamaFormat(req);
    const options = inferenceOptions(req, channel);
    const { topLevel } = providerExtras(req);
    return {
      url: `${baseUrlOf(channel)}/api/chat`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: channel.model,
          messages,
          stream,
          think: think(req, channel),
          ...(format !== undefined ? { format } : {}),
          ...(Array.isArray(req.tools) ? { tools: req.tools } : {}),
          ...(Object.keys(options).length ? { options } : {}),
          ...topLevel,
        }),
      },
    };
  },

  parseResponse(raw, channel) {
    const payload = (raw ?? {}) as JsonRecord;
    const message = (payload.message ?? {}) as JsonRecord;
    const content = typeof message.content === "string" ? message.content : "";
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : undefined;
    // Empty content is legitimate only for a pure tool-call reply; otherwise it
    // means the upstream produced nothing and the caller must hear about it.
    if (!content.trim() && !toolCalls) {
      throw new Error(`Ollama returned empty content (channel=${channel.id}, model=${channel.model})`);
    }
    const usage = usageOf(payload);
    return {
      id: `chatcmpl-${randomUUID().replace(/-/g, "")}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: channel.id,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(typeof message.thinking === "string" ? { reasoning_content: message.thinking } : {}),
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason(payload),
        },
      ],
      ...(usage ? { usage } : {}),
    };
  },

  parseStreamFrame(frame, channel, stream) {
    const message = (frame.message ?? {}) as JsonRecord;
    const content = typeof message.content === "string" ? message.content : "";
    const done = frame.done === true;
    // Mid-stream frames with no text carry nothing a caller can use; the final
    // frame does carry something — the finish_reason — even though it is empty.
    if (!content && !done) return null;
    return {
      id: stream.id,
      object: "chat.completion.chunk",
      created: stream.created,
      model: channel.id,
      choices: [
        {
          index: 0,
          delta: done ? {} : { role: "assistant", content },
          finish_reason: done ? finishReason(frame) : null,
        },
      ],
    };
  },
};
