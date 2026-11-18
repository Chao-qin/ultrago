/**
 * Concurrency gate tests.
 *
 * Every failure mode here is a LEAK, and leaks do not announce themselves: a
 * slot that is taken and never given back does not throw, it just permanently
 * lowers the limit until the process restarts. So most of these assertions are
 * about the unwinding paths (abort mid-acquire, double release) rather than the
 * happy path.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createGate, createRateLimiter } from "./limits.js";

const never = new AbortController().signal;

/** Let every already-queued microtask run, so "is it still waiting?" is real. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Did this promise settle by now? Used to assert "still queued". */
async function pending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  promise.catch(() => {}); // an abort rejection must not become unhandled
  return (await Promise.race([promise.then(() => marker), settle().then(() => marker)])) === marker
    ? (await Promise.race([promise.then(() => false), settle().then(() => true)])) === true
    : false;
}

test("an unlimited gate never queues", async () => {
  const gate = createGate();
  const releases = await Promise.all(
    Array.from({ length: 50 }, () => gate.acquire([{ id: "c" }], never)),
  );
  assert.equal(gate.stats().global.queued, 0);
  releases.forEach((release) => release());
});

test("a channel limit admits up to N and queues the rest", async () => {
  const gate = createGate();
  const first = await gate.acquire([{ id: "c", limit: 2 }], never);
  await gate.acquire([{ id: "c", limit: 2 }], never);

  const third = gate.acquire([{ id: "c", limit: 2 }], never);
  assert.equal(await pending(third), true, "the third must wait");
  assert.deepEqual(gate.stats().channels.c, { active: 2, queued: 1 });

  first();
  await third; // releasing hands the slot straight over
  assert.deepEqual(gate.stats().channels.c, { active: 2, queued: 0 });
});

test("waiters are woken in FIFO order", async () => {
  const gate = createGate();
  const release = await gate.acquire([{ id: "c", limit: 1 }], never);

  const order: number[] = [];
  const queued = [1, 2, 3].map((n) =>
    gate.acquire([{ id: "c", limit: 1 }], never).then((r) => {
      order.push(n);
      return r;
    }),
  );
  await settle();

  // Release one at a time; each hand-off must pick the oldest waiter.
  let current = release;
  for (let i = 0; i < 3; i += 1) {
    current();
    current = await queued[i];
  }
  current();
  assert.deepEqual(order, [1, 2, 3], "LIFO here would starve the oldest request");
});

test("aborting while queued rejects with the caller's own reason and leaves no waiter", async () => {
  const gate = createGate();
  const release = await gate.acquire([{ id: "c", limit: 1 }], never);

  const controller = new AbortController();
  const queued = gate.acquire([{ id: "c", limit: 1 }], controller.signal);
  await settle();
  assert.equal(gate.stats().channels.c.queued, 1);

  const reason = new Error("request budget exhausted");
  controller.abort(reason);
  await assert.rejects(queued, (error: unknown) => error === reason);
  // The waiter must be gone, not just rejected — otherwise the next release
  // hands its slot to a request nobody is waiting for, and that slot is lost.
  assert.deepEqual(gate.stats().channels.c, { active: 1, queued: 0 });

  release();
  const after = await gate.acquire([{ id: "c", limit: 1 }], never);
  assert.equal(gate.stats().channels.c.active, 1);
  after();
});

test("an already-aborted signal is refused before taking anything", async () => {
  const gate = createGate(4);
  const controller = new AbortController();
  controller.abort(new Error("gone"));
  await assert.rejects(gate.acquire([{ id: "c", limit: 2 }], controller.signal));
  assert.equal(gate.stats().global.active, 0);
  assert.equal(gate.stats().channels.c, undefined);
});

test("aborting BETWEEN the two gates does not leak the channel slot", async () => {
  // The exact shape of the leak this guards: channel slot taken, global slot
  // still being waited on, request dies. Without the unwind in acquire(), the
  // channel would throttle itself to zero over time with no error anywhere.
  const gate = createGate(1);
  const holder = await gate.acquire([{ id: "other" }], never);

  const controller = new AbortController();
  const queued = gate.acquire([{ id: "c", limit: 2 }], controller.signal);
  await settle();
  assert.equal(gate.stats().channels.c.active, 1, "channel slot is held while waiting on global");

  controller.abort(new Error("gone"));
  await assert.rejects(queued);
  assert.deepEqual(gate.stats().channels.c, { active: 0, queued: 0 }, "channel slot returned");

  holder();
  const again = await gate.acquire([{ id: "c", limit: 2 }], never);
  assert.equal(gate.stats().channels.c.active, 1);
  again();
});

test("release is idempotent — the retry path can unwind twice", async () => {
  const gate = createGate(2);
  const release = await gate.acquire([{ id: "c", limit: 1 }], never);
  release();
  release();
  release();
  assert.deepEqual(gate.stats().global, { active: 0, queued: 0 });
  assert.deepEqual(gate.stats().channels.c, { active: 0, queued: 0 });
});

test("the global limit bounds every channel together", async () => {
  const gate = createGate(2);
  const a = await gate.acquire([{ id: "a", limit: 10 }], never);
  await gate.acquire([{ id: "b", limit: 10 }], never);

  const third = gate.acquire([{ id: "c", limit: 10 }], never);
  assert.equal(await pending(third), true, "global cap applies across channels");
  assert.equal(gate.stats().global.active, 2);

  a();
  const released = await third;
  assert.equal(gate.stats().global.active, 2);
  released();
});

test("channels without a declared limit still obey the global one", async () => {
  const gate = createGate(1);
  const held = await gate.acquire([{ id: "free" }], never);
  const queued = gate.acquire([{ id: "free" }], never);
  assert.equal(await pending(queued), true);
  held();
  (await queued)();
});

// --- 每分钟请求数 -------------------------------------------------------

test("RPM：额度内放行，超出返回还要等几秒", () => {
  const limiter = createRateLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i += 1) {
    assert.equal(limiter.take("k", 3, t0 + i), undefined, `第 ${i + 1} 发该放行`);
  }
  // 第 4 发超限。最早那一发（t0）在 t0+60000 滑出窗口，所以还要等 60 秒。
  assert.equal(limiter.take("k", 3, t0 + 3), 60);
});

test("RPM：窗口滑过去就自动恢复", () => {
  const limiter = createRateLimiter();
  const t0 = 1_000_000;
  limiter.take("k", 1, t0);
  assert.ok(limiter.take("k", 1, t0 + 59_000), "还在窗口内");
  // 固定窗口会在这里给出双倍额度；滑动窗口只放行滑出去的那一发。
  assert.equal(limiter.take("k", 1, t0 + 60_001), undefined);
});

test("RPM：被挡住的那一发不计入窗口，否则会「越撞越久」", () => {
  const limiter = createRateLimiter();
  const t0 = 1_000_000;
  limiter.take("k", 1, t0);
  // 连撞三次。若每次都记账，窗口会被一直续着，等待时间越拖越长。
  limiter.take("k", 1, t0 + 10_000);
  limiter.take("k", 1, t0 + 20_000);
  const wait = limiter.take("k", 1, t0 + 30_000);
  // 仍然只需等到最早那一发（t0）滑出，即 30 秒后。
  assert.equal(wait, 30);
});

test("RPM：不同 key 各算各的", () => {
  const limiter = createRateLimiter();
  const t0 = 1_000_000;
  assert.equal(limiter.take("a", 1, t0), undefined);
  assert.equal(limiter.take("b", 1, t0), undefined, "b 不该被 a 的额度影响");
  assert.ok(limiter.take("a", 1, t0 + 1));
});

// --- 三层闸（key / 渠道 / 全局）-----------------------------------------

test("key 那一层能单独挡住一个调用方，不影响别人", async () => {
  const gate = createGate();
  const mine = () => gate.acquire([{ id: "key:me", limit: 1 }, { id: "chan" }], never);
  const held = await mine();
  const queued = mine();
  assert.equal(await pending(queued), true, "同一把 key 的第二发要排队");

  // 另一把 key 打同一条渠道，不受影响。
  const other = await gate.acquire([{ id: "key:other", limit: 1 }, { id: "chan" }], never);
  other();

  held();
  (await queued)();
});

test("三层里任意一层中途 abort，前面拿到的都要还回去", async () => {
  // 全局只剩 0 个名额，于是请求会卡在最后一层，而 key 层和渠道层已经拿到了。
  const gate = createGate(1);
  const holder = await gate.acquire([{ id: "other" }], never);

  const controller = new AbortController();
  const queued = gate.acquire(
    [{ id: "key:k", limit: 2 }, { id: "chan", limit: 2 }],
    controller.signal,
  );
  await settle();
  assert.equal(gate.stats().channels["key:k"].active, 1);
  assert.equal(gate.stats().channels.chan.active, 1);

  controller.abort(new Error("gone"));
  await assert.rejects(queued);
  assert.equal(gate.stats().channels["key:k"].active, 0, "key 层的名额要还");
  assert.equal(gate.stats().channels.chan.active, 0, "渠道层的名额也要还");
  holder();
});
