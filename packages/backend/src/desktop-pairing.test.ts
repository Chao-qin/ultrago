import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PROTOCOL_VERSION, type BrowserTarget } from '@bcp/shared';
import { config } from './config.js';
import { createBrowserHttpRouter } from './browser-http.js';
import { createBrowserMcpServer, type RawBrowserCall } from './browser-mcp.js';
import { BrowserDispatcher } from './browser-dispatcher.js';
import type { BrowserSetupService } from './browser-setup-service.js';
import { WsServer } from './ws-server.js';

test('main-process pairing reaches the authenticated selection route through ingress', async () => {
  const dynamicImport = new Function('url', 'return import(url)') as (url: string) => Promise<Record<string, any>>;
  const { Coordinator } = await dynamicImport(new URL('../../desktop/src/coordinator.mjs', import.meta.url).href);
  const { createIngress } = await dynamicImport(new URL('../../desktop/src/ingress.mjs', import.meta.url).href);
  let selected: BrowserTarget | null = null;
  const target = { kind: 'chrome' as const, instanceId: 'profile-b' };
  const app = express(); app.use(express.json());
  app.use('/internal/browsers', createBrowserHttpRouter({} as BrowserSetupService, {
    bootstrapProbe: async () => ({ ok: true, tabs: 1, windows: 1 }),
  } as unknown as BrowserDispatcher, {
    listBrowsers: () => [{ ...target, ready: true }],
    selectDesktopTarget: (value: BrowserTarget) => { selected = value; },
  } as unknown as WsServer));
  const server = await new Promise<ReturnType<typeof app.listen>>((done) => { const server = app.listen(0, '127.0.0.1', () => done(server)); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const coordinator = new Coordinator({ paths: {}, fork: () => {}, safeStorage: {} });
  coordinator.token = config.internalToken;
  coordinator.phase = 'ready';
  coordinator.supervisor = { endpoints: { backend: {} } };
  coordinator.atomic = async () => {};
  const ingress = await createIngress({ token: config.internalToken, nativeToken: 'unused', resolve: () => `http://127.0.0.1:${address.port}`, discover: () => ({}), sample: '' });
  coordinator.ingress = ingress;
  try {
    await coordinator.chooseBrowser(target.instanceId);
    assert.deepEqual(selected, target);
    assert.equal(coordinator.settings.browserId, target.instanceId);
  } finally {
    await ingress.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
  }
});

test('actual MCP requests follow the explicitly pinned desktop profile and never fail over', async () => {
  const before = { mode: process.env.BCP_DESKTOP, port: config.port };
  process.env.BCP_DESKTOP = '1';
  (config as unknown as { port: number }).port = 0;
  const server = new WsServer();
  const clients: WebSocket[] = [];
  const calls: string[] = [];
  const connect = async (instanceId: string) => {
    const target = { kind: 'chrome' as const, instanceId };
    const ready = server.waitForReady(target, 3000);
    const socket = new WebSocket(`ws://127.0.0.1:${server.boundPort}`); clients.push(socket);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'welcome') socket.send(JSON.stringify({ type: 'ready', instanceId, sessionId: message.sessionId }));
      if (message.type === 'rpc_request') {
        calls.push(instanceId);
        socket.send(JSON.stringify({ type: 'rpc_response', id: message.id, ok: true, result: { tabs: [] } }));
      }
    });
    await new Promise<void>((done, fail) => { socket.once('open', done); socket.once('error', fail); });
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, role: 'extension', token: config.token, browser: 'chrome', instanceId, clientInfo: { name: 'fixture', version: '1' } }));
    await ready;
    return { socket, target };
  };
  const client = new Client({ name: 'desktop-target-test', version: '1' });
  try {
    await server.listening();
    await connect('profile-a');
    const b = await connect('profile-b');
    assert.equal(server.current(), null);
    server.selectDesktopTarget(b.target);
    const dispatcher = new BrowserDispatcher(server, {
      ensureBrowserReady: async () => {}, bootstrapProbe: async () => ({ ok: true, tabs: 0, windows: 0 }),
    } as unknown as BrowserSetupService);
    const mcp = createBrowserMcpServer(((method, params, target) => dispatcher.dispatch(target, method, params as Record<string, unknown>)) as RawBrowserCall, server.events, {
      list: () => server.listBrowsers(), current: () => server.current(), validate: (target) => server.validate(target),
      getMode: (id) => server.getMode(id), setMode: (target, mode) => server.setMode(target, mode),
      setClaim: (id, target, tabId, since) => server.setClaim(id, target, tabId, since), clearClaim: (id) => server.clearClaim(id), listClaims: () => server.listClaims(),
    });
    const [transport, remote] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(remote), client.connect(transport)]);
    const first = await client.callTool({ name: 'list_tabs', arguments: {} });
    assert.notEqual(first.isError, true);
    assert.deepEqual(calls, ['profile-b']);
    const selected = await client.callTool({ name: 'use_browser', arguments: { kind: 'chrome' } });
    assert.notEqual(selected.isError, true);
    await new Promise<void>((done) => { b.socket.once('close', () => done()); b.socket.close(); });
    await new Promise((done) => setImmediate(done));
    assert.equal(server.current()?.instanceId, 'profile-b');
    const result = await client.callTool({ name: 'list_tabs', arguments: {} });
    assert.equal(result.isError, true);
    const reselected = await client.callTool({ name: 'use_browser', arguments: { kind: 'chrome' } });
    assert.equal(reselected.isError, true);
    assert.deepEqual(calls, ['profile-b']);
  } finally {
    await client.close(); for (const socket of clients) socket.close(); await server.close();
    (config as unknown as { port: number }).port = before.port;
    if (before.mode === undefined) delete process.env.BCP_DESKTOP; else process.env.BCP_DESKTOP = before.mode;
  }
});
