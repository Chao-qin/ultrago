import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { BrowserEvent } from '@bcp/shared';
import { createEventWebhook } from './event-webhook.js';
import type { CaptureFn } from './event-webhook.js';

const IMAGE = 'data:image/jpeg;base64,/9j/2Q==';
const appeared = (overrides: Partial<BrowserEvent> = {}): BrowserEvent => ({
  kind: 'captcha_appeared',
  browser: 'browser-a',
  tabId: 12,
  ts: Date.now(),
  summary: 'challenge detected',
  detail: { frameId: 0, evidence: ['x'] },
  ...overrides,
});
const verdict = { isCaptcha: true, reason: 'Visible slider puzzle blocks the page' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(t: TestContext, options: {
  verify?: (image: string, signal: AbortSignal) => Promise<typeof verdict>;
  capture?: CaptureFn;
  post?: () => Promise<Response>;
} = {}) {
  const posts: BrowserEvent[] = [];
  const images: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    posts.push(JSON.parse(String(init.body)) as BrowserEvent);
    return options.post ? options.post() : new Response(null, { status: 200 });
  });
  t.mock.method(console, 'warn', () => {});
  const notify = createEventWebhook(
    'http://127.0.0.1:9999/hook',
    options.capture ?? (async () => ({ dataUrl: IMAGE })),
    {
      settleMs: 0,
      verify: async (image, signal) => {
        images.push(image);
        return options.verify ? options.verify(image, signal) : verdict;
      },
    },
  );
  return { notify, posts, images };
}

test('captcha notification requires a verifier for every raw candidate', async (t) => {
  const { posts } = harness(t);
  await createEventWebhook('http://127.0.0.1:9999/hook')(appeared());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posts, []);
});

test('confirmed screenshot is verified before appearing and clearing notifications are sent', async (t) => {
  const { notify, images, posts } = harness(t);
  await notify(appeared());
  assert.deepEqual(images, [IMAGE]);
  assert.equal((posts[0] as BrowserEvent & { screenshot: string }).screenshot, IMAGE);
  await notify(appeared({ kind: 'captcha_cleared' }));
  assert.deepEqual(posts.map((event) => event.kind), ['captcha_appeared', 'captcha_cleared']);
});

test('negative verdict suppresses both appearance and subsequent clearance', async (t) => {
  const { notify, images, posts } = harness(t, {
    verify: async () => ({ isCaptcha: false, reason: 'Ordinary SMS login form' }),
  });
  await notify(appeared());
  await notify(appeared({ kind: 'captcha_cleared' }));
  assert.equal(images.length, 1);
  assert.deepEqual(posts, []);
});

for (const [name, capture] of Object.entries<CaptureFn>({
  missing: async () => null,
  wrongTab: async () => ({ dataUrl: IMAGE, warning: 'wrong tab' }),
  failed: async () => { throw new Error('capture failed'); },
})) {
  test(`unusable screenshot (${name}) suppresses verification and notification`, async (t) => {
    const { notify, images, posts } = harness(t, { capture });
    await notify(appeared());
    await notify(appeared({ kind: 'captcha_cleared' }));
    assert.deepEqual(images, []);
    assert.deepEqual(posts, []);
  });
}

test('verifier errors are handled and never fall back to raw notifications', async (t) => {
  const { notify, posts } = harness(t, {
    verify: async () => { throw new Error('model timeout'); },
  });
  await notify(appeared());
  await notify(appeared({ kind: 'captcha_cleared' }));
  assert.deepEqual(posts, []);
});

for (const kind of ['captcha_cleared', 'navigation_started', 'navigation', 'tab_closed', 'browser_offline'] as const) {
  test(`${kind} invalidates an in-flight verification`, async (t) => {
    const started = deferred<AbortSignal>();
    const result = deferred<typeof verdict>();
    const { notify, posts } = harness(t, {
      verify: async (_image, signal) => { started.resolve(signal); return result.promise; },
    });
    const pending = notify(appeared());
    const signal = await started.promise;
    await notify(appeared({ kind, ...(kind === 'browser_offline' ? { tabId: -1 } : {}) }));
    assert.equal(signal.aborted, true);
    result.resolve(verdict);
    await pending;
    assert.deepEqual(posts.map((event) => event.kind), kind === 'browser_offline' ? [kind] : []);
  });
}

test('navigation during capture prevents a later model call', async (t) => {
  const started = deferred<void>();
  const capture = deferred<{ dataUrl: string }>();
  const { notify, images, posts } = harness(t, {
    capture: async () => { started.resolve(); return capture.promise; },
  });
  const pending = notify(appeared());
  await started.promise;
  await notify(appeared({ kind: 'navigation' }));
  capture.resolve({ dataUrl: IMAGE });
  await pending;
  assert.deepEqual(images, []);
  assert.deepEqual(posts, []);
});

test('duplicate appearance does not start another verification', async (t) => {
  const started = deferred<void>();
  const result = deferred<typeof verdict>();
  const { notify, images, posts } = harness(t, {
    verify: async () => { started.resolve(); return result.promise; },
  });
  const pending = notify(appeared());
  await started.promise;
  await notify(appeared());
  result.resolve(verdict);
  await pending;
  await notify(appeared());
  assert.equal(images.length, 1);
  assert.equal(posts.length, 1);
});

test('browser, tab and frame identities isolate verification lifetimes', async (t) => {
  const { notify, posts } = harness(t);
  await notify(appeared());
  await notify(appeared({ kind: 'captcha_cleared', browser: 'browser-b' }));
  await notify(appeared({ kind: 'captcha_cleared', tabId: 13 }));
  await notify(appeared({ kind: 'captcha_cleared', detail: { frameId: 1 } }));
  assert.equal(posts.length, 1);
  await notify(appeared({ kind: 'captcha_cleared' }));
  assert.equal(posts.length, 2);
});

test('clearance waits for an already-started appearance POST to succeed', async (t) => {
  const sent = deferred<void>();
  const response = deferred<Response>();
  let attempts = 0;
  const { notify, posts } = harness(t, {
    post: async () => {
      attempts++;
      if (attempts === 1) { sent.resolve(); return response.promise; }
      return new Response(null, { status: 200 });
    },
  });
  const pending = notify(appeared());
  await sent.promise;
  const clearing = notify(appeared({ kind: 'captcha_cleared' }));
  assert.equal(posts.length, 1);
  response.resolve(new Response(null, { status: 200 }));
  await Promise.all([pending, clearing]);
  assert.deepEqual(posts.map((event) => event.kind), ['captcha_appeared', 'captcha_cleared']);
});

test('failed appearance delivery does not produce an orphan clearance', async (t) => {
  const { notify, posts } = harness(t, { post: async () => new Response(null, { status: 500 }) });
  await notify(appeared());
  await notify(appeared({ kind: 'captcha_cleared' }));
  assert.deepEqual(posts.map((event) => event.kind), ['captcha_appeared']);
});

test('two challenge rounds preserve appearance-clearance order while the first POST is pending', async (t) => {
  const sent = deferred<void>();
  const response = deferred<Response>();
  let attempts = 0;
  const { notify, posts } = harness(t, {
    post: async () => {
      if (++attempts === 1) { sent.resolve(); return response.promise; }
      return new Response(null, { status: 200 });
    },
  });
  const first = notify(appeared({ seq: 1 }));
  await sent.promise;
  const clearing = notify(appeared({ kind: 'captcha_cleared', seq: 2 }));
  const next = notify(appeared({ seq: 3 }));
  await new Promise((resolve) => setImmediate(resolve));
  response.resolve(new Response(null, { status: 200 }));
  await Promise.all([first, clearing, next]);
  assert.deepEqual(posts.map((event) => event.seq), [1, 2, 3]);
});

test('a cleared candidate cannot replace or remove the next candidate', async (t) => {
  const started = deferred<void>();
  const result = deferred<typeof verdict>();
  let calls = 0;
  const { notify, posts } = harness(t, {
    verify: async () => {
      if (++calls === 1) { started.resolve(); return result.promise; }
      return verdict;
    },
  });
  const old = notify(appeared());
  await started.promise;
  await notify(appeared({ kind: 'captcha_cleared' }));
  await notify(appeared({ seq: 2 }));
  result.resolve(verdict);
  await old;
  await notify(appeared({ kind: 'captcha_cleared', seq: 3 }));
  assert.deepEqual(posts.map((event) => event.seq), [2, 3]);
});

test('a verified candidate that expires while waiting for delivery is not sent', async (t) => {
  const sent = deferred<void>();
  const response = deferred<Response>();
  let attempts = 0;
  const { notify, posts, images } = harness(t, {
    post: async () => {
      if (++attempts === 1) { sent.resolve(); return response.promise; }
      return new Response(null, { status: 200 });
    },
  });
  const first = notify(appeared({ seq: 1 }));
  await sent.promise;
  const clearing = notify(appeared({ kind: 'captcha_cleared', seq: 2 }));
  const next = notify(appeared({ seq: 3 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(images.length, 2);
  await notify(appeared({ kind: 'navigation_started' }));
  response.resolve(new Response(null, { status: 200 }));
  await Promise.all([first, clearing, next]);
  assert.deepEqual(posts.map((event) => event.seq), [1, 2]);
});

test('subframe navigation invalidates only that frame', async (t) => {
  const { notify, posts } = harness(t);
  await notify(appeared());
  await notify(appeared({ detail: { frameId: 7 } }));
  await notify(appeared({ kind: 'navigation_started', detail: { frameId: 7 } }));
  await notify(appeared({ kind: 'captcha_cleared', detail: { frameId: 7 } }));
  await notify(appeared({ kind: 'captcha_cleared' }));
  assert.deepEqual(posts.map((event) => event.kind), ['captcha_appeared', 'captcha_appeared', 'captcha_cleared']);
  assert.equal(posts[2].detail?.frameId, 0);
});
