import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  SCHEMA_NAME,
  SCHEMA_VERSION,
  SOURCE_FILE,
  stableStringify,
  syncPreprocessConfigRecord,
} from "./sync-preprocess-config.mjs";

const WANTED = {
  configId: "default",
  pricing: { strategy: "fixed_amount", markup: 10 },
  text: { replaceRules: [{ pattern: "某品牌", replacement: "", flags: "", description: "删占位词" }] },
};

/** Response-like stub: the script only reads ok / status / text(). */
const json = (body, ok = true, status = 200) => ({ ok, status, text: async () => JSON.stringify(body) });

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const parsed = new URL(url);
    const call = {
      method: init?.method ?? "GET",
      path: parsed.pathname,
      query: parsed.search,
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  };
  return { impl, calls };
}

const withSource = (impl, value = WANTED) => ({
  fetchImpl: impl,
  readFileImpl: async () => JSON.stringify(value),
});

test("SCHEMA_VERSION 与 register-schemas.mjs 的 manifest 保持一致", async () => {
  // 两个数字住在两个文件里，没有测试就会漂移 —— 与 Python 侧那条 const 对拍同理。
  const source = await readFile(new URL("./register-schemas.mjs", import.meta.url), "utf8");
  const at = source.indexOf(`name: "${SCHEMA_NAME}"`);
  assert.ok(at > 0, `manifest 里找不到 ${SCHEMA_NAME} 条目`);
  // manifest 里写的是 `version: 2,`（裸键，不带引号）；注释里没有这个形状，取第一处即它自己。
  const version = Number(/version:\s*(\d+)/.exec(source.slice(at))[1]);
  assert.equal(SCHEMA_VERSION, version, "改了一边漏改另一边");
});

test("目标版本没有记录时创建，并带上 schemaName / schemaVersion", async () => {
  const { impl, calls } = fakeFetch((call) => {
    if (call.method === "GET") return json([]);
    return json({ id: "rec-new" });
  });
  const result = await syncPreprocessConfigRecord(withSource(impl));

  assert.deepEqual(result, { id: "rec-new", name: SCHEMA_NAME, created: true, changed: true });
  const post = calls.find((c) => c.method === "POST");
  assert.ok(post, "应当 POST 创建");
  assert.deepEqual(post.body, { schemaName: SCHEMA_NAME, schemaVersion: SCHEMA_VERSION, data: WANTED });
  assert.equal(calls.some((c) => c.method === "PATCH"), false, "创建路径不该 PATCH");
});

test("内容一致时不动数据库（幂等）", async () => {
  const { impl, calls } = fakeFetch(() =>
    json([{ id: "rec-1", schemaVersion: SCHEMA_VERSION, data: JSON.stringify(WANTED) }]),
  );
  const result = await syncPreprocessConfigRecord(withSource(impl));

  assert.equal(result.changed, false);
  assert.equal(result.created, false);
  assert.equal(result.id, "rec-1");
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0, "一致时不该有任何写请求");
});

test("内容不同时 PATCH 覆盖，且只发 data", async () => {
  const { impl, calls } = fakeFetch((call) => {
    if (call.method === "GET") {
      return json([{ id: "rec-1", schemaVersion: SCHEMA_VERSION, data: JSON.stringify({ ...WANTED, configId: "old" }) }]);
    }
    return json({ id: "rec-1" });
  });
  const result = await syncPreprocessConfigRecord(withSource(impl));

  assert.equal(result.changed, true);
  const patch = calls.find((c) => c.method === "PATCH");
  assert.ok(patch, "应当 PATCH");
  assert.equal(patch.path, "/api/schema-records/rec-1");
  assert.deepEqual(Object.keys(patch.body), ["data"], "PATCH 只收 data");
  assert.deepEqual(patch.body.data, WANTED);
});

test("只是键顺序不同算一致 —— 不产生无谓的覆盖", async () => {
  const reordered = { text: WANTED.text, pricing: { markup: 10, strategy: "fixed_amount" }, configId: "default" };
  assert.equal(stableStringify(reordered), stableStringify(WANTED));
  const { impl, calls } = fakeFetch(() =>
    json([{ id: "rec-1", schemaVersion: SCHEMA_VERSION, data: JSON.stringify(reordered) }]),
  );
  const result = await syncPreprocessConfigRecord(withSource(impl));
  assert.equal(result.changed, false);
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0);
});

test("同版本存在多条时拒绝，而不是猜一条", async () => {
  const { impl, calls } = fakeFetch(() =>
    json([
      { id: "rec-1", schemaVersion: SCHEMA_VERSION, data: JSON.stringify(WANTED) },
      { id: "rec-2", schemaVersion: SCHEMA_VERSION, data: JSON.stringify(WANTED) },
    ]),
  );
  await assert.rejects(() => syncPreprocessConfigRecord(withSource(impl)), /存在 2 条/);
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0, "拒绝时不该写");
});

test("只对齐目标版本，更早版本的记录不参与", async () => {
  const { impl, calls } = fakeFetch((call) => {
    if (call.method === "GET") {
      return json([
        { id: "rec-old", schemaVersion: SCHEMA_VERSION - 1, data: JSON.stringify({ configId: "legacy" }) },
        { id: "rec-1", schemaVersion: SCHEMA_VERSION, data: JSON.stringify(WANTED) },
      ]);
    }
    return json({ id: "rec-1" });
  });
  const result = await syncPreprocessConfigRecord(withSource(impl));
  assert.equal(result.id, "rec-1");
  assert.equal(result.changed, false);
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0, "旧版本记录不该被写");
});

test("dry-run 只报告不写库", async () => {
  const { impl, calls } = fakeFetch(() => json([]));
  const result = await syncPreprocessConfigRecord({ ...withSource(impl), dryRun: true });
  assert.equal(result.created, true);
  assert.equal(result.changed, true);
  assert.ok(result.reason);
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0, "dry-run 不得写");
});

test("库里的 payload 不是合法 JSON 时按「不同」处理并修好", async () => {
  const { impl, calls } = fakeFetch((call) => {
    if (call.method === "GET") return json([{ id: "rec-1", schemaVersion: SCHEMA_VERSION, data: "{not json" }]);
    return json({ id: "rec-1" });
  });
  const result = await syncPreprocessConfigRecord(withSource(impl));
  assert.equal(result.changed, true);
  assert.ok(calls.find((c) => c.method === "PATCH"));
});

test("源文件路径指向仓库里的种子文件", () => {
  assert.equal(SOURCE_FILE, ".claude/skills/product-preprocess/product-preprocess-config.example.json");
});
