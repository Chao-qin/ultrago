import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';

test('returning users resume after their original browser reconnects; first-time users stay in setup', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const startup = source.match(/      const refresh = async \(\) => \{[\s\S]*?if \(resumePending\) void coordinator\.prepare\(\)\.then\(refresh\)\.catch\(reportRestoreFailure\);/);
  assert.ok(startup, 'production startup restoration must be present');
  for (const [completed, failNavigation] of [[false, false], [true, false], [true, true]]) {
    let prepareCalls = 0;
    let entered = 0;
    let connected = false;
    let poll;
    let failure;
    let rejectNavigation = false;
    runInNewContext(`let resumePending = ${completed}; const closing = false; let polling; ${startup[0]}`, {
      coordinator: {
        busy: false, phase: 'ready', prepare: async () => { prepareCalls++; }, refreshBrowsers: async () => {},
        snapshot: () => ({ browserReady: connected }), update: (phase, message) => { failure = { phase, message }; },
      },
      actions: { workbench: async () => { if (rejectNavigation) throw new Error('fixture navigation failed'); entered++; } },
      setInterval: (callback) => { poll = callback; },
    });
    await new Promise((done) => setImmediate(done));
    assert.equal(prepareCalls, completed ? 1 : 0);
    assert.equal(entered, 0, '原浏览器离线时不能进入工作台');
    connected = true;
    rejectNavigation = failNavigation;
    poll();
    await new Promise((done) => setImmediate(done));
    if (failNavigation) assert.deepEqual({ ...failure }, { phase: 'failed', message: '工作台恢复失败：fixture navigation failed' });
    assert.equal(entered, completed && !failNavigation ? 1 : 0);
    assert.equal(failure !== undefined, failNavigation);
    poll();
    await new Promise((done) => setImmediate(done));
    assert.equal(entered, completed && !failNavigation ? 1 : 0, '首次使用、恢复成功或失败后都不应重复跳转');
  }
});

test('repeated quit waits for pending owned-service cleanup and starts it only once', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const registration = source.match(/app\.on\('before-quit', \(event\) => \{[\s\S]*?\n  \}\);/);
  assert.ok(registration, 'production quit handler must be present');
  const app = new EventEmitter();
  let quitCalls = 0;
  let cleanupCalls = 0;
  let finishCleanup;
  const pending = new Promise((done) => { finishCleanup = done; });
  app.quit = () => { quitCalls++; };
  runInNewContext(`let closing = false; let cleanupComplete = false; const polling = undefined; ${registration[0]}`, {
    app, shellControls: undefined, coordinator: { close: () => { cleanupCalls++; return pending; } }, clearInterval,
    process: { stderr: { write: (message) => assert.fail(message) } },
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    let prevented = false;
    app.emit('before-quit', { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, 'every quit must be blocked while cleanup is pending');
  }
  assert.equal(cleanupCalls, 1);
  assert.equal(quitCalls, 0);
  finishCleanup();
  await new Promise((done) => setImmediate(done));
  assert.equal(quitCalls, 1);
  let prevented = false;
  app.emit('before-quit', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false, 'final quit is allowed after cleanup');
});

test('a login launch stays in the tray only with a tray and a completed setup, and a failed restore shows the window', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const startup = source.match(/      if \(launchedAtLogin && !\(tray && resumePending\)\) showWindow\(\);/);
  const failure = source.match(/        if \(hiddenSinceLogin && coordinator\.phase === 'failed'\) showWindow\(\);/);
  assert.ok(startup && failure, 'production login visibility rules must be present');
  for (const [launchedAtLogin, tray, resumePending, shown] of [[true, {}, true, 0], [true, undefined, true, 1], [true, {}, false, 1], [false, {}, true, 0]]) {
    let calls = 0;
    runInNewContext(startup[0], { launchedAtLogin, tray, resumePending, showWindow: () => { calls++; } });
    assert.equal(calls, shown, JSON.stringify({ launchedAtLogin, tray: !!tray, resumePending }));
  }
  for (const [hiddenSinceLogin, phase, shown] of [[true, 'failed', 1], [true, 'starting', 0], [false, 'failed', 0]]) {
    let calls = 0;
    runInNewContext(failure[0], { hiddenSinceLogin, coordinator: { phase }, showWindow: () => { calls++; } });
    assert.equal(calls, shown, JSON.stringify({ hiddenSinceLogin, phase }));
  }
});
