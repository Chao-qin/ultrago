import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIngress } from '../src/ingress.mjs';
import { createAgentConnections } from '../src/agent-connections.mjs';
import { startMcpHttpServer } from '../../backend/dist/mcp-http.js';
import { EventStore } from '../../backend/dist/event-store.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const directory = await mkdtemp(join(tmpdir(), 'bcp-wine-mcp-'));
const windowsPath = (path) => 'Z:' + path.replaceAll('/', '\\');
const token = 'a'.repeat(64);
const nativeToken = 'b'.repeat(64);
const tracker = createAgentConnections();
let browserCalls = 0;
const server = await startMcpHttpServer(async () => { browserCalls++; throw new Error('No browser calls permitted'); }, 0, new EventStore());
const endpoint = `http://127.0.0.1:${server.address().port}`;
const ingress = await createIngress({ token, nativeToken, resolve: () => endpoint, discover: () => ({}), sample: '', agentEvent: (event) => tracker.update(event) });
const config = join(process.env.WINEPREFIX || '/root/.wine', 'drive_c/users/root/AppData/Roaming/UltraGoDesktop');
const { mkdir } = await import('node:fs/promises');
await mkdir(config, { recursive: true });
await writeFile(join(config, 'runtime.json'), JSON.stringify({ version: 1, origin: ingress.origin, token: nativeToken }));
const executable = fileURLToPath(new URL('../release/win-unpacked/resources/native/bcp-native-host.exe', import.meta.url));
const transport = new StdioClientTransport({ command: 'wine', args: [executable, '--mcp-stdio'], env: { ...process.env, APPDATA: windowsPath(directory), WINEDEBUG: '-all' }, stderr: 'pipe' });
let errors = '';
transport.stderr?.on('data', (chunk) => { errors = (errors + chunk.toString()).slice(-5000); });
const client = new Client({ name: 'Windows Workbuddy fixture', version: 'test' });
try {
  try { await client.connect(transport, { timeout: 20000 }); }
  catch (error) { throw new Error(`${error.message}\n${errors}`); }
  const result = await client.listTools({}, { timeout: 10000 });
  assert.ok(result.tools.length > 0);
  const deadline = Date.now() + 3000;
  while (!tracker.snapshot().some((entry) => entry.name === 'Windows Workbuddy fixture' && entry.toolCount) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
  assert.ok(tracker.snapshot().some((entry) => entry.state === 'connected' && entry.toolCount === result.tools.length));
  assert.equal(browserCalls, 0);
  process.stdout.write(`PASS Windows packaged Go launcher → Electron Node → MCP stdio handshake/listTools (${result.tools.length} tools), live assistant status; no browser action or database\n`);
  await client.close();

  const program = windowsPath(fileURLToPath(new URL('../release/win-unpacked/UltraGo Internal.exe', import.meta.url)));
  const script = windowsPath(fileURLToPath(new URL('./test-windows-reports.mjs', import.meta.url)));
  const output = join(directory, 'reports.out');
  const error = join(directory, 'reports.err');
  const batch = join(directory, 'reports.cmd');
  await writeFile(batch, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${program}" "${script}" <NUL >"${windowsPath(output)}" 2>"${windowsPath(error)}"\r\nexit /b %errorlevel%\r\n`);
  const child = spawn('wine', ['cmd', '/c', windowsPath(batch)], { env: { ...process.env, WINEDEBUG: '-all' }, stdio: 'ignore' });
  const code = await new Promise((done, fail) => { child.once('error', fail); child.once('exit', done); });
  assert.equal(code, 0, await readFile(error, 'utf8'));
  process.stdout.write(await readFile(output, 'utf8'));
} finally {
  await client.close();
  await ingress.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
