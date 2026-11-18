import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserEvent } from '@bcp/shared';
import { installNavigationInvalidation } from './navigation-events';

test('browser navigation begins invalidation before load completion, including SPA history and fragment changes', () => {
  const emitted: BrowserEvent[] = [];
  type Details = { tabId: number; frameId: number; url: string };
  const listeners: Array<(details: Details) => void> = [];
  const source = { addListener: (listener: (details: Details) => void) => { listeners.push(listener); } };
  installNavigationInvalidation({
    onBeforeNavigate: source,
    onHistoryStateUpdated: source,
    onReferenceFragmentUpdated: source,
  }, (event) => { emitted.push(event); });
  assert.equal(listeners.length, 3);
  for (const listener of listeners) listener({ tabId: 12, frameId: 0, url: 'https://example.test/new' });
  assert.deepEqual(emitted.map((event) => event.kind), ['navigation_started', 'navigation_started', 'navigation_started']);
  assert.ok(emitted.every((event) => event.tabId === 12 && event.detail?.frameId === 0));
  listeners[0]({ tabId: 12, frameId: 7, url: 'https://example.test/frame' });
  assert.equal(emitted[3].detail?.frameId, 7);
});
