import { test } from "node:test";
import assert from "node:assert/strict";
import { createNetLog } from "./net-log";
import type { NetworkRequest } from "@bcp/shared";

const req = (url: string): NetworkRequest =>
  ({ method: "GET", url, type: "xmlhttprequest", ts: 0, ok: true }) as NetworkRequest;

test("按 tab 分开记录，互不串", () => {
  const log = createNetLog();
  log.push(1, req("https://a/1"));
  log.push(2, req("https://b/1"));
  assert.deepEqual(log.get(1).map((r) => r.url), ["https://a/1"]);
  assert.deepEqual(log.get(2).map((r) => r.url), ["https://b/1"]);
});

test("超过上限后丢最旧的，保留尾部 —— 只有尾部有用", () => {
  const log = createNetLog(3);
  for (const n of [1, 2, 3, 4, 5]) log.push(1, req(`https://a/${n}`));
  assert.deepEqual(log.get(1).map((r) => r.url), ["https://a/3", "https://a/4", "https://a/5"]);
});

test("负数 tabId 不记 —— 那是后台流量，不属于任何 tab", () => {
  const log = createNetLog();
  log.push(-1, req("https://sw/x"));
  assert.deepEqual(log.get(-1), []);
});

test("没记录过的 tab 返回空数组，而不是 undefined", () => {
  assert.deepEqual(createNetLog().get(42), []);
});

test("forget 之后该 tab 干净了", () => {
  const log = createNetLog();
  log.push(1, req("https://a/1"));
  log.forget(1);
  assert.deepEqual(log.get(1), []);
});
