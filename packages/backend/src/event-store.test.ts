import { test } from "node:test";
import assert from "node:assert/strict";
import type { BrowserEvent } from "@bcp/shared";
import { EventStore } from "./event-store.js";

const challenge = (over: Partial<BrowserEvent> = {}): BrowserEvent => ({
  kind: "captcha_appeared",
  tabId: 12,
  ts: 1757400000000,
  browser: "chrome-1",
  summary: "possible challenge — x",
  detail: { evidence: ["x"], frameId: 0 },
  ...over,
});

test("onEvent: 每条事件都推给订阅者，且 seq 已经盖好", () => {
  const store = new EventStore();
  const seen: BrowserEvent[] = [];
  store.onEvent((e) => seen.push(e));
  store.push(challenge());
  store.push(challenge({ kind: "navigation", summary: "→ https://x" }));
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((e) => e.seq), [1, 2]);
});

test("onEvent: 抛异常的订阅者不影响其它订阅者，也不影响 push 本身", () => {
  const store = new EventStore();
  const seen: string[] = [];
  store.onEvent(() => {
    throw new Error("boom");
  });
  store.onEvent((e) => seen.push(e.kind));
  assert.doesNotThrow(() => store.push(challenge()));
  assert.deepEqual(seen, ["captcha_appeared"]);
  // 事件仍然进了 buffer
  assert.equal(store.since(0).events.length, 1);
});

test("onEvent: 退订后不再收到", () => {
  const store = new EventStore();
  let count = 0;
  const off = store.onEvent(() => count++);
  store.push(challenge());
  off();
  store.push(challenge({ tabId: 13 }));
  assert.equal(count, 1);
});
