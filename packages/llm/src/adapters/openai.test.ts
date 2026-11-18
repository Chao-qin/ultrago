/**
 * Generic OpenAI-compatible adapter tests.
 *
 * Mostly a passthrough, so the assertions worth having are about the three
 * things it does NOT pass through untouched: the model name, the credential,
 * and which spelling of the generation cap goes out.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { lmStudioAdapter, openAiAdapter } from "./openai.js";
import type { ChannelConfig, ChatRequest, JsonRecord } from "./types.js";

const CHANNEL: ChannelConfig = {
  id: "vendor",
  adapter: "openai",
  baseUrl: "https://api.example.com",
  apiKey: "sk-secret",
  model: "vendor-model-v2",
};

const HI: ChatRequest = { model: "vendor", messages: [{ role: "user", content: "hi" }] };

function callOf(req: ChatRequest, channel = CHANNEL, stream = false) {
  const call = openAiAdapter.buildRequest(req, channel, stream);
  return { call, body: JSON.parse(String(call.init.body)) as JsonRecord };
}

test("posts to /v1/chat/completions with bearer auth and the upstream model id", () => {
  const { call, body } = callOf(HI);
  assert.equal(call.url, "https://api.example.com/v1/chat/completions");
  assert.equal((call.init.headers as Record<string, string>).Authorization, "Bearer sk-secret");
  assert.equal(body.model, "vendor-model-v2");
  assert.equal(body.stream, false);
});

test("a channel with no apiKey sends no Authorization header at all", () => {
  const { call } = callOf(HI, { ...CHANNEL, apiKey: undefined });
  assert.equal((call.init.headers as Record<string, string>).Authorization, undefined);
});

test("unknown request fields ride through — a gateway must not drop what it does not know", () => {
  const { body } = callOf({ ...HI, logit_bias: { "1": 2 }, some_future_field: true });
  assert.deepEqual(body.logit_bias, { "1": 2 });
  assert.equal(body.some_future_field, true);
});

test("the generation cap is re-emitted under the spelling the channel declares", () => {
  // Default: max_tokens, which is what Ollama's compat layer and most vendors take.
  const legacy = callOf({ ...HI, max_completion_tokens: 64 }).body;
  assert.equal(legacy.max_tokens, 64);
  assert.equal(legacy.max_completion_tokens, undefined);

  // Opt in for OpenAI o-series, where max_tokens is deprecated and ignored.
  const modern = callOf({ ...HI, max_tokens: 64 }, {
    ...CHANNEL,
    options: { maxTokensField: "max_completion_tokens" },
  }).body;
  assert.equal(modern.max_completion_tokens, 64);
  assert.equal(modern.max_tokens, undefined);
});

test("responses report the channel id, not the upstream's private model name", () => {
  const out = openAiAdapter.parseResponse(
    { model: "vendor-model-v2", choices: [{ index: 0, message: { content: "hi" } }] },
    CHANNEL,
  );
  assert.equal(out.model, "vendor");

  const chunk = openAiAdapter.parseStreamFrame(
    { model: "vendor-model-v2", choices: [{ index: 0, delta: { content: "h" } }] },
    CHANNEL,
    { id: "ignored", created: 0 },
  );
  assert.equal(chunk?.model, "vendor");
});

test("a body with no choices is an upstream failure, not an empty answer", () => {
  assert.throws(() => openAiAdapter.parseResponse({ id: "x" }, CHANNEL), /no choices/);
  assert.equal(openAiAdapter.parseStreamFrame({ id: "x" }, CHANNEL, { id: "i", created: 0 }), null);
});

test("lmstudio is the same protocol under its own name", () => {
  assert.equal(lmStudioAdapter.name, "lmstudio");
  assert.equal(
    lmStudioAdapter.buildRequest(HI, CHANNEL, false).url,
    "https://api.example.com/v1/chat/completions",
  );
});
