import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentCliSteps, agentLink, agentSetup, checkMcp, checkMcpStdio, claudeConfigFile, connectAgent, decodeOutput, detectAgents, findExecutable, installAgentConfig, runAgentCli } from '../src/agent-setup.mjs';
import { requestNotDelivered, watchResponses } from '../src/mcp-bridge.mjs';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { createIngress } from '../src/ingress.mjs';
import { startMcpHttpServer } from '../../backend/dist/mcp-http.js';
import { EventStore } from '../../backend/dist/event-store.js';
import { lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createAgentConnections } from '../src/agent-connections.mjs';
import { spawn } from 'node:child_process';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(condition, label) {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await new Promise((done) => setTimeout(done, 10));
  assert.ok(condition(), label);
}
import { createServer } from 'node:http';

test('agent config preserves spaced executable paths without ports or credentials', () => {
  const executable = 'C:\\Program Files\\UltraGo Internal\\UltraGo Internal.exe';
  for (const client of ['generic', 'claude', 'cursor']) {
    const result = agentSetup(client, executable, ['--mcp-stdio']);
    assert.deepEqual(JSON.parse(result.config), { mcpServers: { 'ultrago': { command: executable, args: ['--mcp-stdio'] } } });
    assert.ok(result.steps.length >= 3);
    assert.equal(new URL(result.docs).protocol, 'https:');
  }
  const opencode = JSON.parse(agentSetup('opencode', executable, ['--mcp-stdio']).config);
  assert.deepEqual(opencode, { mcp: { servers: { 'ultrago': { type: 'local', command: [executable, '--mcp-stdio'] } } } });
  // 1.x keeps servers directly under mcp; up to 1.18 a config with mcp.servers is rejected as a whole.
  const opencode1 = JSON.parse(agentSetup('opencode1', executable, ['--mcp-stdio']).config);
  assert.deepEqual(opencode1, { mcp: { 'ultrago': { type: 'local', command: [executable, '--mcp-stdio'] } } });
  assert.throws(() => agentSetup('../../unknown', executable, []), /助手类型/);
});

test('MCP connection check performs a real handshake and lists tools without invoking any', async () => {
  const previous = { desktop: process.env.BCP_DESKTOP, token: process.env.BCP_DESKTOP_TOKEN };
  process.env.BCP_DESKTOP = '1';
  process.env.BCP_DESKTOP_TOKEN = 'isolated-check-token';
  let calls = 0;
  const server = await startMcpHttpServer(async () => { calls++; throw new Error('No browser actions allowed in a connection check'); }, 0, new EventStore());
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const ingress = await createIngress({ token: 'isolated-check-token', nativeToken: 'native-check-token', resolve: () => endpoint, discover: () => ({}), sample: '' });
  try {
    const result = await checkMcp(ingress.origin, 'isolated-check-token');
    assert.ok(result.toolCount > 0);
    assert.equal(calls, 0);
    await assert.rejects(checkMcp(ingress.origin, 'invalid-token'));
  } finally {
    await ingress.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    for (const [key, value] of Object.entries({ BCP_DESKTOP: previous.desktop, BCP_DESKTOP_TOKEN: previous.token })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('actual stdio launcher handshakes, lists tools, reports external client status and separates self-checks', async () => {
  const server = await startMcpHttpServer(async () => { throw new Error('no browser actions permitted'); }, 0, new EventStore());
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const tracker = createAgentConnections();
  const ingress = await createIngress({ token: 'stdio-test-token', nativeToken: 'stdio-native-token', resolve: () => endpoint, discover: () => ({}), sample: '', agentEvent: (event) => tracker.update(event), status: () => ({ assistants: tracker.snapshot() }) });
  const directory = await mkdtemp(join(tmpdir(), 'bcp-stdio-'));
  const descriptor = join(directory, 'runtime.json');
  await writeFile(descriptor, JSON.stringify({ version: 1, origin: ingress.origin, token: 'stdio-native-token' }));
  const launch = { command: process.execPath, args: [fileURLToPath(new URL('../src/mcp-entry.cjs', import.meta.url)), descriptor] };
  const client = new Client({ name: 'Workbuddy fixture', version: 'test' });
  try {
    await client.connect(new StdioClientTransport(launch), { timeout: 10000 });
    const tools = await client.listTools();
    assert.ok(tools.tools.length > 0);
    await new Promise((done) => setTimeout(done, 100));
    assert.ok(tracker.snapshot().some((entry) => entry.name === 'Workbuddy fixture' && entry.state === 'connected' && entry.toolCount === tools.tools.length));
    const checked = await checkMcpStdio(launch);
    assert.equal(checked.transport, 'stdio');
    assert.ok(checked.toolCount > 0);
    assert.equal(tracker.snapshot().filter((entry) => entry.state === 'connected').length, 1, '自检不能冒充另一个助手已连接');
    assert.equal((await fetch(`${ingress.origin}/__desktop/status`)).status, 401);
    const visible = await (await fetch(`${ingress.origin}/__desktop/status`, { headers: { Authorization: 'Bearer stdio-test-token' } })).json();
    assert.ok(visible.assistants.some((entry) => entry.name === 'Workbuddy fixture'));
    await assert.rejects(checkMcpStdio({ ...launch, args: [launch.args[0], join(directory, 'missing-runtime.json')] }), /ENOENT|启动失败/);
    const child = spawn(launch.command, launch.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const exited = new Promise((done) => child.once('exit', (code) => done(code)));
    const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    try {
      send({ id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'EOF fixture', version: 'test' } } });
      const deadline = Date.now() + 5000;
      while (!output.includes('"id":1') && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
      assert.match(output, /"id":1/);
      send({ method: 'notifications/initialized' });
      send({ id: 2, method: 'tools/list', params: {} });
      while (!output.includes('"id":2') && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
      assert.match(output, /"id":2/);
      child.stdin.end();
      const code = await Promise.race([exited, new Promise((_done, fail) => { const timer = setTimeout(() => fail(new Error('stdin EOF did not stop child')), 4500); timer.unref(); })]);
      assert.equal(code, 0, stderr);
      assert.ok(tracker.snapshot().some((entry) => entry.name === 'EOF fixture' && entry.state === 'disconnected'), 'EOF 后停止心跳且显示断开');
    } finally { if (child.exitCode === null) child.kill(); }
  } finally {
    await client.close();
    await ingress.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

test('stdio bridge relays tool progress and cancellation to the HTTP server', async () => {
  const remote = new Server({ name: 'progress-fixture', version: 'test' }, { capabilities: { tools: {} } });
  let cancelled;
  const cancellation = new Promise((done) => { cancelled = done; });
  let progressReceived = false;
  remote.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: extra._meta.progressToken, progress: 1, total: 2, message: 'fixture progress' } });
    if (request.params.arguments?.waitForAbort) {
      await new Promise((done) => {
        if (extra.signal.aborted) { cancelled(); done(); }
        else extra.signal.addEventListener('abort', () => { cancelled(); done(); }, { once: true });
      });
    } else {
      await until(() => progressReceived, 'tool progress reaches the stdio client');
    }
    return { content: [{ type: 'text', text: 'fixture complete' }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'progress-session' });
  await remote.connect(transport);
  const http = createServer((request, response) => {
    void transport.handleRequest(request, response).catch((error) => { response.destroy(error); });
  });
  await new Promise((done) => http.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${http.address().port}`;
  const ingress = await createIngress({ token: 'progress-token', nativeToken: 'progress-native-token', resolve: () => endpoint, discover: () => ({}), sample: '' });
  const directory = await mkdtemp(join(tmpdir(), 'bcp-bridge-progress-'));
  const descriptor = join(directory, 'runtime.json');
  await writeFile(descriptor, JSON.stringify({ version: 1, origin: ingress.origin, token: 'progress-native-token' }));
  const client = new Client({ name: 'progress fixture', version: 'test' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp-entry.cjs', import.meta.url)), descriptor] }), { timeout: 10000 });
    const progress = [];
    const result = await client.callTool({ name: 'fixture' }, undefined, {
      onprogress: (value) => {
        progress.push(value);
        progressReceived = true;
      },
      timeout: 10000,
    });
    assert.equal(result.content[0].text, 'fixture complete');
    assert.deepEqual(progress, [{ progress: 1, total: 2, message: 'fixture progress' }]);
    const abort = new AbortController();
    await assert.rejects(client.callTool({ name: 'fixture', arguments: { waitForAbort: true } }, undefined, { signal: abort.signal, onprogress: () => abort.abort(new Error('fixture cancelled')), timeout: 1000 }), /fixture cancelled/);
    await Promise.race([cancellation, new Promise((_done, fail) => { const timer = setTimeout(() => fail(new Error('upstream tool was not cancelled')), 1500); timer.unref(); })]);
  } finally {
    await client.close();
    await ingress.close();
    await remote.close();
    http.closeAllConnections();
    await new Promise((done) => http.close(done));
  }
});

test('assistant status expires after missing heartbeats and keeps errors separate from browser state', () => {
  let now = 1000;
  const tracker = createAgentConnections(() => now);
  tracker.update({ id: 'fixture', name: 'Workbuddy', state: 'connected', toolCount: 5 });
  assert.equal(tracker.snapshot()[0].state, 'connected');
  now += 36000;
  assert.equal(tracker.snapshot()[0].state, 'disconnected');
  tracker.update({ id: 'fixture', name: 'Workbuddy', state: 'error', error: 'stdio closed' });
  assert.equal(tracker.snapshot()[0].error, 'stdio closed');
  tracker.update({ id: 'check', name: 'ultrago-connection-check', state: 'connected' });
  assert.equal(tracker.snapshot().length, 1);
});

async function countingServer(label) {
  const calls = [];
  const remote = new Server({ name: label, version: 'test' }, { capabilities: { tools: {} } });
  remote.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'fixture', inputSchema: { type: 'object' } }] }));
  remote.setRequestHandler(CallToolRequestSchema, async () => { calls.push(label); return { content: [{ type: 'text', text: label }] }; });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await remote.connect(transport);
  const http = createServer((request, response) => { void transport.handleRequest(request, response).catch((error) => { response.destroy(error); }); });
  await new Promise((done) => http.listen(0, '127.0.0.1', done));
  return { calls, endpoint: `http://127.0.0.1:${http.address().port}`, close: async () => { await remote.close(); http.closeAllConnections(); await new Promise((done) => http.close(done)); } };
}

test('stdio bridge follows a restarted desktop client without replaying a tool call into a fresh session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bcp-bridge-reconnect-'));
  const descriptor = join(directory, 'runtime.json');
  const tracker = createAgentConnections();
  const first = await countingServer('first');
  const firstIngress = await createIngress({ token: 'first-token', nativeToken: 'first-native', resolve: () => first.endpoint, discover: () => ({}), sample: '' });
  await writeFile(descriptor, JSON.stringify({ version: 1, origin: firstIngress.origin, token: 'first-native', generation: 'first' }));
  const client = new Client({ name: 'reconnect fixture', version: 'test' });
  let second;
  let secondIngress;
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp-entry.cjs', import.meta.url)), descriptor] }), { timeout: 10000 });
    assert.equal((await client.callTool({ name: 'fixture' })).content[0].text, 'first');
    await firstIngress.close();
    await first.close();
    second = await countingServer('second');
    secondIngress = await createIngress({ token: 'second-token', nativeToken: 'second-native', resolve: () => second.endpoint, discover: () => ({}), sample: '', agentEvent: (event) => tracker.update(event) });
    await writeFile(descriptor, JSON.stringify({ version: 1, origin: secondIngress.origin, token: 'second-native', generation: 'second' }));
    await assert.rejects(client.callTool({ name: 'fixture' }, undefined, { timeout: 15000 }), /浏览器会话已重置.*没有执行/, '新会话丢失了目标浏览器和标签认领，不能静默重放');
    assert.deepEqual(second.calls, []);
    await pause(1600);
    assert.equal((await client.callTool({ name: 'fixture' })).content[0].text, 'second', '客户端重启后无需在助手里重连');
    assert.deepEqual([...first.calls, ...second.calls], ['first', 'second'], '每次调用只执行一次');
    await secondIngress.close();
    await second.close();
    // The first call starts a reconnect; the second arrives while it is still waiting for the restarted client.
    const leading = client.callTool({ name: 'fixture' }, undefined, { timeout: 15000 });
    await pause(400);
    const trailing = client.callTool({ name: 'fixture' }, undefined, { timeout: 15000 });
    await pause(400);
    second = await countingServer('third');
    secondIngress = await createIngress({ token: 'third-token', nativeToken: 'third-native', resolve: () => second.endpoint, discover: () => ({}), sample: '' });
    await writeFile(descriptor, JSON.stringify({ version: 1, origin: secondIngress.origin, token: 'third-native', generation: 'third' }));
    const concurrent = await Promise.allSettled([leading, trailing]);
    assert.deepEqual(concurrent.map((result) => result.status), ['rejected', 'rejected'], '重置报告送达前到达的调用都要先告知会话已重置');
    assert.match(concurrent[1].reason.message, /浏览器会话已重置/);
    const batch = await Promise.allSettled([0, 1].map(() => client.callTool({ name: 'fixture' })));
    assert.deepEqual(batch.map((result) => result.status), ['rejected', 'rejected'], '紧随重置报告的同批并行调用同样拒绝');
    assert.deepEqual(second.calls, []);
    await pause(1600);
    assert.equal((await client.callTool({ name: 'fixture' })).content[0].text, 'third');
    assert.deepEqual(second.calls, ['third']);
    assert.equal((await client.listTools()).tools.length, 1);
    await until(() => tracker.snapshot().some((entry) => entry.name === 'reconnect fixture' && entry.state === 'connected'), '新客户端看到助手已连接');
  } finally {
    await client.close();
    await secondIngress?.close();
    await second?.close();
  }
});

test('stdio bridge re-initializes when only the backend restarted behind the same desktop ingress', async () => {
  const previous = { desktop: process.env.BCP_DESKTOP, token: process.env.BCP_DESKTOP_TOKEN };
  process.env.BCP_DESKTOP = '1';
  process.env.BCP_DESKTOP_TOKEN = 'backend-restart-token';
  const servers = [await startMcpHttpServer(async () => { throw new Error('no browser actions permitted'); }, 0, new EventStore())];
  const endpoint = () => `http://127.0.0.1:${servers.at(-1).address().port}`;
  const ingress = await createIngress({ token: 'backend-restart-token', nativeToken: 'backend-restart-native', resolve: () => endpoint(), discover: () => ({}), sample: '' });
  const directory = await mkdtemp(join(tmpdir(), 'bcp-bridge-backend-'));
  const descriptor = join(directory, 'runtime.json');
  await writeFile(descriptor, JSON.stringify({ version: 1, origin: ingress.origin, token: 'backend-restart-native', generation: 'same' }));
  const client = new Client({ name: 'backend restart fixture', version: 'test' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp-entry.cjs', import.meta.url)), descriptor] }), { timeout: 10000 });
    const count = (await client.listTools()).tools.length;
    servers[0].closeAllConnections();
    await new Promise((done) => servers[0].close(done));
    servers.push(await startMcpHttpServer(async () => { throw new Error('no browser actions permitted'); }, 0, new EventStore()));
    assert.equal((await client.listTools({}, { timeout: 15000 })).tools.length, count, '旧会话 404 后自动重新握手');
  } finally {
    await client.close();
    await ingress.close();
    for (const server of servers.slice(1)) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
    for (const [key, value] of Object.entries({ BCP_DESKTOP: previous.desktop, BCP_DESKTOP_TOKEN: previous.token })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('only requests that provably never reached a session are retried', () => {
  assert.equal(requestNotDelivered(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), true);
  for (const code of [401, 404, 503]) assert.equal(requestNotDelivered(new StreamableHTTPError(code, 'fixture')), true, String(code));
  for (const code of [400, 500, 502, 504]) assert.equal(requestNotDelivered(new StreamableHTTPError(code, 'fixture')), false, String(code));
  assert.equal(requestNotDelivered(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), false, '中途断开可能已执行');
  assert.equal(requestNotDelivered(new DOMException('aborted', 'AbortError')), false);
  assert.equal(requestNotDelivered(new Error('Request timed out')), false);
});

test('assistant config is merged with a backup, kept when already current and never overwritten when unreadable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bcp-agent-config-'));
  const executable = 'C:\\Program Files\\UltraGo Internal\\resources\\native\\bcp-native-host.exe';
  assert.equal(claudeConfigFile('C:\\Users\\卖家\\AppData\\Roaming'), join('C:\\Users\\卖家\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));

  const file = join(directory, 'Claude', 'claude_desktop_config.json');
  const created = await installAgentConfig(file, executable, ['--mcp-stdio'], new Date('2026-11-09T01:02:03.004Z'));
  assert.deepEqual({ ...created, file: undefined }, { file: undefined, backup: '', unchanged: false });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { mcpServers: { 'ultrago': { command: executable, args: ['--mcp-stdio'] } } });

  const original = `\uFEFF${JSON.stringify({ globalShortcut: 'Ctrl+Space', mcpServers: { filesystem: { command: 'npx', args: ['-y', 'fs'] }, 'ultrago': { command: 'old.exe', args: [] } } })}`;
  await writeFile(file, original);
  const merged = await installAgentConfig(file, executable, ['--mcp-stdio'], new Date('2026-11-09T01:02:03.004Z'));
  assert.equal(merged.backup, `${file}.bak-2026-11-09T01-02-03-004Z`);
  assert.equal(await readFile(merged.backup, 'utf8'), original, '备份保留原文件逐字节内容');
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(written.globalShortcut, 'Ctrl+Space');
  assert.deepEqual(written.mcpServers.filesystem, { command: 'npx', args: ['-y', 'fs'] });
  assert.deepEqual(written.mcpServers['ultrago'], { command: executable, args: ['--mcp-stdio'] });
  assert.equal((await installAgentConfig(file, executable, ['--mcp-stdio'])).unchanged, true);

  const real = join(directory, 'dotfiles', 'mcp.json');
  await mkdir(join(directory, 'dotfiles'));
  await writeFile(real, JSON.stringify({ mcpServers: { other: { command: 'other' } } }));
  const linked = join(directory, '.cursor', 'mcp.json');
  await mkdir(join(directory, '.cursor'));
  await symlink(real, linked);
  const throughLink = await installAgentConfig(linked, executable, ['--mcp-stdio']);
  assert.equal(throughLink.file, real);
  assert.ok((await lstat(linked)).isSymbolicLink(), '符号链接保持不变');
  assert.deepEqual(Object.keys(JSON.parse(await readFile(linked, 'utf8')).mcpServers), ['other', 'ultrago'], '更新链接指向的真实文件');
  assert.deepEqual((await readdir(join(directory, 'dotfiles'))).filter((name) => name.endsWith('.tmp')), [], '不留临时文件');

  for (const content of ['{"mcpServers": {', '[]', '{"mcpServers": []}']) {
    await writeFile(file, content);
    await assert.rejects(installAgentConfig(file, executable, ['--mcp-stdio']), /未做修改/);
    assert.equal(await readFile(file, 'utf8'), content, '无法识别的配置保持原样');
  }
});

test('a tool call cut off mid-way fails promptly, is never replayed, and the next call reports the reset session', async () => {
  const calls = [];
  const remote = new Server({ name: 'dying', version: 'test' }, { capabilities: { tools: {} } });
  let http;
  remote.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
    calls.push('dying');
    if (calls.length === 1) return { content: [{ type: 'text', text: 'claimed' }] };
    // Progress opens the streamed reply first; the service then dies with a reset, as a killed process does.
    await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: extra._meta.progressToken, progress: 1, total: 2 } });
    setTimeout(() => { for (const socket of sockets) socket.resetAndDestroy(); }, 50);
    return new Promise(() => {});
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await remote.connect(transport);
  http = createServer((request, response) => { void transport.handleRequest(request, response).catch((error) => { response.destroy(error); }); });
  const sockets = new Set();
  http.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((done) => http.listen(0, '127.0.0.1', done));
  let endpoint = `http://127.0.0.1:${http.address().port}`;
  const ingress = await createIngress({ token: 'dying-token', nativeToken: 'dying-native', resolve: () => endpoint, discover: () => ({}), sample: '' });
  const directory = await mkdtemp(join(tmpdir(), 'bcp-bridge-dying-'));
  const descriptor = join(directory, 'runtime.json');
  await writeFile(descriptor, JSON.stringify({ version: 1, origin: ingress.origin, token: 'dying-native', generation: 'dying' }));
  const client = new Client({ name: 'dying fixture', version: 'test' });
  let replacement;
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp-entry.cjs', import.meta.url)), descriptor] }), { timeout: 10000 });
    assert.equal((await client.callTool({ name: 'fixture' })).content[0].text, 'claimed');
    const started = Date.now();
    const progress = [];
    await assert.rejects(client.callTool({ name: 'fixture' }, undefined, { timeout: 20000, onprogress: (value) => progress.push(value) }));
    assert.equal(progress.length, 1, '响应已开始后才断开');
    assert.ok(Date.now() - started < 8000, `中途断开应立即失败，实际等待 ${Date.now() - started}ms`);
    assert.deepEqual(calls, ['dying', 'dying'], '可能已执行的调用不重放');
    replacement = await countingServer('replacement');
    endpoint = replacement.endpoint;
    await assert.rejects(client.callTool({ name: 'fixture' }, undefined, { timeout: 15000 }), /浏览器会话已重置/, '会话被替换后，下一次调用先告知认领已失效');
    assert.deepEqual(replacement.calls, []);
    await pause(1600);
    assert.equal((await client.callTool({ name: 'fixture' })).content[0].text, 'replacement');
  } finally {
    await client.close();
    await ingress.close();
    await remote.close();
    http.closeAllConnections();
    await new Promise((done) => http.close(done));
    await replacement?.close();
  }
});

test('a tool call whose reply was lost marks its session, so the next call reports the reset', async () => {
  let http;
  const calls = [];
  const remote = new Server({ name: 'lost-reply', version: 'test' }, { capabilities: { tools: {} } });
  remote.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
    calls.push('claim');
    await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: extra._meta.progressToken, progress: 1, total: 2 } });
    setTimeout(() => http.closeAllConnections(), 50);
    return new Promise(() => {});
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await remote.connect(transport);
  http = createServer((request, response) => { void transport.handleRequest(request, response).catch((error) => { response.destroy(error); }); });
  await new Promise((done) => http.listen(0, '127.0.0.1', done));
  let endpoint = `http://127.0.0.1:${http.address().port}`;
  const ingress = await createIngress({ token: 'lost-token', nativeToken: 'lost-native', resolve: () => endpoint, discover: () => ({}), sample: '' });
  const directory = await mkdtemp(join(tmpdir(), 'bcp-bridge-lost-'));
  const descriptor = join(directory, 'runtime.json');
  await writeFile(descriptor, JSON.stringify({ version: 1, origin: ingress.origin, token: 'lost-native', generation: 'lost' }));
  const client = new Client({ name: 'lost reply fixture', version: 'test' });
  let replacement;
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp-entry.cjs', import.meta.url)), descriptor] }), { timeout: 10000 });
    await assert.rejects(client.callTool({ name: 'fixture' }, undefined, { timeout: 20000, onprogress: () => {} }));
    replacement = await countingServer('replacement');
    endpoint = replacement.endpoint;
    await assert.rejects(client.callTool({ name: 'fixture' }, undefined, { timeout: 15000 }), /浏览器会话已重置/, '第一次调用可能已在旧会话里认领了标签页');
    assert.deepEqual(replacement.calls, []);
  } finally {
    await client.close();
    await ingress.close();
    await remote.close();
    http.closeAllConnections();
    await new Promise((done) => http.close(done));
    await replacement?.close();
  }
});

test('a call after a restart runs transparently when the old session never ran a tool', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bcp-bridge-stateless-'));
  const descriptor = join(directory, 'runtime.json');
  const first = await countingServer('first');
  const firstIngress = await createIngress({ token: 'first-token', nativeToken: 'first-native', resolve: () => first.endpoint, discover: () => ({}), sample: '' });
  await writeFile(descriptor, JSON.stringify({ version: 1, origin: firstIngress.origin, token: 'first-native', generation: 'first' }));
  const client = new Client({ name: 'stateless fixture', version: 'test' });
  let second;
  let secondIngress;
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp-entry.cjs', import.meta.url)), descriptor] }), { timeout: 10000 });
    await client.listTools();
    await firstIngress.close();
    await first.close();
    second = await countingServer('second');
    secondIngress = await createIngress({ token: 'second-token', nativeToken: 'second-native', resolve: () => second.endpoint, discover: () => ({}), sample: '' });
    await writeFile(descriptor, JSON.stringify({ version: 1, origin: secondIngress.origin, token: 'second-native', generation: 'second' }));
    assert.equal((await client.callTool({ name: 'fixture' }, undefined, { timeout: 15000 })).content[0].text, 'second', '旧会话没有浏览器状态时无需打断助手');
    assert.deepEqual(second.calls, ['second']);
  } finally {
    await client.close();
    await secondIngress?.close();
    await second?.close();
  }
});

test('only a streamed POST reply that breaks counts as a broken connection', async (t) => {
  const sockets = [];
  const http = createServer((request, response) => {
    sockets.push(request.socket);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('event: message\ndata: {}\n\n');
    setTimeout(() => request.socket.destroy(), 20);
  });
  await new Promise((done) => http.listen(0, '127.0.0.1', done));
  t.after(() => { http.closeAllConnections(); http.close(); });
  const url = `http://127.0.0.1:${http.address().port}/mcp`;
  let broken = 0;
  const watched = watchResponses(() => { broken++; });
  for (const method of ['GET', 'POST']) {
    const response = await watched(url, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
    await assert.rejects(response.text());
  }
  assert.equal(broken, 1, '空闲通知流（GET）的断开交给 SDK 重连，不算连接损坏');
  const idle = (cause) => watchResponses(() => { broken++; }, async () => new Response(new ReadableStream({
    pull(controller) { controller.error(Object.assign(new TypeError('terminated'), { cause })); },
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects((await idle({ code: 'UND_ERR_BODY_TIMEOUT' })(url, { method: 'POST' })).text());
  assert.equal(broken, 1, '空闲回复被 fetch 的响应体超时切断不算连接损坏');
  await assert.rejects((await idle({ code: 'UND_ERR_SOCKET' })(url, { method: 'POST' })).text());
  assert.equal(broken, 2);
});

test('a bridge started before the desktop is ready waits for it instead of exiting', async () => {
  const server = await countingServer('late');
  let ready = false;
  const ingress = await createIngress({ token: 'late-token', nativeToken: 'late-native', resolve: () => ready ? server.endpoint : null, discover: () => ({}), sample: '' });
  const directory = await mkdtemp(join(tmpdir(), 'bcp-bridge-late-'));
  const descriptor = join(directory, 'runtime.json');
  await writeFile(descriptor, JSON.stringify({ version: 1, origin: ingress.origin, token: 'late-native', generation: 'late' }));
  const timer = setTimeout(() => { ready = true; }, 1500);
  const client = new Client({ name: 'late fixture', version: 'test' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp-entry.cjs', import.meta.url)), descriptor] }), { timeout: 15000 });
    assert.equal((await client.callTool({ name: 'fixture' })).content[0].text, 'late');
  } finally {
    clearTimeout(timer);
    await client.close();
    await ingress.close();
    await server.close();
  }
});

test('an undelivered call does not erase the mark left by a concurrent call that reached the session', async () => {
  // Multi-session like the real backend: unknown sessions get 404. A call named "deferred" is answered 404
  // (never delivered) after a delay, so a concurrent call reaches the same session first.
  const calls = [];
  const sessions = new Map();
  const http = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      const text = Buffer.concat(chunks).toString();
      const body = text ? JSON.parse(text) : undefined;
      if (body?.method === 'tools/call' && body.params?.name === 'deferred') {
        setTimeout(() => response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"Session not found"}'), 300);
        return;
      }
      const id = request.headers['mcp-session-id'];
      let transport = id && sessions.get(id);
      if (id && !transport) { response.writeHead(404).end('{"error":"Session not found"}'); return; }
      if (!transport) {
        const server = new Server({ name: 'sessions', version: 'test' }, { capabilities: { tools: {} } });
        server.setRequestHandler(CallToolRequestSchema, async (call) => { calls.push(call.params.name); return { content: [{ type: 'text', text: call.params.name }] }; });
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (session) => sessions.set(session, transport) });
        await server.connect(transport);
      }
      await transport.handleRequest(request, response, body).catch((error) => response.destroy(error));
    });
  });
  await new Promise((done) => http.listen(0, '127.0.0.1', done));
  const ingress = await createIngress({ token: 'concurrent-token', nativeToken: 'concurrent-native', resolve: () => `http://127.0.0.1:${http.address().port}`, discover: () => ({}), sample: '' });
  const directory = await mkdtemp(join(tmpdir(), 'bcp-bridge-concurrent-'));
  const descriptor = join(directory, 'runtime.json');
  await writeFile(descriptor, JSON.stringify({ version: 1, origin: ingress.origin, token: 'concurrent-native', generation: 'concurrent' }));
  const client = new Client({ name: 'concurrent fixture', version: 'test' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp-entry.cjs', import.meta.url)), descriptor] }), { timeout: 10000 });
    const deferred = client.callTool({ name: 'deferred' }, undefined, { timeout: 15000 });
    await pause(50);
    assert.equal((await client.callTool({ name: 'claim_tab' })).content[0].text, 'claim_tab');
    await assert.rejects(deferred, /浏览器会话已重置/, '另一调用已到达旧会话，未送达的调用不能透明重放进新会话');
    assert.deepEqual(calls, ['claim_tab']);
  } finally {
    await client.close();
    await ingress.close();
    http.closeAllConnections();
    await new Promise((done) => http.close(done));
  }
});

const host = 'C:\\Program Files\\UltraGo Internal\\resources\\native\\bcp-native-host.exe';

test('install links follow the formats VS Code, Cursor and Trae document', () => {
  const vscode = agentLink('vscode', host, ['--mcp-stdio']);
  assert.match(vscode, /^vscode:mcp\/install\?/);
  assert.deepEqual(JSON.parse(decodeURIComponent(vscode.slice('vscode:mcp/install?'.length))), { name: 'ultrago', command: host, args: ['--mcp-stdio'] });
  const decoded = (link) => JSON.parse(Buffer.from(new URL(link).searchParams.get('config'), 'base64').toString('utf8'));
  const cursor = agentLink('cursor', host, ['--mcp-stdio']);
  assert.match(cursor, /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=ultrago&config=/);
  assert.deepEqual(decoded(cursor), { command: host, args: ['--mcp-stdio'] }, 'config 是不带服务器名包装的 command/args');
  const trae = agentLink('trae', host, ['--mcp-stdio']);
  assert.match(trae, /^trae:\/\/trae\.ai-ide\/mcp-import\?type=stdio&name=ultrago&config=/);
  assert.deepEqual(decoded(trae), { command: host, args: ['--mcp-stdio'] });
  // A user-chosen install folder can base64-encode to "+", which an unencoded query string turns into a space.
  const chinese = 'D:\\浏览器助手\\resources\\native\\bcp-native-host.exe';
  assert.match(Buffer.from(JSON.stringify({ command: chinese, args: ['--mcp-stdio'] })).toString('base64'), /\+/, '样例必须真的含 +');
  for (const client of ['cursor', 'trae']) assert.deepEqual(decoded(agentLink(client, chinese, ['--mcp-stdio'])), { command: chinese, args: ['--mcp-stdio'] });
  assert.throws(() => agentLink('codex', host, []), /安装链接/);
});

test('CLI assistants get their own documented commands, and Claude Code replaces an older entry', () => {
  assert.deepEqual(agentCliSteps('claude-code', host, ['--mcp-stdio']), [
    { args: ['mcp', 'remove', '-s', 'user', 'ultrago'], optional: true },
    { args: ['mcp', 'add', '-s', 'user', 'ultrago', '--', host, '--mcp-stdio'] },
  ]);
  assert.deepEqual(agentCliSteps('codex', host, ['--mcp-stdio']), [{ args: ['mcp', 'add', 'ultrago', '--', host, '--mcp-stdio'] }]);
  // Without --global OpenCode writes the client's working directory's project config, which no project of the user reads.
  assert.deepEqual(agentCliSteps('opencode', host, ['--mcp-stdio'], 'opencode v2.2.6'), [{ args: ['mcp', 'add', '--global', 'ultrago', '--', host, '--mcp-stdio'] }]);
  // 1.x (npm's latest) prints a bare version, rejects --global with its usage text, and writes the global config anyway.
  assert.deepEqual(agentCliSteps('opencode', host, ['--mcp-stdio'], '1.19.5\n'), [{ args: ['mcp', 'add', 'ultrago', '--', host, '--mcp-stdio'] }]);
  // Before 1.17 `mcp add` only runs interactively and prints its usage; the user is sent to the 1.x manual config instead.
  assert.throws(() => agentCliSteps('opencode', host, ['--mcp-stdio'], '1.16.0'), /OpenCode 1\.16 只能交互添加.*OpenCode 1\.x/);
  assert.equal(agentCliSteps('opencode', host, ['--mcp-stdio'], '1.17.0')[0].args.includes('--global'), false);
  // A version that cannot be read keeps the 2.x form; if it is wrong, OpenCode's own error is shown.
  assert.deepEqual(agentCliSteps('opencode', host, ['--mcp-stdio'], ''), agentCliSteps('opencode', host, ['--mcp-stdio'], 'opencode v2.2.6'));
});

test('a CLI is found the way the shell finds it, and a Windows .cmd shim is run through cmd with every argument quoted', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'bcp-path-'));
  await writeFile(join(folder, 'claude.CMD'), '');
  await mkdir(join(folder, 'codex.exe'));
  assert.equal(await findExecutable('claude', { PATH: `/nowhere;${folder}`, PATHEXT: '.EXE;.CMD' }, 'win32'), join(folder, 'claude.CMD'));
  assert.equal(await findExecutable('codex', { PATH: folder, PATHEXT: '.EXE' }, 'win32'), null, '同名目录不是可执行文件');
  assert.equal(await findExecutable('claude', { PATH: folder }, 'linux'), null);
  // Installed after the client started: not on its frozen PATH, but where the installers document they put it.
  const appData = await mkdtemp(join(tmpdir(), 'bcp-appdata-'));
  const profile = await mkdtemp(join(tmpdir(), 'bcp-profile-'));
  await mkdir(join(appData, 'npm'));
  await writeFile(join(appData, 'npm', 'codex.CMD'), '');
  await mkdir(join(profile, '.local', 'bin'), { recursive: true });
  await writeFile(join(profile, '.local', 'bin', 'claude.EXE'), '');
  const stale = { PATH: '/nowhere', PATHEXT: '.EXE;.CMD', APPDATA: appData, USERPROFILE: profile };
  assert.equal(await findExecutable('codex', stale, 'win32'), join(appData, 'npm', 'codex.CMD'), 'npm 全局目录');
  assert.equal(await findExecutable('claude', stale, 'win32'), join(profile, '.local', 'bin', 'claude.EXE'), 'Claude Code 安装目录');

  const calls = [];
  const run = async (file, args, options) => { calls.push({ file, args, options }); return { code: 0, output: '' }; };
  await runAgentCli('C:\\Users\\卖家\\AppData\\Roaming\\npm\\claude.cmd', ['mcp', 'add', '--', host], { platform: 'win32', run });
  assert.deepEqual(calls[0].args.slice(0, 4), ['/d', '/v:off', '/s', '/c'], '/v:off 让引号里的 ! 不被延迟展开改写');
  assert.equal(calls[0].args[4], `""C:\\Users\\卖家\\AppData\\Roaming\\npm\\claude.cmd" "mcp" "add" "--" "${host}""`);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  for (const unsafe of ['C:\\%TEMP%\\x.exe', 'C:\\a"b\\x.exe', 'C:\\a\nb.exe', 'C:\\a\rb.exe']) {
    await assert.rejects(runAgentCli('C:\\npm\\codex.cmd', [unsafe], { platform: 'win32', run }), /无法安全传递/, JSON.stringify(unsafe));
  }
  await runAgentCli('C:\\Users\\卖家\\.local\\bin\\claude.exe', ['mcp', 'list'], { platform: 'win32', run });
  assert.deepEqual(calls.at(-1), { file: 'C:\\Users\\卖家\\.local\\bin\\claude.exe', args: ['mcp', 'list'], options: undefined }, '.exe 直接启动，不经过 cmd');
});

test("cmd.exe's own errors in the legacy code page are decoded, UTF-8 output is kept", () => {
  assert.equal(decodeOutput(Buffer.from([0xa1, 0xb0, 0x6e, 0x6f, 0x64, 0x65, 0xa1, 0xb1, 0xb2, 0xbb, 0xca, 0xc7])), '“node”不是');
  assert.equal(decodeOutput(Buffer.from('已添加 ultrago', 'utf8')), '已添加 ultrago');
});

test('only installed assistants are offered, each recognised by what makes its connection work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bcp-detect-'));
  const appData = join(root, 'Roaming');
  await mkdir(join(appData, 'Claude'), { recursive: true });
  await writeFile(join(root, 'codex'), '');
  await writeFile(join(root, 'opencode'), '');
  const agents = await detectAgents({
    appData, localAppData: join(root, 'Local'), env: { PATH: root }, platform: 'linux',
    protocolHandler: (protocol) => (protocol === 'cursor://' ? 'Cursor' : ''),
  });
  const detected = Object.fromEntries(agents.map((agent) => [agent.client, agent.detected]));
  assert.deepEqual(detected, { claude: true, 'claude-code': false, codex: true, opencode: true, cursor: true, vscode: false, trae: false });
  assert.equal(agents.find((agent) => agent.client === 'claude').where, claudeConfigFile(appData));

  // One assistant that cannot be checked is reported on its own row; the others are still listed.
  const failing = await detectAgents({
    appData, localAppData: join(root, 'Local'), env: { PATH: root }, platform: 'linux',
    protocolHandler: (protocol) => { if (protocol === 'vscode://') throw new Error('fixture: 注册表不可读'); return protocol === 'cursor://' ? 'Cursor' : ''; },
  });
  assert.match(failing.find((agent) => agent.client === 'vscode').blocked, /检测失败：fixture: 注册表不可读/);
  assert.equal(failing.find((agent) => agent.client === 'cursor').detected, true);
  // A Microsoft Store Claude is shown as installed but not offered: writing its documented file would not take effect.
  await mkdir(join(root, 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc'), { recursive: true });
  const store = (await detectAgents({ appData, localAppData: join(root, 'Local'), env: {}, platform: 'linux', protocolHandler: () => '' })).find((agent) => agent.client === 'claude');
  assert.equal(store.detected, true);
  assert.match(store.blocked, /MSIX/);
});

test('connecting runs only what the picked assistant needs and reports each failure in its own words', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bcp-connect-'));
  await writeFile(join(root, 'claude'), '');
  const env = { PATH: root };
  const calls = [];
  const opened = [];
  const deps = (run) => ({ openExternal: async (url) => { opened.push(url); }, appData: join(root, 'Roaming'), localAppData: join(root, 'Local'), env, platform: 'linux', run: async (file, args) => { calls.push(args.join(' ')); return run(args); } });

  // A first install has nothing to remove; that failure must not stop the add.
  const added = await connectAgent('claude-code', host, ['--mcp-stdio'], deps((args) => ({ code: args[1] === 'remove' ? 1 : 0, output: '' })));
  assert.match(added, /Claude Code/);
  assert.deepEqual(calls, ['mcp remove -s user ultrago', `mcp add -s user ultrago -- ${host} --mcp-stdio`]);
  await assert.rejects(connectAgent('claude-code', host, ['--mcp-stdio'], deps((args) => ({ code: 1, output: args[1] === 'add' ? 'permission denied' : '' }))), /未能添加 ultrago：permission denied/);
  await assert.rejects(connectAgent('codex', host, [], deps(() => ({ code: 0, output: '' }))), /没有找到 codex 命令/);
  await writeFile(join(root, 'opencode'), '');
  calls.length = 0;
  const opencode = (version) => deps((args) => ({ code: 0, output: args[0] === '--version' ? version : '' }));
  assert.match(await connectAgent('opencode', host, ['--mcp-stdio'], opencode('opencode v2.2.6')), /重新打开 OpenCode 后可用/);
  assert.deepEqual(calls, ['--version', `mcp add --global ultrago -- ${host} --mcp-stdio`]);
  calls.length = 0;
  await connectAgent('opencode', host, ['--mcp-stdio'], opencode('1.19.5'));
  assert.deepEqual(calls, ['--version', `mcp add ultrago -- ${host} --mcp-stdio`]);
  await assert.rejects(connectAgent('opencode', host, ['--mcp-stdio'], deps(() => ({ code: 1, output: 'invalid config' }))), /OpenCode 未能添加 ultrago：invalid config/);

  calls.length = 0;
  assert.match(await connectAgent('vscode', host, ['--mcp-stdio'], deps(() => ({ code: 0, output: '' }))), /确认添加/);
  assert.deepEqual(opened, [agentLink('vscode', host, ['--mcp-stdio'])]);
  assert.deepEqual(calls, [], '安装链接不运行任何命令');

  assert.match(await connectAgent('claude', host, ['--mcp-stdio'], deps(() => ({ code: 0, output: '' }))), /完全退出并重新打开 Claude Desktop/);
  assert.deepEqual(JSON.parse(await readFile(claudeConfigFile(join(root, 'Roaming')), 'utf8')).mcpServers['ultrago'], { command: host, args: ['--mcp-stdio'] });
  await mkdir(join(root, 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc'), { recursive: true });
  await assert.rejects(connectAgent('claude', host, ['--mcp-stdio'], deps(() => ({ code: 0, output: '' }))), /MSIX/);
  await assert.rejects(connectAgent('../opencode', host, [], deps(() => ({ code: 0, output: '' }))), /列表中的助手/);
});
