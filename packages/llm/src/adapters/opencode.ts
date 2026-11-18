/**
 * opencode upstream — a managed local server, reached over its own HTTP API.
 *
 * It is still a DirectAdapter, but no longer because the answer arrives on
 * stdout. It is one because a single OpenAI request maps to THREE upstream
 * calls (create session → post message → delete session), and `HttpAdapter`'s
 * one-request-one-response contract structurally cannot express that.
 *
 * Why not `opencode run`: the prompt then travels through argv, and Linux caps
 * a single argv string at MAX_ARG_STRLEN (32 pages = 131072 bytes — measured on
 * the machine this came from: 131071 accepted, 131072 E2BIG). That ceiling has
 * nothing to do with opencode, which happily serves million-token models; it
 * was an artefact of the transport. Over HTTP the body carries it: a 252082-byte
 * prompt (1.9× the argv ceiling) round-tripped, with the answer correctly drawn
 * from the middle of it.
 *
 * Using a coding agent as a plain LLM still takes four layers of isolation, each
 * one load-bearing. Two are now request fields instead of files on disk:
 *
 *   1. `tools: {"todoread": true}` in the request body — a NON-EMPTY tool set
 *      holding exactly one zero-side-effect read-only tool, so the model has
 *      nothing dangerous to call and cannot emit shell/file tool calls into
 *      what we treat as prose. See the `tools` note below: the obvious spelling
 *      of this layer, `{"*": false}`, is the one that gets rejected upstream.
 *   2. the server's working directory is a bare directory owned by
 *      `scripts/opencode.sh` — opencode reads AGENTS.md and project files
 *      relative to its cwd, and this keeps the caller's repo out of the prompt.
 *   3. `HOME=<fakehome>`, also set by `scripts/opencode.sh` — otherwise it picks
 *      up ~/.claude/CLAUDE.md and friends (~29KB of irrelevant context), AND its
 *      session database becomes the developer's real one.
 *   4. `system` in the request body — see below.
 *
 * Layers 2 and 3 are the SERVER's business, not this file's: they are properties
 * of the process, established once at start, not per request. That split is why
 * the throwaway-sandbox-per-request machinery is gone.
 *
 * What goes in `system` is two things, kept separate on purpose:
 *
 *   - the PREAMBLE (opencode-sandbox/system.md) — infrastructure, and NOT
 *     redundant with `tools:{"*":false}`. That field removes tools from the
 *     request; it does not stop the model from typing tool-call markup as
 *     prose. Measured with an empty preamble, same config, same model:
 *
 *       "读一下 /etc/hostname 告诉我内容"
 *         → <tool_call><function=read><parameter=filePath>/etc/hostname</...>
 *       "你是谁"
 *         → "opencode，一个帮助完成软件工程任务的CLI工具。"
 *
 *     i.e. with no system prompt it falls back to opencode's own agent framing.
 *     With the preamble the same two prompts answer "I have no file tool, paste
 *     it to me" and name the model. So it is load-bearing; deleting it is what
 *     the test asserting `/没有任何可用工具/` exists to stop. Always present.
 *   - the caller's `system` message — appended after it, verbatim.
 *
 * The preamble deliberately carries no style opinions. An OpenAI caller who
 * sends no system message expects the MODEL's default behaviour, not the
 * gateway's taste; telling it "do not restate the question, do not show your
 * reasoning, do not output plans" would be a persona nobody asked for, injected
 * invisibly. Infrastructure is ours to impose, style is not.
 *
 * There is no streaming: this adapter waits for the finished message. The
 * gateway re-cuts it as chunks for callers that asked to stream.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  openAiCompletion,
  RequestError,
  type ChannelConfig,
  type ChatRequest,
  type DirectAdapter,
  type JsonRecord,
} from "./types.js";

/**
 * Where the preamble lives. The directory is no longer copied per request — it
 * is the SOURCE that scripts/opencode.sh installs into the server's working
 * directory once at start (system.md plus the agent definition beside it).
 */
const PREAMBLE_URL = new URL("../../opencode-sandbox/", import.meta.url);

/** Must agree with scripts/opencode.sh — that script owns the process and port. */
const DEFAULT_PORT = "11438";

function optString(channel: ChannelConfig, key: string, fallback: string): string {
  const value = channel.options?.[key];
  return typeof value === "string" && value ? value : fallback;
}

/**
 * The managed server's root.
 *
 * Derived rather than configured: the port belongs to `scripts/opencode.sh`,
 * which reads the same env var. A channel CAN override with baseUrl, but the
 * zero-config case has to keep working — channels.json carries no URL for this
 * adapter and must not have to.
 */
function serverUrl(channel: ChannelConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (channel.baseUrl) return channel.baseUrl.replace(/\/+$/, "");
  return `http://127.0.0.1:${env.BCP_LLM_OPENCODE_PORT || DEFAULT_PORT}`;
}

/**
 * `provider/model` — opencode addresses models by two fields, not one string.
 *
 * Split on the FIRST slash only: model ids legitimately contain more of them
 * (`openrouter/anthropic/claude-…`), and eating them would silently address the
 * wrong model rather than fail.
 */
export function splitModel(model: string): { providerID: string; modelID: string } {
  const cut = model.indexOf("/");
  if (cut <= 0 || cut === model.length - 1) {
    throw new RequestError(
      `opencode model must be "provider/model" (got ${JSON.stringify(model)}) — e.g. opencode/mimo-v2.5-free`,
    );
  }
  return { providerID: model.slice(0, cut), modelID: model.slice(cut + 1) };
}

type Image = { mime: string; url: string; filename: string };
type Split = { prompt: string; system?: string; images: Image[] };

// payload 用 `(.*)` 而不是 `(.+)`：空 payload 必须**匹配成功再被单独判掉**。
// 用 `(.+)` 时它匹配失败，会掉进下面那句"取不了远程 URL"——而实际原因是图片
// 是空的（最常见的成因是 shell 里 `base64 <路径>` 路径写错、输出为空）。
// 一句把人引向完全错误方向的报错，比没有报错更费时间。
const DATA_URI = /^data:([^;,]*);base64,(.*)$/s;

/**
 * Validate a data: URI and describe it as a FilePartInput.
 *
 * The bytes are decoded ONLY to prove they decode — the URI itself is what gets
 * sent, so nothing is written to disk any more. The checks stay because each one
 * corresponds to a mistake that actually happened and cost real time to diagnose.
 */
function toImagePart(url: unknown, index: number): Image {
  const where = `messages 里第 ${index + 1} 张图`;
  if (typeof url !== "string") throw new RequestError(`${where}缺少 url`);
  const match = DATA_URI.exec(url);
  if (!match) {
    // 这条渠道没有能力去网上取图：URL 要由调用方自己取好再内联进来。
    throw new RequestError(
      `${where}不是 base64 的 data: URI（这条渠道取不了远程 URL，url 开头是 ${JSON.stringify(url.slice(0, 40))}）`,
    );
  }
  const payload = match[2].trim();
  if (!payload) {
    throw new RequestError(
      `${where}的 base64 是空的 —— 多半是生成请求时图片没读到（比如 shell 里 base64 的路径写错了）`,
    );
  }
  const mime = match[1] || "image/png";
  if (!Buffer.from(payload, "base64").length) {
    throw new RequestError(`${where}的 base64 解不出任何字节`);
  }
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png";
  return { mime, url, filename: `image-${index}.${ext}` };
}

/**
 * Split an OpenAI conversation into the system prompt and the single prompt
 * opencode takes.
 *
 * System turns are kept SEPARATE rather than folded into the user text: they
 * belong in the `system` field, where the model treats them as instructions
 * rather than as something the user said.
 */
export function splitMessages(messages: unknown[]): Split {
  const parts: string[] = [];
  const system: string[] = [];
  const images: Image[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as JsonRecord;
    const content = message.content;
    const role = typeof message.role === "string" ? message.role : "user";

    // 多模态：文本拼进提示词，图片作为 file part 原样带上去。
    if (Array.isArray(content)) {
      const text: string[] = [];
      for (const entry of content) {
        if (!entry || typeof entry !== "object") continue;
        const part = entry as JsonRecord;
        if (part.type === "text" && typeof part.text === "string") text.push(part.text);
        else if (part.type === "image_url") {
          images.push(toImagePart((part.image_url as JsonRecord | undefined)?.url, images.length));
        }
      }
      const joined = text.join("");
      if (joined) {
        if (role === "system") system.push(joined);
        else if (role === "user") parts.push(joined);
        else parts.push(`[${role}]\n${joined}`);
      }
      continue;
    }

    if (typeof content !== "string" || !content) continue;
    if (role === "system") system.push(content);
    else if (role === "user") parts.push(content);
    else parts.push(`[${role}]\n${content}`);
  }
  const prompt = parts.join("\n\n").trim();
  // 只发图不给提示词是合法的（"这是什么"式的调用），给个中性问句兜底。
  if (!prompt && images.length === 0) throw new RequestError("no text content to send");
  return {
    prompt: prompt || "描述这张图片。",
    images,
    ...(system.length ? { system: system.join("\n\n") } : {}),
  };
}

/**
 * The effective system prompt: infrastructure preamble, then the caller's.
 *
 * Composed rather than chosen between, so there is ONE code path. Two paths
 * would mean a request behaves differently depending on whether it happened to
 * carry a system message — and it was the no-system path that silently applied
 * the gateway's own style preferences.
 */
export function composeSystem(preamble: string, callerSystem: string | undefined): string {
  const parts = [preamble.trim()];
  if (callerSystem) parts.push(callerSystem.trim());
  return `${parts.filter(Boolean).join("\n\n")}\n`;
}

/** Test seam — production talks to the real server. */
export type ServerCall = (
  method: string,
  url: string,
  body: JsonRecord | undefined,
  signal: AbortSignal,
) => Promise<JsonRecord>;

const serverCall: ServerCall = async (method, url, body, signal) => {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal,
    });
  } catch (error) {
    // The server is managed by scripts/opencode.sh, so "cannot connect" has one
    // overwhelmingly likely cause and one fix. Saying so beats "fetch failed".
    throw new Error(
      `opencode server unreachable at ${url} (${error instanceof Error ? error.message : String(error)}) — ` +
        `start it with: pnpm --filter @bcp/llm start`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`opencode server returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  // 204 / empty body is legal for DELETE.
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as JsonRecord;
  } catch {
    throw new Error(`opencode server returned non-JSON: ${text.slice(0, 200)}`);
  }
};

/** Concatenate every text part of an assistant message, in order. */
function textOf(reply: JsonRecord): string {
  const parts = Array.isArray(reply.parts) ? reply.parts : [];
  const chunks: string[] = [];
  for (const raw of parts) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as JsonRecord;
    if (part.type === "text" && typeof part.text === "string") chunks.push(part.text);
  }
  return chunks.join("").trim();
}

/**
 * Why the turn produced nothing, in the server's own words.
 *
 * `POST /session/:id/message` answers **200 with `{info, parts}` even when the
 * turn failed** — the failure rides in `info.error`, not in the HTTP status, so
 * `serverCall` above sees a perfectly good response and hands it over. That
 * field is one of eight named shapes: ProviderAuthError, UnknownError,
 * MessageOutputLengthError, MessageAbortedError, StructuredOutputError,
 * ContextOverflowError, ContentFilterError, APIError. Read off the running
 * server's own `/doc` rather than assumed — all eight carry `data.message`
 * except MessageOutputLengthError, whose `data` is empty by design.
 *
 * Until this existed every one of them surfaced as "opencode returned no
 * output", a sentence equally true of all eight and therefore diagnostic of
 * none: an expired provider key, a 429, a prompt past the context window and a
 * content filter were one indistinguishable message. It is not hypothetical —
 * flow run e364da1b's preprocess node died on one of these, one failure against
 * 48 successes on the same prompt, and the console row recorded a bare 502 with
 * no cause. An intermittent failure is exactly the case where the name IS the
 * whole diagnosis.
 */
function errorOf(reply: JsonRecord): string {
  const info = reply.info;
  const raw = info && typeof info === "object" ? (info as JsonRecord).error : undefined;
  if (raw === undefined || raw === null) return "";
  // All eight documented shapes are objects, so anything else is the server off
  // its own contract. Rendered verbatim rather than dropped: returning "" here
  // would make the caller say "服务端没有给出 info.error" about a response that
  // plainly did give one — the exact species of lie this function exists to stop.
  if (typeof raw !== "object") return String(raw);
  const { name, data } = raw as JsonRecord;
  const detail = data && typeof data === "object" ? (data as JsonRecord) : {};
  const bits: string[] = [];
  if (typeof detail.message === "string" && detail.message) bits.push(detail.message);
  // APIError is the only shape that carries these two, and they are the whole
  // difference between "try again" and "stop and fix something" — a 429 that
  // reads as a 429 saves the reader a round trip through the provider console.
  if (typeof detail.statusCode === "number") bits.push(`HTTP ${detail.statusCode}`);
  if (typeof detail.isRetryable === "boolean") bits.push(detail.isRetryable ? "可重试" : "重试无用");
  const label = typeof name === "string" && name ? name : "未具名错误";
  return bits.length > 0 ? `${label}: ${bits.join("，")}` : label;
}

/**
 * Token counts, when the server reports them.
 *
 * opencode reports `{total, input, output, reasoning, cache:{read, write}}`, and
 * **`input` excludes everything the cache served**. OpenAI's `prompt_tokens` is
 * the opposite convention: it INCLUDES cached tokens, with the cached share
 * broken out under `prompt_tokens_details`. Mapping `input` straight across
 * therefore understates the prompt by however much was cached — measured on one
 * 252KB prompt sent twice:
 *
 *   cold: input=57646 cache.read=4096   → real prompt 61742
 *   warm: input=29055 cache.read=32768  → real prompt 61823
 *   fully warm (via the gateway): input=1
 *
 * The last one is what gave the console a `prompt_tokens: 1` row for a quarter-
 * megabyte request. Nothing errors; the number is just quietly 30-60× too small,
 * which is the whole failure mode this file's sibling comments keep warning about.
 *
 * Absent or malformed stays absent: inventing a zero would drag every average and
 * total in the console down, which is worse than an empty column.
 */
function usageOf(reply: JsonRecord): JsonRecord | undefined {
  const info = reply.info;
  const tokens = info && typeof info === "object" ? (info as JsonRecord).tokens : undefined;
  if (!tokens || typeof tokens !== "object") return undefined;
  const t = tokens as JsonRecord;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const cache = t.cache && typeof t.cache === "object" ? (t.cache as JsonRecord) : {};

  const input = num(t.input);
  const output = num(t.output);
  if (input === undefined && output === undefined) return undefined;

  const cachedRead = num(cache.read) ?? 0;
  const cachedWrite = num(cache.write) ?? 0;
  const reasoning = num(t.reasoning) ?? 0;
  const promptTokens = (input ?? 0) + cachedRead + cachedWrite;
  // OpenAI counts reasoning inside completion_tokens, not beside it.
  const completionTokens = (output ?? 0) + reasoning;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    // Summed rather than taken from `total`: if opencode ever leaves reasoning
    // out of its own total, a self-consistent sum is the one that still adds up.
    total_tokens: promptTokens + completionTokens,
    ...(cachedRead > 0 ? { prompt_tokens_details: { cached_tokens: cachedRead } } : {}),
    ...(reasoning > 0 ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
  };
}

/**
 * `tools` — the one request field where the obvious value is the wrong one.
 *
 * OpenCode Zen gates its free tier on the request carrying a NON-EMPTY tool
 * set. Empty the set and the upstream answers, whatever the key:
 *
 *   403 {"type":"error","error":{"type":"FreeTierError",
 *        "message":"Error from provider (Console): OpenCode's free tier can
 *                   only be used from within OpenCode"}}
 *
 * Measured against the managed server (2026-09-20, opencode 1.18.31), one
 * request per row, same prompt, only `tools` varying:
 *
 *   absent                          -> 200
 *   {"*": true}                     -> 200
 *   {"todoread": true}              -> 200
 *   {"*": false}                    -> 403 FreeTierError
 *   {"read": false, "glob": false}  -> 403 FreeTierError
 *
 * The last two rows are the same fact twice: this field is a WHITELIST whose
 * KEYS are the tool set and whose booleans only switch them on and off, so
 * `{"*": false}` and `{"read": false}` both leave the set empty. That is why
 * the old `{"*": false}` — the natural way to write "hand the model no tools" —
 * made every single call fail, and why the error named the wrong thing: it looks
 * like an auth/region problem when it is really "your tool set is empty".
 *
 * The agent definition in opencode-sandbox/opencode.json empties the set too,
 * and the two are combined rather than chosen between, so BOTH have to hold a
 * non-empty set — a request-level `{"todoread": true}` under an agent-level
 * `{"*": false}` is still a 403. What does override it is a request-level
 * `{"*": true}`, which is why that is not the fix: it hands the model bash and
 * write, and opencode EXECUTES what the model calls, in this workdir, in a loop.
 *
 * Hence `{ todoread: true }`: one tool, read-only, over an in-memory list this
 * channel never populates — a tool set that is non-empty for the gate and
 * useless to the model. If a future opencode drops `todoread` the set goes
 * empty again and the 403 returns; the symptom is unmistakable now that it is
 * written down.
 */
export function createOpenCodeAdapter(call: ServerCall = serverCall): DirectAdapter {
  return {
    name: "opencode",
    kind: "direct",

    options: [
      { key: "agent", type: "string" },
      { key: "variant", type: "string" },
      { key: "preambleDir", type: "string" },
      { key: "systemPreamble", type: "string" },
    ],

    // A real endpoint now, so liveness is a real question with a real answer.
    // session.list is used because it is the cheapest call we have CONFIRMED
    // exists; our session table stays near-empty because invoke() deletes what
    // it creates.
    async probe(channel: ChannelConfig, signal: AbortSignal) {
      await call("GET", `${serverUrl(channel)}/session`, undefined, signal);
    },

    async invoke(req: ChatRequest, channel: ChannelConfig, signal: AbortSignal) {
      const { prompt, system, images } = splitMessages(req.messages);
      const preambleDir = optString(channel, "preambleDir", fileURLToPath(PREAMBLE_URL));
      const preamble = optString(
        channel,
        "systemPreamble",
        readFileSync(join(preambleDir, "system.md"), "utf8"),
      );
      const root = serverUrl(channel);

      // A FRESH session per request, deleted when done. The OpenAI protocol is
      // stateless — the caller re-sends the whole conversation every time — so
      // reusing a session would mean the same request answers differently
      // depending on hidden history, and two callers sharing this channel would
      // contaminate each other. The session is an envelope, not a memory.
      const created = await call("POST", `${root}/session`, {}, signal);
      const sessionID = typeof created.id === "string" ? created.id : "";
      if (!sessionID) {
        throw new Error(`opencode server did not return a session id (got ${JSON.stringify(created).slice(0, 200)})`);
      }

      let reply: JsonRecord;
      try {
        reply = await call(
          "POST",
          `${root}/session/${encodeURIComponent(sessionID)}/message`,
          {
            model: splitModel(channel.model),
            system: composeSystem(preamble, system),
            // Layer 1. NEVER empty, and sent on EVERY request rather than
            // relying on the agent definition — see the comment above the
            // options list for why `{"*": false}` (the obvious way to say
            // "give the model no tools") is the one value that breaks.
            tools: { todoread: true },
            // The agent definition (opencode.json in the server's working dir)
            // is what REPLACES opencode's own agent framing. `system` alone does
            // not: measured on a 252KB prompt with no agent, the answer came
            // back "我是 opencode，专注于帮助软件工程工作". Not optional.
            agent: optString(channel, "agent", "llm"),
            ...(optString(channel, "variant", "") ? { variant: optString(channel, "variant", "") } : {}),
            parts: [
              { type: "text", text: prompt },
              ...images.map((img) => ({ type: "file", mime: img.mime, url: img.url, filename: img.filename })),
            ],
          },
          signal,
        );
      } finally {
        // Best-effort: a failed cleanup must not turn a good answer into an
        // error. It leaks a row into a database that is ours and isolated.
        await call("DELETE", `${root}/session/${encodeURIComponent(sessionID)}`, undefined, signal).catch(
          () => undefined,
        );
      }

      const content = textOf(reply);
      if (!content) {
        const reason = errorOf(reply);
        throw new Error(
          `opencode returned no output (channel=${channel.id}, model=${channel.model})` +
            (reason ? ` —— ${reason}` : "，且服务端没有给出 info.error"),
        );
      }
      const usage = usageOf(reply);
      return openAiCompletion({ model: channel.id, content, ...(usage ? { usage } : {}) });
    },
  };
}

export const openCodeAdapter = createOpenCodeAdapter();
