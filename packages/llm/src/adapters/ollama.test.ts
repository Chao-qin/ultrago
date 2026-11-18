/**
 * Ollama adapter tests.
 *
 * The first test is the reason this adapter exists at all: `num_ctx` must reach
 * the upstream. Delete that line from inferenceOptions and the whole stack goes
 * back to Ollama's 2048 default with no error anywhere — which is exactly the
 * failure this adapter was written to make impossible.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ollamaAdapter, toOllamaFormat, toOllamaMessages } from "./ollama.js";
import { RequestError, type ChannelConfig, type ChatRequest, type JsonRecord } from "./types.js";

const CHANNEL: ChannelConfig = {
  id: "local",
  adapter: "ollama",
  baseUrl: "http://127.0.0.1:11437",
  model: "qwen3.5:4b",
  options: { numCtx: 32768 },
};

const HI: ChatRequest = { model: "local", messages: [{ role: "user", content: "hi" }] };

function bodyOf(req: ChatRequest, channel = CHANNEL, stream = false): JsonRecord {
  const call = ollamaAdapter.buildRequest(req, channel, stream);
  return JSON.parse(String(call.init.body)) as JsonRecord;
}

test("num_ctx from the channel reaches /api/chat", () => {
  const call = ollamaAdapter.buildRequest(HI, CHANNEL, false);
  assert.equal(call.url, "http://127.0.0.1:11437/api/chat");
  const options = (JSON.parse(String(call.init.body)) as JsonRecord).options as JsonRecord;
  assert.equal(options.num_ctx, 32768);
});

test("a channel without numCtx sends no num_ctx rather than a guessed one", () => {
  const body = bodyOf(HI, { ...CHANNEL, options: undefined });
  assert.equal((body.options as JsonRecord | undefined)?.num_ctx, undefined);
});

test("the upstream model name is used, not the channel id the caller sent", () => {
  assert.equal(bodyOf(HI).model, "qwen3.5:4b");
});

test("both max-tokens spellings map to options.num_predict", () => {
  assert.equal((bodyOf({ ...HI, max_tokens: 128 }).options as JsonRecord).num_predict, 128);
  assert.equal(
    (bodyOf({ ...HI, max_completion_tokens: 256 }).options as JsonRecord).num_predict,
    256,
  );
});

test("sampling params ride through, including the ones Ollama shares by name", () => {
  const options = bodyOf({ ...HI, temperature: 0.1, seed: 7, frequency_penalty: 2 })
    .options as JsonRecord;
  assert.equal(options.temperature, 0.1);
  assert.equal(options.seed, 7);
  // frequency_penalty is OpenAI-standard AND a real Ollama option under the
  // same name, so it belongs in the bag rather than being dropped.
  assert.equal(options.frequency_penalty, 2);
});

test("provider-specific knobs reach options — the params OpenAI has no field for", () => {
  const options = bodyOf({ ...HI, repeat_penalty: 1.2, mirostat: 2, num_gpu: 99 })
    .options as JsonRecord;
  assert.equal(options.repeat_penalty, 1.2);
  assert.equal(options.mirostat, 2);
  assert.equal(options.num_gpu, 99);
});

test("keep_alive goes to the TOP level, where Ollama actually reads it", () => {
  const body = bodyOf({ ...HI, keep_alive: "10m" });
  assert.equal(body.keep_alive, "10m");
  assert.equal((body.options as JsonRecord).keep_alive, undefined);
});

test("OpenAI-only routing fields are not smuggled into the options bag", () => {
  const body = bodyOf({ ...HI, user: "abc", n: 1, tool_choice: "auto", store: true });
  const options = (body.options ?? {}) as JsonRecord;
  for (const key of ["user", "n", "tool_choice", "store"]) {
    assert.equal(options[key], undefined, `${key} must not leak into options`);
  }
});

test("features Ollama cannot honour are refused, not silently dropped", () => {
  // Answering n=3 with one completion, 200 and no warning, is a wrong answer
  // dressed as a right one.
  assert.throws(() => bodyOf({ ...HI, n: 3 }), /cannot return n=3/);
  assert.throws(() => bodyOf({ ...HI, logprobs: true }), /does not support "logprobs"/);
  assert.throws(() => bodyOf({ ...HI, logit_bias: { "1": 2 } }), /does not support "logit_bias"/);
  assert.throws(() => bodyOf({ ...HI, tool_choice: "required" }), /only "auto"/);
});

test("metadata-only fields stay ignored — dropping them changes no answer", () => {
  for (const extra of [{ user: "u" }, { store: true }, { metadata: { a: 1 } }, { service_tier: "auto" }]) {
    assert.doesNotThrow(() => bodyOf({ ...HI, ...extra }));
  }
  assert.doesNotThrow(() => bodyOf({ ...HI, n: 1, logprobs: false }));
});

test("an explicitly sent num_ctx beats the channel default — loudly, not silently", () => {
  assert.equal((bodyOf(HI).options as JsonRecord).num_ctx, 32768);
  assert.equal((bodyOf({ ...HI, num_ctx: 8192 }).options as JsonRecord).num_ctx, 8192);
});

test("think defaults to false and honours reasoning_effort: none", () => {
  assert.equal(bodyOf(HI).think, false);
  assert.equal(bodyOf(HI, { ...CHANNEL, options: { think: true } }).think, true);
  assert.equal(
    bodyOf({ ...HI, reasoning_effort: "none" }, { ...CHANNEL, options: { think: true } }).think,
    false,
  );
});

test("string content and part arrays both convert; images become base64", () => {
  assert.deepEqual(toOllamaMessages([{ role: "user", content: "plain" }]), [
    { role: "user", content: "plain" },
  ]);
  assert.deepEqual(
    toOllamaMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
        ],
      },
    ]),
    [{ role: "user", content: "look", images: ["QUJD"] }],
  );
});

test("a remote image URL is refused instead of forwarded to an upstream that cannot fetch it", () => {
  assert.throws(
    () =>
      toOllamaMessages([
        { role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] },
      ]),
    RequestError,
  );
});

test("response_format maps to Ollama's format", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };
  assert.deepEqual(
    toOllamaFormat({ ...HI, response_format: { type: "json_schema", json_schema: { schema } } }),
    schema,
  );
  assert.equal(toOllamaFormat({ ...HI, response_format: { type: "json_object" } }), "json");
  assert.equal(toOllamaFormat(HI), undefined);
});

test("a completion is normalised to OpenAI shape, reporting the channel id", () => {
  const out = ollamaAdapter.parseResponse(
    {
      message: { content: "hello", thinking: "chain" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 10,
      eval_count: 4,
    },
    CHANNEL,
  );
  assert.equal(out.object, "chat.completion");
  assert.equal(out.model, "local");
  const choice = (out.choices as JsonRecord[])[0];
  assert.equal((choice.message as JsonRecord).content, "hello");
  assert.equal((choice.message as JsonRecord).reasoning_content, "chain");
  assert.equal(choice.finish_reason, "stop");
  assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
});

test("empty content throws — unless the reply is a pure tool call", () => {
  assert.throws(
    () => ollamaAdapter.parseResponse({ message: { content: "  " }, done: true }, CHANNEL),
    /empty content/,
  );
  const out = ollamaAdapter.parseResponse(
    { message: { content: "", tool_calls: [{ function: { name: "f" } }] }, done: true },
    CHANNEL,
  );
  assert.equal(((out.choices as JsonRecord[])[0].message as JsonRecord).content, "");
});

test("stream frames: text becomes a delta, the done frame carries finish_reason, nothing else emits", () => {
  const STREAM = { id: "chatcmpl-fixed", created: 1700000000 };
  const delta = ollamaAdapter.parseStreamFrame({ message: { content: "ab" }, done: false }, CHANNEL, STREAM);
  assert.equal(((delta?.choices as JsonRecord[])[0].delta as JsonRecord).content, "ab");
  assert.equal((delta?.choices as JsonRecord[])[0].finish_reason, null);
  assert.equal(delta?.object, "chat.completion.chunk");

  const done = ollamaAdapter.parseStreamFrame(
    { message: { content: "" }, done: true, done_reason: "length" },
    CHANNEL,
    STREAM,
  );
  assert.equal((done?.choices as JsonRecord[])[0].finish_reason, "length");
  // Same completion, same envelope — a fresh id per frame would split one
  // answer into a pile of single-token completions on the client side.
  assert.equal(delta?.id, "chatcmpl-fixed");
  assert.equal(done?.id, "chatcmpl-fixed");
  assert.equal(done?.created, 1700000000);

  // An empty mid-stream frame is not a chunk; forwarding it would emit a
  // meaningless delta to every caller.
  assert.equal(
    ollamaAdapter.parseStreamFrame({ message: { content: "" }, done: false }, CHANNEL, STREAM),
    null,
  );
});
