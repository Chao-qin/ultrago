import { test, mock } from 'node:test';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createIngress } from '../src/ingress.mjs';
import { acceptReady, cleanEnvironment, selectedBrowser } from '../src/runtime-state.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { fork as forkNode } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator, upgradeBundledDemo } from '../src/coordinator.mjs';
import { createLogRedactor, createTerminalFilter } from '../src/log-redaction.mjs';
import { validateBookV2 } from '../../shared/dist/index.js';
import { PlanRunner } from '../../backend/dist/orchestrator.js';
import { applyParamDefaults, instantiateSteps, validatePlaybookParams } from '../../backend/dist/playbook.js';

test('bundled demo passes the real runner contract before any browser operation', async () => {
  const book = JSON.parse(await readFile(new URL('../templates/desktop-readonly-demo.json', import.meta.url), 'utf8'));
  const definition = validateBookV2(book);
  const params = applyParamDefaults(book.params, { sampleUrl: 'http://127.0.0.1:43210/__desktop/sample' }, { bookName: book.name, runId: 'fixture', planId: 'fixture', uuid: 'fixture' });
  assert.deepEqual(validatePlaybookParams(book.params, params), []);
  const steps = instantiateSteps(book.steps, params);
  const runner = new PlanRunner({ networkBodies: () => ({ bodies: [], maxSeq: 0 }) });
  await assert.rejects(runner.create(book.goal, steps), /no book pages/);
  const plan = await runner.create(book.goal, steps, undefined, undefined, definition.pages);
  assert.equal(plan.total, 2);
  assert.equal(plan.first.action.params.url, params.sampleUrl);
});

test('terminal filtering handles split ANSI sequences and UTF-8 without losing readable logs', () => {
  const bytes = Buffer.from('\u001b[32m工作台\u001b[0m\n\u001b]0;title\u0007ready\u001b[31');
  const filter = createTerminalFilter();
  let output = '';
  for (const byte of bytes) output += filter.write(Buffer.from([byte]));
  output += filter.flush();
  assert.equal(output, '工作台\nready');
});

test('workspace preparation automatically registers the browser bridge before any database job', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'bcp-auto-bridge-'));
  const file = fileURLToPath(new URL('../ui/index.html', import.meta.url));
  let registered = 0;
  const coordinator = new Coordinator({
    paths: { userData, entries: { backend: file, console: file }, schema: file, web: fileURLToPath(new URL('../ui', import.meta.url)), extension: userData },
    registerBridge: async () => { registered++; },
    safeStorage: { decryptString: () => { throw new Error('fixture stop before database'); } },
    fork: () => { throw new Error('must not start any worker'); },
  });
  await writeFile(join(userData, 'manifest.json'), '{}');
  coordinator.settings = { modelMode: 'cloud', cloud: { encryptedKey: 'AA==' } };
  coordinator.ingress = { close: async () => {} };
  coordinator.openIngress = async () => {};
  await coordinator.prepare();
  assert.equal(registered, 1);
  assert.equal(coordinator.snapshot().bridgeReady, true);
  assert.equal(coordinator.supervisor, undefined);
  assert.match(coordinator.snapshot().detail, /fixture stop before database/);
});

test('bridge registration failure is visible and retry restores the real connection state', async () => {
  let attempts = 0;
  const coordinator = new Coordinator({ paths: {}, safeStorage: {}, registerBridge: async () => { if (++attempts === 1) throw new Error('registry denied'); } });
  await coordinator.prepareBridge();
  assert.equal(coordinator.snapshot().bridgeReady, false);
  assert.match(coordinator.snapshot().bridgeError, /registry denied/);
  assert.equal(coordinator.snapshot().bridgeBusy, false);
  await coordinator.prepareBridge();
  assert.equal(coordinator.snapshot().bridgeReady, true);
  assert.equal(coordinator.snapshot().bridgeError, '');
});

test('completed onboarding and floating position survive restart without starting services', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'bcp-onboarding-state-'));
  const paths = { userData, settings: join(userData, 'settings.json'), descriptor: join(userData, 'runtime.json') };
  const first = new Coordinator({ paths, safeStorage: {} });
  await first.load();
  first.browsers = [{ kind: 'chrome', instanceId: 'new-profile', ready: true }];
  first.refreshBrowsers = async () => first.snapshot();
  first.api = async () => ({ ok: true });
  await first.chooseBrowser('new-profile');
  assert.equal(JSON.parse(await readFile(paths.settings, 'utf8')).setupCompleted, false, '仅确认浏览器不会标记已进入工作台');
  await first.completeSetup();
  await first.saveShellPosition({ edge: 'bottom', offset: .7 });
  await first.close();
  const next = new Coordinator({ paths, safeStorage: {} });
  await next.load();
  assert.equal(next.snapshot().setupCompleted, true);
  assert.deepEqual(next.settings.shellPosition, { edge: 'bottom', offset: .7 });
  assert.deepEqual(next.snapshot().services, []);
  await next.close();
  await writeFile(paths.settings, JSON.stringify({ browserId: 'existing-015-profile' }));
  const legacy = new Coordinator({ paths, safeStorage: {} });
  await legacy.load();
  assert.equal(legacy.snapshot().setupCompleted, true, '升级前已确认浏览器的用户继续恢复工作台');
  await legacy.close();
});

test('overlapping position and completion saves retain both fields and recover after a failed save', async () => {
  const coordinator = new Coordinator({ paths: { settings: '/fixture-only/settings.json' }, safeStorage: {} });
  const saved = [];
  let release;
  coordinator.atomic = async (_file, value) => {
    if (saved.length === 0) await new Promise((done) => { release = done; });
    saved.push(value);
  };
  const position = coordinator.saveShellPosition({ edge: 'right', offset: .6 });
  const complete = coordinator.completeSetup();
  await new Promise((done) => setImmediate(done));
  release();
  await Promise.all([position, complete]);
  assert.equal(saved.at(-1).setupCompleted, true);
  assert.deepEqual(saved.at(-1).shellPosition, { edge: 'right', offset: .6 });
  coordinator.atomic = async () => { throw new Error('fixture disk full'); };
  await assert.rejects(coordinator.saveSettings(), /disk full/);
  coordinator.atomic = async (_file, value) => { saved.push(value); };
  await coordinator.saveShellPosition({ edge: 'top', offset: .2 });
  assert.equal(saved.at(-1).setupCompleted, true);
  assert.deepEqual(saved.at(-1).shellPosition, { edge: 'top', offset: .2 });
});

test('successful assistant reconnect supersedes the same assistant’s historical failure', () => {
  const coordinator = new Coordinator({ paths: {}, safeStorage: {} });
  coordinator.agentConnections.update({ id: 'old', name: 'Workbuddy', state: 'error', error: 'previous connection failed' });
  coordinator.agentConnections.update({ id: 'new', name: 'Workbuddy', state: 'connected', toolCount: 12 });
  assert.equal(coordinator.connectionStatus().lastError, '');
  assert.equal(coordinator.connectionStatus().assistants.filter((entry) => entry.state === 'connected').length, 1);
});

test('a launch failure from before this run is not reported as the current assistant state', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'bcp-launch-error-'));
  await mkdir(join(userData, 'logs'));
  const log = join(userData, 'logs/mcp-last-error.log');
  // Written by a bridge of an earlier version while the client was closed, long before this run.
  await writeFile(log, `${new Date(Date.now() - 86_400_000).toISOString()} MCP 启动失败：fetch failed\n`);
  const coordinator = new Coordinator({ paths: { userData }, safeStorage: {} });
  await coordinator.refreshBrowsers();
  assert.equal(coordinator.connectionStatus().lastError, '', '升级或重启前留下的失败不算当前状态');
  await writeFile(log, `${new Date(Date.now() + 1000).toISOString()} MCP 启动失败：桌面客户端暂不可用（fetch failed）\n`);
  await coordinator.refreshBrowsers();
  assert.match(coordinator.connectionStatus().lastError, /桌面客户端暂不可用/, '这一轮里助手启动失败照常显示');
  coordinator.lastMcpSuccess = Date.now() + 2000;
  assert.equal(coordinator.connectionStatus().lastError, '', '之后连上就不再显示');
});

test('demo upgrade repairs the shipped template and preserves user edits', async () => {
  const source = new URL('../templates/desktop-readonly-demo.json', import.meta.url);
  const destination = join(await mkdtemp(join(tmpdir(), 'bcp-demo-upgrade-')), 'demo.json');
  const previous = {
    name: 'desktop-readonly-demo', goal: '打开本地虚构商品示例页并读取清单，不提交或修改任何店铺数据。',
    params: [{ name: 'sampleUrl', required: false, default: 'desktop://sample', description: '客户端自动提供的示例页，无需修改。', schema: { type: 'string' } }],
    steps: [
      { goal: '打开本地商品示例页', page: 'desktop-demo', action: { method: 'browser.newWindow', params: { url: '{{sampleUrl}}', focused: true, minimized: false } }, verify: { settled: true, noErrors: true }, onFail: 'escalate' },
      { goal: '读取商品清单并展示结果', page: 'desktop-demo', action: { method: 'browser.readContent', params: { maxChars: 10000 } }, verify: { noErrors: true }, onFail: 'escalate' },
    ],
  };
  await writeFile(destination, JSON.stringify(previous));
  await upgradeBundledDemo(source, destination);
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), JSON.parse(await readFile(source, 'utf8')));
  previous.goal = '用户自定义目标';
  await writeFile(destination, JSON.stringify(previous));
  await upgradeBundledDemo(source, destination);
  assert.equal(JSON.parse(await readFile(destination, 'utf8')).goal, '用户自定义目标');
  await writeFile(destination, '{用户尚未编辑完成');
  assert.equal(await upgradeBundledDemo(source, destination), false);
  assert.equal(await readFile(destination, 'utf8'), '{用户尚未编辑完成');
});

test('local API failures preserve server diagnostics and redact local credentials', async (t) => {
  const coordinator = new Coordinator({ paths: {}, safeStorage: {} });
  const server = createServer((_req, res) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `fixture contract invalid ${coordinator.token}` })); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  coordinator.ingress = { origin: `http://127.0.0.1:${server.address().port}` };
  t.after(() => { server.closeAllConnections(); server.close(); });
  await assert.rejects(coordinator.api('/fixture'), (error) => {
    assert.match(error.message, /400，\/fixture.*fixture contract invalid \[hidden\]/);
    assert.doesNotMatch(error.message, new RegExp(coordinator.token));
    return true;
  });
});

test('ready messages require current generation and actual loopback ports', () => {
  const message = { type: 'ready', version: 1, service: 'backend', generation: 'current', endpoints: { ws: 'ws://127.0.0.1:43210', mcp: 'http://127.0.0.1:43211', internal: 'http://127.0.0.1:43212' } };
  assert.deepEqual(acceptReady(message, 'backend', 'current'), message.endpoints);
  for (const change of [{ generation: 'old' }, { service: 'console' }, { endpoints: { ...message.endpoints, ws: 'ws://example.com:43210' } }, { endpoints: { ...message.endpoints, internal: 'http://127.0.0.1:0' } }]) {
    assert.equal(acceptReady({ ...message, ...change }, 'backend', 'current'), null);
  }
});

test('developer credentials and configuration are not inherited by workers', () => {
  assert.deepEqual(cleanEnvironment({ PATH: '/bin', SystemRoot: 'C:\\Windows', BCP_TOKEN: 'developer', DATABASE_URL: 'file:production.db', AIHUB_API_KEY: 'secret', NODE_OPTIONS: '--require bad.js' }), { PATH: '/bin', SystemRoot: 'C:\\Windows' });
});

test('an offline selected profile does not select another ready profile', () => {
  const browsers = [{ kind: 'chrome', instanceId: 'first', ready: false }, { kind: 'chrome', instanceId: 'second', ready: true }];
  assert.equal(selectedBrowser(browsers, 'first'), null);
  assert.equal(selectedBrowser(browsers, undefined), null);
  assert.equal(selectedBrowser(browsers, 'second'), browsers[1]);
});

test('dynamic ingress protects discovery, rewrites targets and invalidates unavailable services', async (t) => {
  let received;
  const upstream = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received = { path: req.url, host: req.headers.host, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() };
      res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}');
    });
  });
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${upstream.address().port}`;
  let available = true;
  let browser = { kind: 'chrome', instanceId: 'chosen' };
  const ingress = await createIngress({ token: 'current-token', nativeToken: 'native-token', resolve: () => available ? endpoint : null, discover: () => ({ generation: 'current' }), target: () => browser, sample: '<h1>sample</h1>' });
  t.after(async () => { await ingress.close(); upstream.closeAllConnections(); await new Promise((done) => upstream.close(done)); });
  assert.notEqual(ingress.origin, endpoint);
  assert.equal((await fetch(ingress.origin)).status, 401);
  assert.equal((await fetch(`${ingress.origin}/__desktop/discover`)).status, 401);
  assert.equal((await fetch(ingress.origin, { headers: { Authorization: 'Bearer current-token', Origin: 'https://foreign.example' } })).status, 403);
  assert.deepEqual(await (await fetch(`${ingress.origin}/__desktop/discover`, { headers: { Authorization: 'Bearer native-token' } })).json(), { generation: 'current' });
  const headers = { Authorization: 'Bearer current-token', 'Content-Type': 'application/json' };
  const result = await fetch(`${ingress.origin}/__bcp/backend/internal/run`, { method: 'POST', headers, body: JSON.stringify({ name: 'demo', target: { instanceId: 'wrong-profile' } }) });
  assert.equal(result.status, 200);
  assert.equal(received.path, '/internal/run');
  assert.equal(received.host, new URL(endpoint).host);
  assert.equal(received.authorization, 'Bearer current-token');
  assert.deepEqual(JSON.parse(received.body).target, browser);
  for (const path of ['/api/settings/env', '/API/SETTINGS/env', '/api/Settings/scripts']) {
    assert.equal((await fetch(`${ingress.origin}${path}`, { headers })).status, 409, path);
    assert.equal(received.path, '/internal/run', 'blocked settings paths must not reach upstream');
  }
  for (const path of ['/api/llm/admin/channels', '/API/LLM/ADMIN/channels', '/__bcp/llm/admin/channels', '/__bcp/llm/ADMIN/channels']) {
    assert.equal((await fetch(`${ingress.origin}${path}`, { method: 'POST', headers, body: '{}' })).status, 409, path);
    assert.equal(received.path, '/internal/run', 'blocked model writes must not reach upstream');
  }
  browser = null;
  assert.equal((await fetch(`${ingress.origin}/__bcp/backend/internal/run`, { method: 'POST', headers, body: '{}' })).status, 409);
  available = false;
  assert.equal((await fetch(ingress.origin, { headers })).status, 503);
  assert.equal((await fetch(`${ingress.origin}/api/settings/env`, { headers })).status, 409);
});

test('proxy cannot change the upstream origin through a network-path reference', async (t) => {
  let escaped = false;
  const trap = createServer((_req, res) => { escaped = true; res.end('escaped'); });
  await new Promise((done) => trap.listen(0, '127.0.0.1', done));
  const ingress = await createIngress({ token: 'current', nativeToken: 'native', resolve: () => `http://127.0.0.1:${trap.address().port}`, discover: () => ({}), sample: '' });
  t.after(async () => { await ingress.close(); trap.closeAllConnections(); await new Promise((done) => trap.close(done)); });
  const response = await fetch(`${ingress.origin}/__bcp/backend//127.0.0.1:${trap.address().port}/steal`, { headers: { Authorization: 'Bearer current' } });
  assert.equal(response.status, 400);
  assert.equal(escaped, false);
});

test('CLI jobs use their real CommonJS main entry and preserve command arguments', async () => {
  const supervisor = new Supervisor({
    fork: () => { throw new Error('CLI must not use utility import worker'); },
    forkJob: (entry, args, options) => forkNode(entry, args, { ...options, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }),
    worker: '/unused', env: {}, cwd: process.cwd(), generation: 'current', timeout: 2000,
  });
  let output = '';
  supervisor.on('log', (entry) => { output += entry.text; });
  try {
    await supervisor.start('migrate', fileURLToPath(new URL('./fixtures/cli-main.cjs', import.meta.url)), { BCP_DESKTOP_SCHEMA: 'fixture-only' }, true);
    assert.match(output, /"migrate","deploy","--schema","fixture-only"/);
  } finally { await supervisor.close(); }
});

test('job heartbeat guard allows a completed CLI to exit naturally', async () => {
  const child = forkNode(fileURLToPath(new URL('./fixtures/cli-main.cjs', import.meta.url)), [], {
    execArgv: ['--require', fileURLToPath(new URL('../src/job-guard.cjs', import.meta.url))],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let timer;
  try {
    const code = await Promise.race([
      new Promise((done, fail) => { child.once('exit', done); child.once('error', fail); }),
      new Promise((_done, fail) => { timer = setTimeout(() => fail(new Error('completed CLI kept alive by IPC')), 1500); }),
    ]);
    assert.equal(code, 0);
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
});

test('failed worker reports its recent output while redacting credentials', async () => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { queueMicrotask(() => child.emit('exit', 1)); return true; };
  const supervisor = new Supervisor({ fork: () => child, worker: '/unused', env: { API_KEY: 'private-key-value' }, generation: 'now', timeout: 1000 });
  supervisor.on('failure', () => {});
  try {
    const starting = supervisor.start('console', '/unused');
    child.stderr.emit('data', Buffer.from('engine failed: private-key-'));
    child.stderr.emit('data', Buffer.from('value'));
    child.emit('exit', 1);
    await assert.rejects(starting, (error) => {
      assert.match(error.message, /工作台服务已退出/);
      assert.match(error.message, /engine failed: \[hidden\]/);
      assert.doesNotMatch(error.message, /private-key-value/);
      return true;
    });
  } finally { await supervisor.close(); }
});

test('log redaction handles split, overlapping and incomplete credentials before truncation', () => {
  for (const chunks of [['private-key-', 'value'], ['private-', 'key-', 'value'], ['x'.repeat(8191) + 'private-key-', 'value'], ['abcab']]) {
    const redactor = createLogRedactor(['private-key-value', 'abcab']);
    const result = chunks.map((chunk) => redactor.write(chunk)).join('') + redactor.flush();
    assert.doesNotMatch(result, /private-key-value|abcab/);
    assert.match(result, /\[hidden\]/);
  }
  const redactor = createLogRedactor(['private-key-value']);
  assert.equal(redactor.write('private-key-'), '');
  assert.equal(redactor.flush(), '[hidden]');
});

test('diagnostics survive restart and retain only the bounded recent history', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'bcp-diagnostics-'));
  const paths = { userData, settings: join(userData, 'settings.json'), descriptor: join(userData, 'runtime.json') };
  const coordinator = new Coordinator({ paths, fork: () => {}, safeStorage: {} });
  await coordinator.load();
  try {
    for (let i = 0; i < 70; i++) coordinator.recordLog({ service: 'migrate', text: `fixture-line-${i}` });
    coordinator.update('failed', 'fixture initialization failed');
    assert.equal(coordinator.snapshot().logs.length, 60);
    assert.ok(coordinator.snapshot().phaseStartedAt > 0);
  } finally { await coordinator.close(); }
  const content = await readFile(join(userData, 'logs/desktop.log'), 'utf8');
  assert.match(content, /fixture initialization failed/);
  assert.doesNotMatch(content, /fixture-line-0\n/);
  const reopened = new Coordinator({ paths, fork: () => {}, safeStorage: {} });
  await reopened.load();
  await reopened.close();
  assert.equal(await readFile(join(userData, 'logs/desktop.previous.log'), 'utf8'), content);
});

test('supervisor rejects stale readiness and removes exited worker endpoints', async () => {
  const children = [];
  const fork = () => {
    const child = new EventEmitter();
    child.postMessage = () => {};
    child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true; };
    children.push(child); return child;
  };
  const supervisor = new Supervisor({ fork, worker: '/unused', cwd: '/unused', env: {}, generation: 'now', timeout: 1000 });
  let failure;
  const logs = [];
  supervisor.on('failure', (message) => { failure = message; });
  supervisor.on('log', (entry) => logs.push(entry.text));
  const starting = supervisor.start('console', '/unused');
  children[0].emit('message', { type: 'ready', version: 1, generation: 'before', service: 'console', endpoints: { console: 'http://127.0.0.1:41234' } });
  assert.equal(supervisor.endpoints.console, undefined);
  children[0].emit('message', { type: 'ready', version: 1, generation: 'now', service: 'console', endpoints: { console: 'http://127.0.0.1:41234' } });
  await starting;
  assert.ok(supervisor.endpoints.console);
  children[0].emit('exit', 1);
  assert.equal(supervisor.endpoints.console, undefined);
  assert.equal(failure, undefined, '就绪后意外退出先自动重启，不直接判整组失败');
  assert.match(logs.at(-1), /工作台服务意外退出.*正在自动重启/);
  await supervisor.close();
});

test('supervisor requests graceful shutdown before terminating an owned service', async () => {
  const child = new EventEmitter();
  let killed = false;
  const messages = [];
  child.postMessage = (message) => { messages.push(message); if (message.type === 'shutdown') queueMicrotask(() => child.emit('exit', 0)); };
  child.kill = () => { killed = true; };
  const supervisor = new Supervisor({ fork: () => child, worker: '/unused', env: {}, generation: 'now' });
  const starting = supervisor.start('console', '/unused');
  child.emit('message', { type: 'ready', version: 1, generation: 'now', service: 'console', endpoints: { console: 'http://127.0.0.1:41234' } });
  await starting;
  await supervisor.close();
  assert.deepEqual(messages, [{ type: 'shutdown' }]);
  assert.equal(killed, false);
  assert.equal(supervisor.children.size, 0);
});

test('Windows shutdown fallback terminates the owned console tree and reports failure', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const builtin = createRequire(import.meta.url)('node:child_process');
  const requests = [];
  let status = 0;
  const launch = mock.method(builtin, 'spawnSync', (...args) => { requests.push(args); return { status, stderr: 'fixture cleanup denied' }; });
  Object.defineProperty(process, 'platform', { value: 'win32' });
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (status of [0, 1]) {
      const child = new EventEmitter();
      child.pid = 123456;
      child.postMessage = () => {};
      child.kill = () => { assert.fail('must terminate the owned tree rather than only the service'); };
      const supervisor = new Supervisor({ env: {} });
      supervisor.children.set('console', child);
      const closing = supervisor.close();
      const checked = status === 0 ? assert.doesNotReject(closing) : assert.rejects(closing, /fixture cleanup denied/);
      t.mock.timers.tick(5000);
      await checked;
    }
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0][1], ['/PID', '123456', '/T', '/F']);
    assert.ok(requests[0][0].endsWith('taskkill.exe'));
  } finally {
    t.mock.timers.reset();
    Object.defineProperty(process, 'platform', platform);
    launch.mock.restore();
    syncBuiltinESMExports();
  }
});

test('supervisor timeout kills only its owned worker', async () => {
  let killed = 0;
  const child = new EventEmitter();
  child.postMessage = () => {};
  child.kill = () => { killed++; queueMicrotask(() => child.emit('exit', 1)); return true; };
  const supervisor = new Supervisor({ fork: () => child, worker: '/unused', cwd: '/unused', env: {}, generation: 'now', timeout: 15 });
  supervisor.on('failure', () => {});
  await assert.rejects(supervisor.start('backend', '/unused'), /启动超时/);
  assert.equal(killed, 1);
  await supervisor.close();
});
