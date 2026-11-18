/**
 * `/v1/completions` — the legacy text endpoint, expressed as a translation.
 *
 * Nothing in this repo calls it. It exists because the gateway is going to face
 * outward, and there are still clients (older SDK pins, curl snippets copied off
 * a blog, a few self-hosted tools) that only speak this shape. Turning them away
 * at the door would be a support burden out of all proportion to the ~80 lines
 * it takes to accept them.
 *
 * **It is a translation, not a second service path.** The request becomes a
 * ChatRequest, goes through the exact same routing / concurrency gate /
 * failover / telemetry as everything else, and only the two ends are reshaped.
 * A parallel implementation would be the real cost of this endpoint: every
 * future change to the chat path would need remembering here, and the one that
 * got forgotten would be found by a user, not a test.
 *
 * Fields with no chat equivalent are REJECTED, not dropped. `echo: true` that
 * silently does nothing returns a plausible answer missing the thing that was
 * asked for, which is worse than a 400 saying so.
 */
import { RequestError, type ChatRequest, type JsonRecord } from "./adapters/types.js";

/**
 * Legacy-only knobs.
 *
 * Each of these is a real behaviour of the old endpoint that the chat protocol
 * has no way to express:
 *   · `echo`      — prepend the prompt to the completion
 *   · `suffix`    — insert-mode, text after the completion
 *   · `best_of`   — sample N server-side, return the best
 *   · `logprobs`  — per-token probabilities (chat's is a different shape)
 */
const UNTRANSLATABLE = ["echo", "suffix", "best_of", "logprobs"] as const;

/**
 * Legacy request → chat request.
 *
 * `prompt` may legally be an array — that is the old batch form, where one call
 * returns several independent completions. Chat has no equivalent (its array is
 * a conversation, not a batch), so a multi-element prompt is refused rather than
 * quietly answered for only its first element.
 */
export function toChatRequest(body: JsonRecord): ChatRequest {
  const present = UNTRANSLATABLE.filter((key) => body[key] !== undefined && body[key] !== false);
  if (present.length > 0) {
    throw new RequestError(
      `/v1/completions 的 ${present.join(" / ")} 在 chat 协议里没有对应物，这个网关不支持 —— 请改用 /v1/chat/completions`,
    );
  }

  const { prompt, ...rest } = body;
  const text = ((): string => {
    if (typeof prompt === "string") return prompt;
    if (Array.isArray(prompt)) {
      if (prompt.length !== 1 || typeof prompt[0] !== "string") {
        throw new RequestError(
          '"prompt" 是数组时只支持恰好一个字符串 —— 老接口的批量形式在 chat 协议里没有对应物',
        );
      }
      return prompt[0];
    }
    throw new RequestError('"prompt" must be a string');
  })();

  if (typeof body.model !== "string" || !body.model) {
    throw new RequestError('"model" must be a non-empty string');
  }

  return {
    ...rest,
    model: body.model,
    // 单条 user 消息，不加任何 system —— 老接口没有角色概念，替调用方编一个
    // 角色就是在替它决定语气。
    messages: [{ role: "user", content: text }],
  } as ChatRequest;
}

function choiceText(choice: JsonRecord, key: "message" | "delta"): string {
  const content = (choice[key] as JsonRecord | undefined)?.content;
  return typeof content === "string" ? content : "";
}

/** Chat completion → legacy completion. */
export function fromChatCompletion(chat: JsonRecord): JsonRecord {
  const choices = Array.isArray(chat.choices) ? (chat.choices as JsonRecord[]) : [];
  return {
    ...chat,
    object: "text_completion",
    choices: choices.map((choice, index) => ({
      index: typeof choice.index === "number" ? choice.index : index,
      text: choiceText(choice, "message"),
      finish_reason: choice.finish_reason ?? "stop",
      // The old shape always carries this key; clients index into it. null is
      // the documented "not requested" value — and `logprobs` is refused above,
      // so it can never be anything else here.
      logprobs: null,
    })),
  };
}

/** Chat stream chunk → legacy stream chunk. */
export function fromChatChunk(chunk: JsonRecord): JsonRecord {
  const choices = Array.isArray(chunk.choices) ? (chunk.choices as JsonRecord[]) : [];
  return {
    ...chunk,
    object: "text_completion",
    choices: choices.map((choice, index) => ({
      index: typeof choice.index === "number" ? choice.index : index,
      text: choiceText(choice, "delta"),
      finish_reason: choice.finish_reason ?? null,
      logprobs: null,
    })),
  };
}
