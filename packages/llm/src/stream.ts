/**
 * Upstream stream framing.
 *
 * Two shapes reach us and an adapter should not have to care which: OpenAI-ish
 * servers emit SSE (`data: {...}` separated by blank lines), Ollama emits bare
 * JSON, one object per line. Both are line-oriented JSON, so one reader handles
 * them and yields parsed objects either way.
 */
import type { JsonRecord } from "./adapters/types.js";

/**
 * Yield parsed frames from a response body.
 *
 * Malformed JSON throws rather than being skipped: a frame we cannot read means
 * output is already being lost, and continuing would hand the caller a silently
 * truncated answer instead of an error.
 */
export async function* readFrames(res: Response): AsyncGenerator<JsonRecord> {
  if (!res.body) throw new Error("upstream response has no body stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        const trimmed = line.trim();
        if (!trimmed) continue;

        const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        if (payload === "[DONE]") return;
        // SSE event names and `: keep-alive` comments are not frames.
        if (!payload.startsWith("{") && !payload.startsWith("[")) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          throw new Error(`malformed stream frame: ${payload.slice(0, 200)}`);
        }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const frame = parsed as JsonRecord;
          if (frame.error) {
            throw new Error(`upstream stream error: ${JSON.stringify(frame.error)}`);
          }
          yield frame;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
