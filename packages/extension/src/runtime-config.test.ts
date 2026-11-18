import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureLocalInstanceId, loadRuntimeConfig, type IdentityDeps } from "./runtime-config";

function deps(over: Partial<IdentityDeps> = {}): IdentityDeps & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    getURL: (p) => `chrome-extension://x/${p}`,
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    store: {
      async get(k) {
        return k in data ? { [k]: data[k] } : {};
      },
      async set(items) {
        Object.assign(data, items);
      },
    },
    randomId: () => "generated-id",
    ...over,
  };
}

test("读到打包进产物的 runtime-config", async () => {
  const d = deps({ fetch: async () => ({ ok: true, json: async () => ({ instanceId: "inst-7" }) }) });
  assert.deepEqual(await loadRuntimeConfig(d), { instanceId: "inst-7" });
});

test("没有这个文件（裸 dev 构建）时返回 null，而不是抛错", async () => {
  assert.equal(await loadRuntimeConfig(deps()), null);
});

test("config 里 instanceId 缺失或为空 → 视为无效", async () => {
  for (const bad of [{}, { instanceId: "" }, { instanceId: 42 }]) {
    const d = deps({ fetch: async () => ({ ok: true, json: async () => bad }) });
    assert.equal(await loadRuntimeConfig(d), null, `${JSON.stringify(bad)} 不该被接受`);
  }
});

test("fetch 抛错也只是「没有」，不冒泡", async () => {
  const d = deps({
    fetch: async () => {
      throw new Error("net");
    },
  });
  assert.equal(await loadRuntimeConfig(d), null);
});

test("dev 兜底 id 生成后落盘，下次沿用同一个", async () => {
  const d = deps();
  const first = await ensureLocalInstanceId(d);
  assert.equal(first, "generated-id");
  assert.equal(d.data.bcpInstanceId, "generated-id");

  const again = await ensureLocalInstanceId({ ...d, randomId: () => "different-id" });
  assert.equal(again, "generated-id", "已存过就该沿用，否则每次回收都换身份");
});

test("存储不可用时仍给出一个临时 id，而不是让启动失败", async () => {
  const d = deps({
    store: {
      async get() {
        throw new Error("unavailable");
      },
      async set() {
        throw new Error("full");
      },
    },
  });
  assert.equal(await ensureLocalInstanceId(d), "generated-id");
});
