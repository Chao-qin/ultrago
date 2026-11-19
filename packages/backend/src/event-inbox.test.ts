/**
 * EventInbox: an event is shown to an agent once, a reply about one tab never
 * swallows another tab's events, and wait_for_event finds what the agent's last
 * action caused — but not stale history.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventStore } from "./event-store.js";
import { EventInbox } from "./event-inbox.js";

const push = (store: EventStore, tabId: number, kind: "dialog" | "navigation" | "browser_online" = "dialog"): number => {
  store.push({ kind, tabId, ts: Date.now(), summary: `${kind} on ${tabId}` });
  return store.latestSeq();
};
const onTab = (tab: number) => (e: { tabId: number }) => e.tabId === tab;
const any = () => true;

test("a reply shows an event once", () => {
  const store = new EventStore();
  const inbox = new EventInbox(store);
  push(store, 1);
  assert.equal(inbox.take(onTab(1)).length, 1);
  assert.equal(inbox.take(onTab(1)).length, 0, "already shown");
});

test("a reply about tab 1 leaves tab 2's events unseen", () => {
  const store = new EventStore();
  const inbox = new EventInbox(store);
  push(store, 2);
  push(store, 1);
  assert.deepEqual(inbox.take(onTab(1)).map((e) => e.tabId), [1]);
  assert.deepEqual(inbox.unshown(any).map((e) => e.tabId), [2]);
  assert.deepEqual(inbox.take(onTab(2)).map((e) => e.tabId), [2], "shown on the next reply about tab 2");
});

test("a session starts at the present: earlier events are neither unseen nor recent", () => {
  const store = new EventStore();
  push(store, 1, "browser_online"); // before the session connected
  const inbox = new EventInbox(store);
  const first = inbox.beginCall();
  assert.equal(inbox.unshown(any).length, 0);
  assert.equal(inbox.recent(any, first), undefined);
});

test("recent(): what arrived since the previous call began, not older history", () => {
  const store = new EventStore();
  const inbox = new EventInbox(store);
  inbox.beginCall(); // call 1
  const old = push(store, 2);
  inbox.beginCall(); // call 2 — the click
  const caused = push(store, 2); // the popup the click opened
  inbox.take(onTab(1)); // call 2's reply is about tab 1 and shows neither
  const waiting = inbox.beginCall(); // call 3 — wait_for_event on tab 2
  assert.equal(inbox.recent(onTab(2), waiting)?.seq, caused, "the event the last action caused is found at once");
  assert.equal(inbox.isEarlier(store.since(0).events.find((e) => e.seq === old)!, waiting), true, "older history is marked earlier");
  inbox.markShown([inbox.recent(onTab(2), waiting)!]);
  assert.equal(inbox.recent(onTab(2), waiting), undefined, "not returned twice");
});

test("overlapping calls each keep their own window", () => {
  const store = new EventStore();
  const inbox = new EventInbox(store);
  const a = inbox.beginCall();
  const during = push(store, 3);
  const b = inbox.beginCall(); // starts while A is still running
  assert.equal(inbox.recent(onTab(3), a)?.seq, during, "A's window is unchanged by B starting");
  assert.equal(inbox.recent(onTab(3), b)?.seq, during, "B's window opens when A (the call before it) began");
  const c = inbox.beginCall(); // starts after B began
  assert.equal(inbox.recent(onTab(3), c), undefined, "C's window opens when B began, after the event");
});

test("memory stays bounded by the store's buffer", () => {
  const store = new EventStore();
  const inbox = new EventInbox(store);
  push(store, 9); // never shown: pins the floor until it is evicted
  for (let i = 0; i < 1200; i++) {
    push(store, 1);
    inbox.take(onTab(1));
  }
  assert.ok((inbox as unknown as { shown: Set<number> }).shown.size <= 500, "shown seqs above the floor never exceed the buffer");
  assert.equal(inbox.unshown(onTab(9)).length, 0, "an evicted event is gone, not pending forever");
});
