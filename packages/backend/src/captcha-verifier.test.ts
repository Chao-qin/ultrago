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

const cloud = { id: 'gpt-vision', bcp: { sources: [{ adapter: 'openai', baseUrl: 'https://vendor.example' }] } };

function fixture(answer: unknown, models: unknown[] = [local], allowCloud = () => false) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(String(url).endsWith('/models') ? { data: models } : answer);
  };
  const verify = createCaptchaVerifier({ baseUrl: 'http://127.0.0.1:11435', fetch: fetcher, allowCloud });
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

test('with cloud verification allowed, a cloud model is used only when no local one exists', async () => {
  const verdict = completion('{"isCaptcha":true,"reason":"Slider"}');
  const onlyCloud = fixture(verdict, [cloud], () => true);
  await onlyCloud.verify(IMAGE, new AbortController().signal);
  const body = JSON.parse(String(onlyCloud.calls[1].init?.body));
  assert.equal(body.model, cloud.id);
  assert.equal('reasoning_effort' in body, false, 'Ollama 专用参数不发给云端');
  const both = fixture(verdict, [cloud, local], () => true);
  await both.verify(IMAGE, new AbortController().signal);
  assert.equal(JSON.parse(String(both.calls[1].init?.body)).model, local.id, '本机模型可用时始终优先');
});

test('the cloud switch is read on every verification, not when the verifier is built', async () => {
  let allowed = false;
  const { verify, calls } = fixture(completion('{"isCaptcha":true,"reason":"Slider"}'), [cloud], () => allowed);
  await assert.rejects(verify(IMAGE, new AbortController().signal), /local.*model/i);
  assert.equal(calls.length, 1, '关闭时截图不发出');
  allowed = true;
  await verify(IMAGE, new AbortController().signal);
  assert.equal(JSON.parse(String(calls.at(-1)?.init?.body)).model, cloud.id);
});

test('with cloud verification allowed, a channel without an HTTP endpoint is still refused', async () => {
  // opencode channels can carry a baseUrl too: only the adapter type keeps them out.
  const cli = { id: 'opencode/free', bcp: { sources: [{ adapter: 'opencode', baseUrl: 'https://opencode.example' }] } };
  const { verify, calls } = fixture(completion('{"isCaptcha":true,"reason":"yes"}'), [cli], () => true);
  await assert.rejects(verify(IMAGE, new AbortController().signal), /local or cloud model/i);
  assert.equal(calls.length, 1);
});

test('with cloud verification allowed, a remote endpoint must be https', async () => {
  const plain = { id: 'plain', bcp: { sources: [{ adapter: 'openai', baseUrl: 'http://vendor.example' }] } };
  const { verify, calls } = fixture(completion('{"isCaptcha":true,"reason":"yes"}'), [plain], () => true);
  await assert.rejects(verify(IMAGE, new AbortController().signal), /local or cloud model/i);
  assert.equal(calls.length, 1, '明文 http 的远程地址收不到截图');
});

test('allowing cloud verification never accepts a remote gateway', async () => {
  let called = false;
  const verify = createCaptchaVerifier({
    baseUrl: 'https://vendor.example', allowCloud: () => true,
    fetch: async () => { called = true; return Response.json({}); },
  });
  await assert.rejects(verify(IMAGE, new AbortController().signal), /local.*gateway/i);
  assert.equal(called, false);
});

test('by default the switch is the backend setting BCP_CLOUD_CAPTCHA, off unless set', async () => {
  const saved = process.env.BCP_CLOUD_CAPTCHA;
  const calls: string[] = [];
  const verify = createCaptchaVerifier({ baseUrl: 'http://127.0.0.1:11435', fetch: async (url, init) => {
    calls.push(String(init?.body ?? ''));
    return Response.json(String(url).endsWith('/models') ? { data: [cloud] } : completion('{"isCaptcha":true,"reason":"Slider"}'));
  } });
  try {
    delete process.env.BCP_CLOUD_CAPTCHA;
    await assert.rejects(verify(IMAGE, new AbortController().signal), /local.*model/i);
    process.env.BCP_CLOUD_CAPTCHA = 'on';
    await verify(IMAGE, new AbortController().signal);
    assert.equal(JSON.parse(calls.at(-1) ?? '{}').model, cloud.id);
  } finally {
    if (saved === undefined) delete process.env.BCP_CLOUD_CAPTCHA; else process.env.BCP_CLOUD_CAPTCHA = saved;
  }
});
