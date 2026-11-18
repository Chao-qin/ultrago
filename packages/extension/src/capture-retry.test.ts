import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureWindow, type CaptureWindowsApi } from './capture-retry';

/** A windows API whose focus really moves: focusing a window makes it the last focused one, so reading the
 *  previous focus AFTER focusing the target would see the target itself — the ordering bug this pins. */
function fakeWindows(fails: string[], state = 'normal', chromeInFront = true) {
  const calls: string[] = [];
  let focusedId = 1;
  let chromeFocused = chromeInFront;
  const api: CaptureWindowsApi = {
    capture: async (id) => { calls.push(`capture:${id}`); const failure = fails.shift(); if (failure) throw new Error(failure); return 'data:image/png;base64,AA'; },
    get: async () => ({ state }),
    lastFocused: async () => ({ id: focusedId, focused: chromeFocused }),
    update: async (id, info) => { calls.push(`update:${id}:${JSON.stringify(info)}`); if (info.focused) { focusedId = id; chromeFocused = true; } },
    wait: async () => { calls.push('wait'); },
  };
  return { api, calls };
}

test('a background window that captures normally is never focused', async () => {
  const { api, calls } = fakeWindows([]);
  assert.deepEqual(await captureWindow(api, 2, true), { dataUrl: 'data:image/png;base64,AA', activated: false });
  assert.deepEqual(calls, ['capture:2']);
});

test('a readback failure brings the window forward once and hands focus back', async () => {
  const { api, calls } = fakeWindows(['Failed to capture tab: image readback failed']);
  assert.equal((await captureWindow(api, 2, true)).activated, true);
  assert.deepEqual(calls, ['capture:2', 'update:2:{"focused":true}', 'wait', 'capture:2', 'update:1:{"focused":true}'], '先截图失败、再聚焦重试、最后还原用户窗口');
});

test('when another app was in front, focus cannot be handed back and the result says so', async () => {
  const { api, calls } = fakeWindows(['Failed to capture tab: image readback failed'], 'normal', false);
  const result = await captureWindow(api, 2, true);
  assert.equal(result.keptInFront, true);
  assert.deepEqual(calls, ['capture:2', 'update:2:{"focused":true}', 'wait', 'capture:2'], '不去聚焦另一个 Chrome 窗口');
});

test('a minimized window is restored for the retry and minimized again', async () => {
  const { api, calls } = fakeWindows(['Failed to capture tab: image readback failed'], 'minimized');
  await captureWindow(api, 2, true);
  assert.deepEqual(calls, ['capture:2', 'update:2:{"state":"normal","focused":true}', 'wait', 'capture:2', 'update:2:{"state":"minimized"}', 'update:1:{"focused":true}']);
});

test('other capture errors do not steal focus, and a second failure is reported after restoring focus', async () => {
  const denied = fakeWindows(['Cannot access contents of the page']);
  await assert.rejects(captureWindow(denied.api, 2, true), /Cannot access/);
  assert.deepEqual(denied.calls, ['capture:2']);
  const twice = fakeWindows(['Failed to capture tab: image readback failed', 'Failed to capture tab: image readback failed']);
  await assert.rejects(captureWindow(twice.api, 2, true), /readback/);
  assert.equal(twice.calls.at(-1), 'update:1:{"focused":true}', '重试失败也要把焦点还给用户');
});

test('without the caller allowing it, an unreadable window is never brought forward', async () => {
  const { api, calls } = fakeWindows(['Failed to capture tab: image readback failed']);
  await assert.rejects(captureWindow(api, 2, false), /not brought forward/);
  assert.deepEqual(calls, ['capture:2'], 'webhook / evidence / manual-mode captures leave the screen alone');
});
