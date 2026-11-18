import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * True only when the request provably never reached a running MCP session: the ingress was not listening,
 * it rejected the token or had no backend yet, or the backend no longer knows the session. A dropped
 * connection mid-request (502, reset, timeout) may already have acted.
 */
export function requestNotDelivered(error) {
  if (error instanceof StreamableHTTPError) return error.code === 401 || error.code === 404 || error.code === 503;
  return error instanceof TypeError && error.cause?.code === 'ECONNREFUSED';
}

// Tool calls of one assistant turn arrive within milliseconds; a later turn comes after a model round trip.
const RESET_WINDOW = 1500;
const SESSION_RESET = '桌面客户端的本地服务已重启，浏览器会话已重置：之前选定的浏览器目标和认领的标签页已失效，这次调用没有执行。请重新确认目标并认领标签页后再调用。';

/**
 * Reports a streamed POST reply that breaks before it completes. The SDK never settles that request, and it
 * logs the same message for the idle GET notification stream, which it reconnects by itself and must be left alone.
 * An idle reply cut by fetch's body timeout (a cancelled call the server stopped answering, or a call silent for
 * five minutes) is not a broken connection: that call fails on its own timeout while the session stays healthy.
 */
export function watchResponses(onBrokenReply, request = fetch) {
  return async (url, init) => {
    const response = await request(url, init);
    if (init?.method !== 'POST' || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) controller.close(); else controller.enqueue(value);
        } catch (error) {
          if ((error?.cause?.code ?? error?.code) !== 'UND_ERR_BODY_TIMEOUT') onBrokenReply();
          controller.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

async function readDescriptor(file) {
  const descriptor = JSON.parse(await readFile(file, 'utf8'));
  const origin = new URL(descriptor.origin);
  if (descriptor.version !== 1 || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || Number(origin.port) <= 0 || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('请先打开并准备桌面客户端。');
  return descriptor;
}

export async function runMcpBridge(descriptorFile, { reconnectWindow = 30_000 } = {}) {
  const id = randomUUID();
  const secrets = new Set();
  let descriptor;
  let remote;
  let connecting;
  let name = 'AI 助手';
  let state = 'connecting';
  let initialized = false;
  // A replaced session has lost the previous one's browser target and tab claim. The first tool call after it
  // and every call arriving within RESET_WINDOW of that report are refused, so a parallel batch cannot slip through.
  // Tool calls sent on the current session; one that provably never arrived takes back only its own count.
  let sent = 0;
  let resetPending = false;
  let resetUntil = 0;
  let toolCount;
  let timer;
  let closed = false;
  let reports = Promise.resolve();
  const redact = (text) => [...secrets].reduce((value, secret) => value.replaceAll(secret, '[hidden]'), String(text));
  const report = (error = '') => {
    const target = descriptor;
    const body = JSON.stringify({ id, name, state, toolCount, error: redact(error).slice(0, 1000) });
    const send = async () => {
      try {
        const result = await fetch(`${new URL(target.origin).origin}/__desktop/agent`, { method: 'POST', headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(1000) });
        if (!result.ok) process.stderr.write(`助手状态上报失败（${result.status}）\n`);
      } catch (failure) { process.stderr.write(`助手状态上报失败：${failure.message}\n`); }
    };
    reports = reports.then(send, send);
    return reports;
  };
  // Each desktop run publishes a new runtime descriptor; connecting always follows the current one.
  const open = async () => {
    const next = await readDescriptor(descriptorFile);
    secrets.add(next.token);
    const origin = new URL(next.origin).origin;
    const response = await fetch(`${origin}/__desktop/mcp`, { headers: { Authorization: `Bearer ${next.token}` }, redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('桌面客户端连接已失效，请重新打开。');
    const connection = await response.json();
    secrets.add(connection.token);
    const client = new Client({ name: 'ultrago-desktop-bridge', version: '0.1.0' });
    if (closed) throw new Error('MCP 桥接已关闭。');
    descriptor = next;
    await report();
    const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
      fetch: watchResponses(() => drop(client)),
    });
    try { await client.connect(transport, { timeout: 10_000 }); }
    catch (error) {
      if (!closed) { state = 'error'; await report(error.message); }
      throw error;
    }
    if (closed) { await client.close(); throw new Error('MCP 桥接已关闭。'); }
    client.onclose = () => drop(client);
    client.onerror = (error) => {
      // The idle notification stream is cut and reopened routinely; that is not a broken connection.
      if (closed || remote !== client || /SSE stream disconnected/.test(error.message)) return;
      state = 'error'; void report(error.message);
    };
    remote = client;
    if (initialized) { state = 'connected'; void report(); }
    return client;
  };
  const drop = (client) => {
    if (remote !== client) return;
    remote = undefined;
    if (sent > 0) resetPending = true;
    sent = 0;
    state = 'connecting';
    void client.close().catch(() => {});
  };
  // One connection attempt is shared; every caller keeps its own reconnect window around it.
  const attempt = () => connecting ??= open().finally(() => { connecting = undefined; });
  const ensureRemote = async () => {
    const deadline = Date.now() + reconnectWindow;
    let delay = 250;
    for (;;) {
      if (remote) return remote;
      try { return await attempt(); }
      catch (error) {
        // No descriptor means the desktop client was never prepared on this account; waiting will not help.
        if (error.code === 'ENOENT') throw error;
        if (closed || Date.now() + delay > deadline) throw new Error(`桌面客户端暂不可用（${error.message}），请确认客户端已打开并完成准备后重试。`);
        await new Promise((done) => setTimeout(done, delay));
        delay = Math.min(delay * 2, 2000);
      }
    }
  };
  const checkReset = () => {
    if (resetPending) { resetPending = false; resetUntil = Date.now() + RESET_WINDOW; }
    if (Date.now() < resetUntil) throw new Error(SESSION_RESET);
  };
  const succeeded = (client, result) => {
    if (!closed && remote === client && state !== 'connected') { state = 'connected'; void report(); }
    return result;
  };
  /**
   * A request that never reached a session is safe to send again. Tool calls additionally stop at a session
   * that replaced one where a tool was sent, so the assistant re-selects and re-claims instead of acting on
   * another tab; listing tools carries no such state. A tool call marks its session as soon as it is sent,
   * because it may have run even when its reply is lost; only a provably undelivered call takes that back.
   */
  const withRemote = async (operation, tool) => {
    const client = await ensureRemote();
    if (tool) { checkReset(); sent++; }
    try { return succeeded(client, await operation(client)); }
    catch (error) {
      if (closed || !requestNotDelivered(error)) throw error;
      if (tool && remote === client) sent--;
      drop(client);
      const fresh = await ensureRemote();
      if (tool) { checkReset(); sent++; }
      return succeeded(fresh, await operation(fresh));
    }
  };

  const first = await ensureRemote();
  const server = new Server({ name: 'ultrago', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: first.getInstructions() });
  server.oninitialized = () => { if (closed) return; initialized = true; name = server.getClientVersion()?.name || 'AI 助手'; state = 'connected'; void report(); };
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    try { const result = await withRemote((client) => client.listTools(request.params), false); if (!closed) { toolCount = result.tools.length; state = 'connected'; void report(); } return result; }
    catch (error) { if (!closed) { state = 'error'; void report(error.message); } throw error; }
  });
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => withRemote((client) => client.callTool(request.params, undefined, {
    signal: extra.signal,
    timeout: 300_000,
    resetTimeoutOnProgress: true,
    onprogress: (progress) => {
      const progressToken = extra._meta?.progressToken;
      if (progressToken == null) return;
      void extra.sendNotification({ method: 'notifications/progress', params: { ...progress, progressToken } })
        .catch((error) => { process.stderr.write(`MCP 进度转发失败：${error.message}\n`); });
    },
  }), true));
  const close = (reason = '', exitCode = 0) => {
    if (closed) return;
    closed = true; clearInterval(timer); state = 'disconnected';
    process.stdin.off('end', inputClosed);
    process.stdin.off('close', inputClosed);
    const deadline = setTimeout(() => process.exit(exitCode), 3000);
    deadline.unref();
    void report(reason).then(() => Promise.allSettled([server.close(), remote?.close()])).then((results) => {
      for (const result of results) if (result.status === 'rejected') process.stderr.write(`MCP 清理失败：${result.reason}\n`);
      process.exitCode = exitCode;
    });
  };
  const inputClosed = () => close();
  server.onclose = () => close();
  try { await server.connect(new StdioServerTransport()); }
  catch (error) { state = 'error'; await report(error.message); await remote?.close(); throw error; }
  process.stdin.once('end', inputClosed);
  process.stdin.once('close', inputClosed);
  process.once('SIGTERM', inputClosed);
  if (process.stdin.readableEnded || process.stdin.destroyed) { inputClosed(); return; }
  // The heartbeat also notices a restarted desktop (new descriptor) and reconnects before the next tool call.
  const heartbeat = async () => {
    try {
      const next = await readDescriptor(descriptorFile);
      if (remote && (next.origin !== descriptor.origin || next.token !== descriptor.token || next.generation !== descriptor.generation)) drop(remote);
    } catch { /* the desktop may be restarting; the next attempt reads it again */ }
    if (!remote && !closed) await attempt().catch(() => {});
    await report();
  };
  timer = setInterval(() => { void heartbeat(); }, 10_000);
  timer.unref();
}
