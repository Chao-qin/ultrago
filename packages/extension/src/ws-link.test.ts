import { test } from "node:test";
import assert from "node:assert/strict";
import { CONNECTING, OPEN, createWsLink, type SocketLike, type WsLinkDeps } from "./ws-link";

/** A real socket is CLOSED once it closes; a fake that forgets makes connect()
 *  think the link is still up and silently skip the reconnect. */
const CLOSED = 3;
import type { ConnState } from "./messaging";

function fakeSocket(state = CONNECTING): SocketLike & { sent: string[]; closed: boolean } {
  return {
    readyState: state,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    sent: [],
    closed: false,
    send(d) {
      this.sent.push(d);
    },
    close() {
      this.closed = true;
      this.readyState = CLOSED;
    },
  };
}

function harness(over: Partial<WsLinkDeps> = {}) {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const states: ConnState[] = [];
  const messages: unknown[] = [];
  let opens = 0;
  let failOpen: Error | null = null;

  const link = createWsLink(
    {
      url: () => "ws://127.0.0.1:8787",
      open: () => {
        if (failOpen) throw failOpen;
        const s = fakeSocket();
        sockets.push(s);
        return s;
      },
      onOpen: () => void opens++,
      onMessage: (m) => void messages.push(m),
      onState: (s) => void states.push(s),
      ...over,
    },
    { connectTimeoutMs: 30, backoffInitialMs: 10, backoffMaxMs: 40, backoffFactor: 2 },
  );
  return {
    link,
    sockets,
    states,
    messages,
    get opens() {
      return opens;
    },
    failOpen: (e: Error | null) => void (failOpen = e),
    last: () => sockets[sockets.length - 1],
    /** Close the current socket the way the platform does: state first, then event. */
    fireClose() {
      const s = sockets[sockets.length - 1];
      s.readyState = CLOSED;
      s.onclose?.();
    },
  };
}

test("已经连着的时候不重复建连", () => {
  const h = harness();
  h.link.connect();
  h.last().readyState = OPEN;
  h.link.connect();
  h.link.connect();
  assert.equal(h.sockets.length, 1);
});

test("正在连接中也不重复建连", () => {
  const h = harness();
  h.link.connect();
  assert.equal(h.last().readyState, CONNECTING);
  h.link.connect();
  assert.equal(h.sockets.length, 1);
});

test("构造 socket 抛错不会掀翻 worker，而是排一次重连", async () => {
  const h = harness();
  h.failOpen(new Error("bad url"));
  h.link.connect();
  assert.equal(h.sockets.length, 0);

  h.failOpen(null);
  await new Promise((r) => setTimeout(r, 25)); // 退避 10ms
  assert.equal(h.sockets.length, 1, "构造失败之后没有再试");
});

test("原生 WebSocket 没有连接超时 —— 卡在 CONNECTING 的要被掐掉", async () => {
  const h = harness();
  h.link.connect();
  assert.equal(h.last().closed, false);
  await new Promise((r) => setTimeout(r, 45)); // 连接超时 30ms
  assert.equal(h.last().closed, true, "否则一次挂死的连接会占住这条链路好几分钟");
});

test("连上之后不再掐 —— 超时定时器要清掉", async () => {
  const h = harness();
  h.link.connect();
  const s = h.last();
  s.readyState = OPEN;
  s.onopen?.();
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(s.closed, false, "已经连上的 socket 被连接超时掐了");
  assert.equal(h.opens, 1);
});

test("断开后按退避重连，且逐次拉长到上限", async () => {
  const h = harness();
  h.link.connect();
  assert.equal(h.link.backoffMs(), 10);

  h.fireClose();
  assert.equal(h.link.backoffMs(), 20, "10 → 20");
  await new Promise((r) => setTimeout(r, 15));
  h.fireClose();
  assert.equal(h.link.backoffMs(), 40, "20 → 40");
  await new Promise((r) => setTimeout(r, 45));
  h.fireClose();
  assert.equal(h.link.backoffMs(), 40, "封顶在 40，不再往上");
});

test("握手成功才重置退避 —— socket 打开本身不算数", async () => {
  const h = harness();
  h.link.connect();
  h.fireClose();
  assert.equal(h.link.backoffMs(), 20);

  await new Promise((r) => setTimeout(r, 25)); // 退避到期，重连并打开
  h.last().readyState = OPEN;
  h.last().onopen?.();
  assert.equal(
    h.link.backoffMs(),
    20,
    "只是连上了还不能重置：被拒绝的连接也会先打开再关掉，在那里重置就会贴着地板空转",
  );

  h.link.handshakeComplete(); // 后端 welcome 到达，握手真的成了
  assert.equal(h.link.backoffMs(), 10);
  assert.equal(h.link.state(), 'connected', '新打开的面板必须读到握手后的真实状态');
  assert.equal(h.states.at(-1), h.link.state(), '推送与快照不能分叉');
});

test('握手状态只能在当前 socket 已打开时确认', () => {
  const h = harness();
  h.link.handshakeComplete();
  assert.equal(h.link.state(), 'disconnected');
  h.link.connect();
  h.link.handshakeComplete();
  assert.equal(h.link.state(), 'connecting');
});

test("重连不会叠加 —— 已经排了一个就不再排", async () => {
  const h = harness();
  h.link.connect();
  const s = h.last();
  h.fireClose();
  h.fireClose();
  h.fireClose();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.sockets.length, 2, "三次 close 只该产生一次重连");
});

test("主动 connect 会取消排队中的重连，不留下野定时器", async () => {
  const h = harness();
  h.link.connect();
  h.fireClose();
  h.link.connect(); // 立刻手动重连
  const n = h.sockets.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.sockets.length, n, "排队中的那次应当被取消，否则会多建一条连接");
});

test("状态流转对外可见：connecting → disconnected", () => {
  const h = harness();
  h.link.connect();
  assert.deepEqual(h.states, ["connecting"]);
  h.fireClose();
  assert.deepEqual(h.states, ["connecting", "disconnected"]);
  assert.equal(h.link.state(), "disconnected");
});

test("没连上时 send 返回 false 而不是假装发出去了", () => {
  const h = harness();
  assert.equal(h.link.send({ type: "event" }), false);
  h.link.connect();
  assert.equal(h.link.send({ type: "event" }), false, "CONNECTING 也不能发");
  h.last().readyState = OPEN;
  assert.equal(h.link.send({ type: "event" }), true);
  assert.deepEqual(h.last().sent, ['{"type":"event"}']);
});

test("读不懂的帧被静默忽略，不影响连接", () => {
  const h = harness();
  h.link.connect();
  h.last().onmessage?.({ data: "not json{" });
  assert.deepEqual(h.messages, []);
  h.last().onmessage?.({ data: '{"type":"ping","t":1}' });
  assert.deepEqual(h.messages, [{ type: "ping", t: 1 }]);
});

test("每次重连都重新读 url —— 改了设置要能生效", async () => {
  let url = "ws://old/";
  const h = harness({ url: () => url });
  h.link.connect();
  url = "ws://new/";
  h.fireClose();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.sockets.length, 2);
});

test("reset：拆掉当前连接且不排退避，立刻从地板重连", async () => {
  const h = harness();
  h.link.connect();
  h.fireClose(); // 退避涨到 20
  assert.equal(h.link.backoffMs(), 20);

  h.link.reset();
  assert.equal(h.link.backoffMs(), 10, "强制重连要从地板开始");
  assert.equal(h.sockets.length, 2, "应当立刻建新连接，而不是等退避");

  const before = h.sockets.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.sockets.length, before, "旧 socket 的 onclose 被摘掉了，不该再排一次重连");
});

test("isOpen 只在真的 OPEN 时为真", () => {
  const h = harness();
  assert.equal(h.link.isOpen(), false);
  h.link.connect();
  assert.equal(h.link.isOpen(), false, "CONNECTING 不算");
  h.last().readyState = OPEN;
  assert.equal(h.link.isOpen(), true);
});
