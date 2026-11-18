/**
 * The dedup guarantees, pinned.
 *
 * These are the scenarios .agent/learn.md 2026-07-21 describes: the backend
 * resends an in-flight RPC after a reconnect, and the service worker may have
 * been recycled in between. Neither had an automated test until now — the
 * commit that introduced dedup was verified by hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcMethod } from "@bcp/shared";
import { createRpcDeduper, type DedupStore } from "./rpc-dedup";

/** In-memory stand-in for chrome.storage.session, shared across "recycles". */
function fakeStore(): DedupStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(k) {
      return k in data ? { [k]: data[k] } : {};
    },
    async set(items) {
      Object.assign(data, items);
    },
  };
}

const MUTATING = new Set<RpcMethod>([RpcMethod.Click, RpcMethod.Navigate]);
const isMutating = (m: RpcMethod): boolean => MUTATING.has(m);

function counting(result: ExecShape = { ok: true, result: "done" }) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    dispatch: async () => {
      calls++;
      return result;
    },
  };
}
type ExecShape = { ok: true; result: unknown } | { ok: false; error: string };

test("同一个 id 重复送达，只真正执行一次", async () => {
  const store = fakeStore();
  const spy = counting();
  const d = createRpcDeduper({ store, dispatch: spy.dispatch, isMutating });

  const a = await d.runOnce("r1", RpcMethod.Click, { ref: "e1" });
  const b = await d.runOnce("r1", RpcMethod.Click, { ref: "e1" });

  assert.equal(spy.calls, 1, "第二次送达不该再点一下");
  assert.deepEqual(a, b);
});

test("并发送达的同一个 id 也只执行一次（同步占位）", async () => {
  const store = fakeStore();
  let calls = 0;
  const d = createRpcDeduper({
    store,
    isMutating,
    dispatch: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true as const, result: "done" };
    },
  });

  // Both start in the same tick — the slot must be reserved before any await,
  // or the second call slips through while the first is checking storage.
  const [x, y] = await Promise.all([
    d.runOnce("r2", RpcMethod.Click, {}),
    d.runOnce("r2", RpcMethod.Click, {}),
  ]);

  assert.equal(calls, 1, "并发的第二次不该穿透");
  assert.deepEqual(x, y);
});

test("SW 被回收后重放：持久化结果短路，不会重复执行", async () => {
  const store = fakeStore();
  const first = counting({ ok: true, result: "clicked" });
  const before = createRpcDeduper({ store, dispatch: first.dispatch, isMutating });
  const original = await before.runOnce("r3", RpcMethod.Click, { ref: "e1" });
  assert.equal(first.calls, 1);

  // A recycle: brand-new deduper, empty in-memory map, same session storage.
  const second = counting({ ok: true, result: "clicked AGAIN" });
  const after = createRpcDeduper({ store, dispatch: second.dispatch, isMutating });
  const replayed = await after.runOnce("r3", RpcMethod.Click, { ref: "e1" });

  assert.equal(second.calls, 0, "回收后重放又点了一次 —— 这正是 learn.md 2026-07-21 的故障");
  assert.deepEqual(replayed, original);
});

test("读操作不写持久层：重放会重跑，但那是无害且更省的", async () => {
  const store = fakeStore();
  const first = counting({ ok: true, result: "snap-1" });
  const before = createRpcDeduper({ store, dispatch: first.dispatch, isMutating });
  await before.runOnce("r4", RpcMethod.Snapshot, {});

  assert.deepEqual(store.data, {}, "读不该占用 session storage");

  const second = counting({ ok: true, result: "snap-2" });
  const after = createRpcDeduper({ store, dispatch: second.dispatch, isMutating });
  const replayed = await after.runOnce("r4", RpcMethod.Snapshot, {});

  assert.equal(second.calls, 1, "读在回收后重跑是预期行为");
  assert.deepEqual(replayed, { ok: true, result: "snap-2" });
});

test("storage 抛错时降级为纯内存去重，而不是让调用失败", async () => {
  const broken: DedupStore = {
    async get() {
      throw new Error("storage unavailable");
    },
    async set() {
      throw new Error("storage full");
    },
  };
  const spy = counting();
  const d = createRpcDeduper({ store: broken, dispatch: spy.dispatch, isMutating });

  const a = await d.runOnce("r5", RpcMethod.Click, {});
  const b = await d.runOnce("r5", RpcMethod.Click, {});

  assert.equal(spy.calls, 1, "内存层仍应生效");
  assert.deepEqual(a, b);
});

test("内存表按上限淘汰最旧的，不会无限增长", async () => {
  const store = fakeStore();
  const spy = counting();
  const d = createRpcDeduper({ store, dispatch: spy.dispatch, isMutating, cap: 3 });

  // Reads, so nothing is persisted and only the in-memory layer is in play.
  for (const id of ["a", "b", "c", "d"]) await d.runOnce(id, RpcMethod.Snapshot, {});
  assert.equal(spy.calls, 4);

  // "a" was evicted, so it re-executes; "d" is still cached.
  await d.runOnce("a", RpcMethod.Snapshot, {});
  assert.equal(spy.calls, 5, "被淘汰的条目应重新执行");
  await d.runOnce("d", RpcMethod.Snapshot, {});
  assert.equal(spy.calls, 5, "未被淘汰的条目不该重新执行");
});
