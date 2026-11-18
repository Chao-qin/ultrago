/**
 * Legacy `/v1/completions` translation tests.
 *
 * The valuable assertions here are the REFUSALS. Translating a prompt into a
 * message is obvious; the trap is the handful of legacy-only knobs that have no
 * chat equivalent, where silently ignoring one returns a confident answer that
 * is missing exactly the thing the caller asked for.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { RequestError } from "./adapters/types.js";
import { fromChatChunk, fromChatCompletion, toChatRequest } from "./completions.js";

test("a prompt becomes a single user message, everything else rides through", () => {
  const chat = toChatRequest({
    model: "m",
    prompt: "写一句诗",
    temperature: 0.2,
    max_tokens: 64,
    stream: true,
  });
  assert.deepEqual(chat.messages, [{ role: "user", content: "写一句诗" }]);
  assert.equal(chat.model, "m");
  assert.equal(chat.temperature, 0.2);
  assert.equal(chat.max_tokens, 64);
  assert.equal(chat.stream, true);
  assert.equal("prompt" in chat, false, "the legacy field must not reach the upstream");
});

test("legacy-only knobs are refused, not dropped", () => {
  for (const [key, value] of [
    ["echo", true],
    ["suffix", "尾巴"],
    ["best_of", 3],
    ["logprobs", 5],
  ] as const) {
    assert.throws(
      () => toChatRequest({ model: "m", prompt: "hi", [key]: value }),
      (error: unknown) => error instanceof RequestError && new RegExp(key).test(error.message),
      `${key} must be refused`,
    );
  }
});

test("a knob explicitly switched off is not a refusal", () => {
  // `echo: false` asks for the default behaviour, which we already provide.
  assert.ok(toChatRequest({ model: "m", prompt: "hi", echo: false }));
});

test("a single-element prompt array works; a real batch is refused", () => {
  assert.deepEqual(toChatRequest({ model: "m", prompt: ["一句"] }).messages, [
    { role: "user", content: "一句" },
  ]);
  // The old batch form returns N independent completions — chat's array is a
  // conversation, not a batch, so answering only the first would be wrong.
  assert.throws(() => toChatRequest({ model: "m", prompt: ["a", "b"] }), /只支持恰好一个字符串/);
  assert.throws(() => toChatRequest({ model: "m", prompt: [123] }), /只支持恰好一个字符串/);
});

test("a missing or mistyped prompt / model is a 400", () => {
  assert.throws(() => toChatRequest({ model: "m" }), /"prompt" must be a string/);
  assert.throws(() => toChatRequest({ model: "m", prompt: 42 }), /"prompt" must be a string/);
  assert.throws(() => toChatRequest({ prompt: "hi" }), /"model" must be a non-empty string/);
});

test("a chat completion comes back as a text completion", () => {
  const legacy = fromChatCompletion({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "答案" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
  assert.equal(legacy.object, "text_completion");
  assert.deepEqual(legacy.choices, [
    { index: 0, text: "答案", finish_reason: "stop", logprobs: null },
  ]);
  // Usage and id ride through untouched — they mean the same thing in both shapes.
  assert.deepEqual(legacy.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  assert.equal(legacy.id, "chatcmpl-1");
});

test("a stream chunk's delta becomes text, and an empty one stays empty", () => {
  const chunk = fromChatChunk({
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: "片" }, finish_reason: null }],
  });
  assert.equal(chunk.object, "text_completion");
  assert.deepEqual(chunk.choices, [{ index: 0, text: "片", finish_reason: null, logprobs: null }]);

  // The terminal chunk carries no content but must still be well-formed —
  // clients index into choices[0].text unconditionally.
  const last = fromChatChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  assert.deepEqual(last.choices, [{ index: 0, text: "", finish_reason: "stop", logprobs: null }]);
});

test("a payload with no choices does not throw", () => {
  // Keep-alive and bookkeeping frames reach here too; they must pass through
  // as an empty list rather than crashing the stream.
  assert.deepEqual(fromChatChunk({ object: "x" }).choices, []);
  assert.deepEqual(fromChatCompletion({}).choices, []);
});
