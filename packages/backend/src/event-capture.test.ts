import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { RpcMethod } from '@bcp/shared';
import type { BrowserEvent, BrowserTarget } from '@bcp/shared';
import type { RawBrowserCall } from './browser-mcp-types.js';
import * as webhook from './event-webhook.js';
import { withForegroundLease } from './browser-screenshot.js';

const IMAGE = 'data:image/jpeg;base64,/9j/2Q==';
const TARGET: BrowserTarget = { kind: 'chrome', instanceId: 'browser-a' };

function harness(t: TestContext, options: { manual?: boolean; fail?: boolean; userSwitch?: boolean } = {}) {
  let activeTab = 1;
  const switches: Record<string, unknown>[] = [];
  const posts: Array<Record<string, unknown>> = [];
  const images: string[] = [];
  const call: RawBrowserCall = async (method, params, target) => {
    assert.deepEqual(target, TARGET);
    const p = params as { tabId?: number; compress?: boolean };
    switch (method) {
      case RpcMethod.ListTabs:
        return { tabs: [1, 2, 3].map((id) => ({ id, active: id === activeTab, windowId: 5, title: '', url: '' })) } as never;
      case RpcMethod.SwitchTab:
        switches.push({ ...params });
        activeTab = p.tabId!;
        return { tabId: activeTab, windowId: 5 } as never;
      case RpcMethod.Screenshot:
        assert.equal(p.compress, true);
        if (options.fail) throw new Error('capture failed');
        if (activeTab !== p.tabId) return { dataUrl: IMAGE, warning: 'wrong tab' } as never;
        if (options.userSwitch) activeTab = 3;
        return { dataUrl: IMAGE } as never;
      default:
        throw new Error(`Unexpected RPC: ${method}`);
    }
  };
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(null, { status: 200 });
  });
  t.mock.method(console, 'warn', () => {});
  const capture = webhook.createEventCapture(call, {
    list: () => [TARGET],
    getMode: () => options.manual ? 'manual' : 'auto',
  });
  const notify = webhook.createEventWebhook('http://localhost/hook', capture, {
    settleMs: 0,
    verify: async (image) => {
      images.push(image);
      return { isCaptcha: true, reason: 'Visible puzzle' };
    },
  });
  return { notify, capture, posts, images, switches, active: () => activeTab };
}

const appeared: BrowserEvent = {
  kind: 'captcha_appeared', browser: 'browser-a', tabId: 2,
  ts: 1, summary: 'captcha', detail: { evidence: ['x'] },
};

test('webhook verifies the background target screenshot and delivers paired notifications after restoring the view', async (t) => {
  const h = harness(t);
  await h.notify(appeared);
  await h.notify({ ...appeared, kind: 'captcha_cleared' });
  assert.deepEqual(h.images, [IMAGE]);
  assert.deepEqual(h.posts.map((p) => p.kind), ['captcha_appeared', 'captcha_cleared']);
  assert.equal(h.posts[0].screenshot, IMAGE);
  assert.equal(h.active(), 1);
  assert.deepEqual(h.switches, [
    { tabId: 2, focusWindow: false },
    { tabId: 1, focusWindow: false, restoringView: true },
  ]);
});

test('manual mode does not switch background tabs or send unverified events', async (t) => {
  const h = harness(t, { manual: true });
  await h.notify(appeared);
  assert.equal(h.active(), 1);
  assert.deepEqual(h.switches, []);
  assert.deepEqual(h.images, []);
  assert.deepEqual(h.posts, []);
});

test('capture failure restores the previous tab and suppresses notification', async (t) => {
  const h = harness(t, { fail: true });
  await h.notify(appeared);
  assert.equal(h.switches.length, 2);
  assert.equal(h.active(), 1);
  assert.deepEqual(h.posts, []);
});

test('restoration preserves a tab selected by the user during capture', async (t) => {
  const h = harness(t, { userSwitch: true });
  await h.notify(appeared);
  assert.equal(h.active(), 3);
  assert.equal(h.switches.length, 1);
  assert.equal(h.posts.length, 1);
});

test('manual mode can capture an already active tab without switching', async (t) => {
  const h = harness(t, { manual: true });
  await h.notify({ ...appeared, tabId: 1 });
  assert.deepEqual(h.switches, []);
  assert.equal(h.posts.length, 1);
});

test('unknown event browser never falls back to another browser', async (t) => {
  const h = harness(t);
  assert.equal(await h.capture('missing', 2), null);
  assert.deepEqual(h.switches, []);
});

test('webhook capture waits for the foreground lease held by MCP operations', async (t) => {
  const h = harness(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held = withForegroundLease(TARGET.instanceId, () => gate);
  const pending = h.notify(appeared);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.switches, []);
    assert.deepEqual(h.posts, []);
  } finally {
    release();
    await Promise.all([held, pending]);
  }
  assert.equal(h.posts.length, 1);
  assert.equal(h.active(), 1);
});

test('concurrent webhook captures restore each view before the next capture switches tabs', async (t) => {
  const h = harness(t);
  await Promise.all([h.notify(appeared), h.notify({ ...appeared, tabId: 3 })]);
  assert.deepEqual(h.images, [IMAGE, IMAGE]);
  assert.deepEqual(h.switches.map((p) => p.tabId), [2, 1, 3, 1]);
  assert.deepEqual(h.posts.map((p) => p.tabId), [2, 3]);
  assert.equal(h.active(), 1);
});
