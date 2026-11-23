import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCaptchaVerifier } from './captcha-verifier.js';

const IMAGE = 'data:image/jpeg;base64,/9j/2Q==';
const local = {
  id: 'qwen3.5:4b',
  bcp: { sources: [{ adapter: 'ollama', baseUrl: 'http://127.0.0.1:11437' }] },
};
const completion = (content: unknown, finishReason = 'stop') => ({
  choices: [{ finish_reason: finishReason, message: { content } }],
});

function fixture(answer: unknown, models: unknown[] = [local]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(String(url).endsWith('/models') ? { data: models } : answer);
  };
  const verify = createCaptchaVerifier({ baseUrl: 'http://127.0.0.1:11435', fetch: fetcher });
  return { verify, calls };
}

test('local visual verification sends the compressed image and parses an explicit verdict', async () => {
  const expected = { isCaptcha: true, reason: 'Visible slider challenge' };
  const { verify, calls } = fixture(completion(JSON.stringify(expected)));
  assert.deepEqual(await verify(IMAGE, new AbortController().signal), expected);
  assert.deepEqual(calls.map((call) => call.url), [
    'http://127.0.0.1:11435/v1/models',
    'http://127.0.0.1:11435/v1/chat/completions',
  ]);
  assert.equal((calls[1].init?.headers as Record<string, string>)['X-BCP-Caller'], 'captcha-verifier');
  const body = JSON.parse(String(calls[1].init?.body));
  assert.equal(body.model, 'qwen3.5:4b');
  assert.equal(body.stream, false);
  assert.equal(body.messages[1].content[1].image_url.url, IMAGE);
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.reasoning_effort, 'none');
  assert.equal('think' in body, false);
  assert.equal('chat_template_kwargs' in body, false);
});

test('false is preserved instead of becoming a truthy response object', async () => {
  const { verify } = fixture(completion('{"isCaptcha":false,"reason":"SMS code input"}'));
  assert.equal((await verify(IMAGE, new AbortController().signal)).isCaptcha, false);
});

test('LM Studio local model names are discovered without hardcoding the Ollama name', async () => {
  const { verify, calls } = fixture(completion('{"isCaptcha":true,"reason":"Puzzle"}'), [{
    id: 'qwen3.5-9b',
    bcp: { sources: [{ adapter: 'lmstudio', baseUrl: 'http://localhost:11436' }] },
  }]);
  await verify(IMAGE, new AbortController().signal);
  assert.equal(JSON.parse(String(calls[1].init?.body)).model, 'qwen3.5-9b');
  const body = JSON.parse(String(calls[1].init?.body));
  assert.equal('think' in body, false);
  assert.equal('chat_template_kwargs' in body, false);
  assert.equal('reasoning_effort' in body, false);
});

test('an empty BCP_LLM_URL uses the configured local gateway port', async () => {
  const previous = process.env.BCP_LLM_URL;
  process.env.BCP_LLM_URL = '';
  const urls: string[] = [];
  try {
    const verify = createCaptchaVerifier({ fetch: async (url) => {
      urls.push(String(url));
      return Response.json(String(url).endsWith('/models')
        ? { data: [local] }
        : completion('{"isCaptcha":false,"reason":"Ordinary page"}'));
    } });
    await verify(IMAGE, new AbortController().signal);
    assert.equal(urls[0], `http://127.0.0.1:${process.env.BCP_LLM_PORT || '11435'}/v1/models`);
  } finally {
    if (previous === undefined) delete process.env.BCP_LLM_URL;
    else process.env.BCP_LLM_URL = previous;
  }
});

for (const model of [
  { id: 'cloud', bcp: { sources: [{ adapter: 'openai', baseUrl: 'https://vendor.example' }] } },
  { id: 'remote-ollama', bcp: { sources: [{ adapter: 'ollama', baseUrl: 'http://192.0.2.1:11434' }] } },
  { id: 'mixed', bcp: { sources: [...local.bcp.sources, { adapter: 'openai', baseUrl: 'https://vendor.example' }] } },
  { id: 'unknown', bcp: { sources: [] } },
]) {
  test(`no model request is sent to an unsafe or unknown route (${model.id})`, async () => {
    const { verify, calls } = fixture(completion('{"isCaptcha":true,"reason":"yes"}'), [model]);
    await assert.rejects(verify(IMAGE, new AbortController().signal), /local.*model/i);
    assert.equal(calls.length, 1);
  });
}

test('cloud entries are skipped when a separate local model is available', async () => {
  const { verify, calls } = fixture(completion('{"isCaptcha":true,"reason":"Puzzle"}'), [
    { id: 'cloud', bcp: { sources: [{ adapter: 'openai', baseUrl: 'https://vendor.example' }] } },
    local,
  ]);
  await verify(IMAGE, new AbortController().signal);
  assert.equal(JSON.parse(String(calls[1].init?.body)).model, local.id);
});

for (const [name, response] of Object.entries({
  stringBoolean: completion('{"isCaptcha":"true","reason":"Puzzle"}'),
  uncertain: completion('{"isCaptcha":null,"reason":"Unclear"}'),
  noReason: completion('{"isCaptcha":true}'),
  prose: completion('This looks like a CAPTCHA'),
  fenced: completion('```json\n{"isCaptcha":true,"reason":"Puzzle"}\n```'),
  truncated: completion('{"isCaptcha":true,"reason":"Puzzle"}', 'length'),
  toolCall: completion('{"isCaptcha":true,"reason":"Puzzle"}', 'tool_calls'),
  noChoices: {},
  nullResponse: null,
})) {
  test(`invalid or incomplete verdict is rejected (${name})`, async () => {
    const { verify } = fixture(response);
    await assert.rejects(verify(IMAGE, new AbortController().signal));
  });
}

test('uncompressed or oversized screenshots never reach the model', async () => {
  const { verify, calls } = fixture({});
  for (const image of ['data:image/png;base64,AAAA', 'https://example.com/img.jpg', `data:image/jpeg;base64,${'A'.repeat(2_000_000)}`]) {
    await assert.rejects(verify(image, new AbortController().signal), /compressed JPEG/i);
  }
  assert.deepEqual(calls, []);
});

test('remote gateway configuration is rejected before uploading an image', async () => {
  let called = false;
  const verify = createCaptchaVerifier({
    baseUrl: 'https://vendor.example',
    fetch: async () => { called = true; return Response.json({}); },
  });
  await assert.rejects(verify(IMAGE, new AbortController().signal), /local.*gateway/i);
  assert.equal(called, false);
});

test('HTTP failures are not interpreted as a successful verdict', async () => {
  const verify = createCaptchaVerifier({ fetch: async () => new Response(null, { status: 503 }) });
  await assert.rejects(verify(IMAGE, new AbortController().signal), /HTTP 503/);
});

test('the deadline aborts a stalled request', async () => {
  const verify = createCaptchaVerifier({
    timeoutMs: 10,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }),
  });
  await assert.rejects(verify(IMAGE, new AbortController().signal), /timeout/i);
});

test('candidate invalidation aborts the model request', async () => {
  const controller = new AbortController();
  const verify = createCaptchaVerifier({
    fetch: async (_url, init) => {
      const result = new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
      controller.abort(new Error('candidate expired'));
      return result;
    },
  });
  await assert.rejects(verify(IMAGE, controller.signal), /candidate expired/);
});
