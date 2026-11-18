/**
 * v5 handshake tests — hello(kind, instanceId, artifactHash) → welcome →
 * ready → connected. Verifies the instance-identity gate: an extension
 * without a valid instanceId, or with a wrong token, is rejected with the
 * structured error and its setup waiter fails fast instead of timing out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "@bcp/shared";

// Configure BEFORE importing config-dependent modules (config reads env once).
const TEST_PORT = 21000 + Math.floor(Math.random() * 1000);
process.env.BCP_PORT = String(TEST_PORT);
process.env.BCP_TOKEN = "test-token";

const { WsServer } = await import("./ws-server.js");

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("hello → welcome → ready → connected (happy path)", async () => {
  const server = new WsServer();
  try {
    await sleep(200); // let the WS server bind
    const target = { kind: "chrome" as const, instanceId: "test-inst-1" };
    const readyPromise = server.waitForReady(target, 5_000);

    const ws = await connect(server.boundPort);
    ws.send(JSON.stringify({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      role: "extension",
      token: "test-token",
      clientInfo: { name: "ultrago-ext", version: "0.1.0", artifactHash: "abc123" },
      browser: "chrome",
      instanceId: "test-inst-1",
    }));

    const welcome = await nextMessage(ws);
    assert.equal(welcome.type, "welcome");
    assert.equal(welcome.browser, "chrome");
    assert.equal(welcome.instanceId, "test-inst-1");
    assert.equal(welcome.protocolVersion, PROTOCOL_VERSION);
    assert.equal(typeof welcome.sessionId, "string");

    // Not connected until ready.
    assert.equal(server.isReady(target), false);

    ws.send(JSON.stringify({ type: "ready", instanceId: "test-inst-1", sessionId: welcome.sessionId }));

    const session = await readyPromise;
    assert.equal(session.target.instanceId, "test-inst-1");
    assert.equal(server.isReady(target), true);
    assert.equal(server.current()?.instanceId, "test-inst-1"); // became default

    const ext = server.extensionInfo(target);
    assert.equal(ext?.artifactHash, "abc123");
    ws.close();
  } finally {
    await server.close();
  }
});

test("wrong token → auth_rejected, waiter fails fast", async () => {
  const server = new WsServer();
  try {
    await sleep(200);
    const target = { kind: "chrome" as const, instanceId: "test-inst-2" };
    const waiter = server.waitForReady(target, 10_000).then(
      () => "resolved",
      (e: Error) => `rejected:${e.message}`,
    );
    const ws = await connect(server.boundPort);
    ws.send(JSON.stringify({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      role: "extension",
      token: "WRONG",
      browser: "chrome",
      instanceId: "test-inst-2",
    }));
    const outcome = await waiter;
    assert.match(outcome, /auth_rejected/);
    ws.close();
  } finally {
    await server.close();
  }
});

test("missing instanceId → protocol_incompatible (old extensions fail closed)", async () => {
  const server = new WsServer();
  try {
    await sleep(200);
    const ws = await connect(server.boundPort);
    ws.send(JSON.stringify({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      role: "extension",
      token: "test-token",
      browser: "chrome",
      // NO instanceId — v4-style extension
    }));
    const reply = await nextMessage(ws);
    assert.equal(reply.type, "reject");
    assert.match(String(reply.reason), /instanceId/);
    // Nothing may enter the connected set.
    assert.equal(server.isReady({ kind: "chrome", instanceId: "anything" }), false);
    ws.close();
  } finally {
    await server.close();
  }
});

test("ready with mismatched sessionId → target_mismatch, not connected", async () => {
  const server = new WsServer();
  try {
    await sleep(200);
    const target = { kind: "chrome" as const, instanceId: "test-inst-3" };
    const ws = await connect(server.boundPort);
    ws.send(JSON.stringify({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      role: "extension",
      token: "test-token",
      browser: "chrome",
      instanceId: "test-inst-3",
    }));
    const welcome = await nextMessage(ws);
    // Wrong sessionId (a stale socket's ready must never activate).
    ws.send(JSON.stringify({ type: "ready", instanceId: "test-inst-3", sessionId: "bogus" }));
    const reply = await nextMessage(ws);
    assert.equal(reply.type, "reject");
    assert.match(String(reply.reason), /ready mismatch/);
    assert.equal(server.isReady(target), false);
    ws.close();
  } finally {
    await server.close();
  }
});

test("协议版本不匹配：拒绝握手,并告诉人该跑什么命令", async () => {
  // 这条路径此前没有测试覆盖 —— 而它正是 v7 存在的理由：bcpWait 活在注入函数内部,
  // RPC 形状没变,所以除了握手没有任何地方能拦住一个装着旧扩展的浏览器。
  const server = new WsServer();
  try {
    await sleep(200);
    const ws = await connect(server.boundPort);
    ws.send(JSON.stringify({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION - 1, // 旧扩展
      role: "extension",
      token: "test-token",
      clientInfo: { name: "ultrago-ext", version: "0.1.0", artifactHash: "old" },
      browser: "chrome",
      instanceId: "stale-inst",
    }));

    const msg = await nextMessage(ws);
    assert.notEqual(msg.type, "welcome", "旧协议不得握手成功");
    const text = JSON.stringify(msg);
    assert.match(text, /protocol mismatch/, `应说明是协议不匹配: ${text}`);
    assert.match(text, new RegExp(`server ${PROTOCOL_VERSION}`), `应报出两侧版本: ${text}`);
    // 光说「不匹配」等于把诊断丢给人。失败必须自带下一步动作。
    assert.match(text, /pnpm build/, `应告诉人怎么修: ${text}`);
    assert.match(text, /reload the extension/, `应说明要重新加载扩展: ${text}`);

    assert.equal(server.isReady({ kind: "chrome", instanceId: "stale-inst" }), false);
  } finally {
    await server.close();
  }
});
