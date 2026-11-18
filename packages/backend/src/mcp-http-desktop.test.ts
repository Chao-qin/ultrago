import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpHttpServer } from './mcp-http.js';
import { EventStore } from './event-store.js';

test('desktop MCP accepts its actual ephemeral port and rejects unauthorized HTTP requests', async () => {
  const before = { mode: process.env.BCP_DESKTOP, token: process.env.BCP_DESKTOP_TOKEN };
  process.env.BCP_DESKTOP = '1';
  process.env.BCP_DESKTOP_TOKEN = 'test-launch-token';
  const server = await startMcpHttpServer(async () => { throw new Error('This test only lists tools'); }, 0, new EventStore());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: 'desktop-test', version: '1' });
  try {
    assert.notEqual(address.port, 0);
    assert.equal((await fetch(url)).status, 401);
    const forgedHost = await new Promise<number | undefined>((done, fail) => {
      const req = request(url, { headers: { Authorization: 'Bearer test-launch-token', Host: 'foreign.example' } }, (res) => { res.resume(); done(res.statusCode); });
      req.on('error', fail); req.end();
    });
    assert.equal(forgedHost, 403);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer test-launch-token' } } }));
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'read_content'));
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    if (before.mode === undefined) delete process.env.BCP_DESKTOP; else process.env.BCP_DESKTOP = before.mode;
    if (before.token === undefined) delete process.env.BCP_DESKTOP_TOKEN; else process.env.BCP_DESKTOP_TOKEN = before.token;
  }
});
