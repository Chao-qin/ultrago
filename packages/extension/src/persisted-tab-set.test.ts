/**
 * The rule that makes this type worth existing: hydrate before mutating.
 *
 * Persisting writes the whole set, so the failure mode is not "we lost an id"
 * but "we replaced the stored list with one id" — every other tab silently
 * stops being watched, and nothing surfaces it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPersistedTabSet, type SessionStore } from "./persisted-tab-set";

function fakeStore(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  let reads = 0;
  const store: SessionStore = {
    async get(k) {
      reads++;
      return k in data ? { [k]: data[k] } : {};
    },
    async set(items) {
      Object.assign(data, items);
    },
  };
  return { store, data, get reads() { return reads; } };
}

test("回收后往空集合里加一个 id，不会把存储里的其余 tab 抹掉", async () => {
  const f = fakeStore({ watchedTabs: [1, 2, 3] });
  // A fresh worker: brand-new set, empty in memory, storage still holds 1/2/3.
  const s = createPersistedTabSet("watchedTabs", f.store);

  await s.add(4);

  assert.deepEqual(f.data.watchedTabs, [1, 2, 3, 4], "只写进 [4] 就等于静默取消监视其余所有 tab");
});

test("hydrate 只读一次存储，重复调用共用同一次", async () => {
  const f = fakeStore({ watchedTabs: [1] });
  const s = createPersistedTabSet("watchedTabs", f.store);
  await Promise.all([s.hydrate(), s.hydrate(), s.hydrate()]);
  await s.hydrate();
  assert.equal(f.reads, 1);
});

test("已经在集合里的 id 不重复写存储", async () => {
  const f = fakeStore({ watchedTabs: [7] });
  const s = createPersistedTabSet("watchedTabs", f.store);
  await s.add(7);
  assert.deepEqual(f.data.watchedTabs, [7]);
  assert.equal(s.has(7), true);
});

test("负数 tabId 不入集合 —— 那是后台流量，不是某个 tab", async () => {
  const f = fakeStore();
  const s = createPersistedTabSet("captureTabs", f.store);
  await s.add(-1);
  assert.deepEqual(s.values(), []);
  assert.equal("captureTabs" in f.data, false, "不该为此写一次存储");
});

test("remove 报告它是否真的在集合里，并落盘", async () => {
  const f = fakeStore({ captureTabs: [5, 6] });
  const s = createPersistedTabSet("captureTabs", f.store);

  assert.equal(await s.remove(5), true);
  assert.deepEqual(f.data.captureTabs, [6]);
  assert.equal(await s.remove(99), false, "不在集合里就不该报告删掉了");
});

test("remove 之前也会 hydrate —— 否则删的是一个空集合", async () => {
  const f = fakeStore({ captureTabs: [5, 6] });
  const s = createPersistedTabSet("captureTabs", f.store);
  assert.equal(await s.remove(6), true, "没 hydrate 就会认为 6 不存在，然后把 [5] 也丢了");
  assert.deepEqual(f.data.captureTabs, [5]);
});

test("存储不可用时降级为本 worker 生命周期内有效，而不是抛错", async () => {
  const broken: SessionStore = {
    async get() {
      throw new Error("unavailable");
    },
    async set() {
      throw new Error("full");
    },
  };
  const s = createPersistedTabSet("watchedTabs", broken);
  await s.add(1);
  assert.equal(s.has(1), true);
});
