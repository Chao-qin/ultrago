import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { paramSpecsToJsonSchema, jsonSchemaToParamSpecs, SCHEMA_REF_KEYWORD } from "./param-schema-bridge.js";
import { resolveParamSchema, validateParams } from "./param-runtime.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BOOKS = resolve(ROOT, "resource/playbooks");

function allSpecs(): Array<{ book: string; specs: any[] }> {
  return readdirSync(BOOKS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ book: f, specs: JSON.parse(readFileSync(resolve(BOOKS, f), "utf8")).params ?? [] }))
    .filter((b) => b.specs.length > 0);
}

test("每本书的 ParamSpec[] 往返后深度相等", () => {
  const books = allSpecs();
  assert.ok(books.length >= 5, `期望至少 5 本带 params 的书，实际 ${books.length}`);
  let total = 0;
  for (const { book, specs } of books) {
    const back = jsonSchemaToParamSpecs(paramSpecsToJsonSchema(specs, book));
    assert.deepEqual(back, specs, `${book} 往返后不等`);
    total += specs.length;
  }
  // A census pin, not an invariant: it fires when a book gains a parameter, so
  // somebody confirms the new one round-trips instead of assuming it does.
  //
  // It last fired for the two books added 2026-09-08 — doudian-image-text-publish
  // (11 params) and doudian-after-watch-config (5). Both landed without moving
  // this pin, so `pnpm -r test` was red on master from that day until 2026-09-09;
  // the same two commits also skipped `pnpm playbooks:generate`, leaving
  // generated/ 442 lines stale. One missed post-authoring step, two red gates —
  // which is the point of pinning a census rather than asserting an invariant.
  // Round-trip for all 16 new specs confirmed by the deepEqual above before the
  // pin moved 15 → 29. Before that, doudian-freight-templates' `reportFile`
  // (string + default + description); before that, the doudian publish book's
  // `title` / `mainImages`.
  //
  // 2026-09-20: 30 → 31 for doudian-after-watch-config's new `listPage`. It points
  // the same book at the short-video list instead of the image-text one, after a
  // live check showed both share one after-watch drawer, one product picker
  // (`input[placeholder="请输入商品ID/商品名称"]`) and one commit_v2 endpoint — so only
  // the list entry and its readiness gate differ; every picker/submit step is
  // reused verbatim. Its round-trip is covered by the deepEqual above.
  //
  // 2026-09-21: 31 → 32. `listPage` became `entryUrl` (a full URL, no count change)
  // and `scene` was added, opening the same book to the third path: 达人视频 under
  // compass (`/ffa/mcompass/search/video`). That page is NOT under content-tool, so a
  // path fragment could no longer address it; and its row keeps the same button after
  // submit, so "already configured" there must read the status column instead. Both
  // new specs round-trip via the deepEqual above.
  assert.equal(total, 32, `期望 32 个 ParamSpec，实际 ${total}`);
});

test("defaultTemplate 被保留（实测 2/32 在用）", () => {
  const withTpl = allSpecs().flatMap((b) => b.specs).filter((s) => s.defaultTemplate !== undefined);
  assert.equal(withTpl.length, 2, `期望 2 个带 defaultTemplate，实际 ${withTpl.length}`);
  for (const spec of withTpl) {
    const [back] = jsonSchemaToParamSpecs(paramSpecsToJsonSchema([spec]));
    assert.equal(back.defaultTemplate, spec.defaultTemplate);
  }
});

test("spec.default 与 spec.schema.default 并存时 fail-closed 抛错（而不是静默丢弃嵌套那个）", () => {
  const spec = { name: "bar", required: false, default: "top", schema: { type: "string", default: "nested" } };
  assert.throws(
    () => paramSpecsToJsonSchema([spec as any]),
    (err: unknown) => err instanceof Error && err.message.includes("bar") && err.message.includes("default"),
    "应抛出包含 spec 名 'bar' 与冲突键名 'default' 的错误",
  );
});

test("spec.schema.description 与顶层 description 键冲突时 fail-closed 抛错（而不是被误提到顶层）", () => {
  const spec = { name: "baz", required: true, schema: { type: "string", description: "inner" } };
  assert.throws(
    () => paramSpecsToJsonSchema([spec as any]),
    (err: unknown) => err instanceof Error && err.message.includes("baz") && err.message.includes("description"),
    "应抛出包含 spec 名 'baz' 与冲突键名 'description' 的错误",
  );
});

test("spec.schema: {} 往返后 schema 字段消失是无害的规范化，不是有损（所有消费方走 spec.schema?.xxx 可选链，{} 与缺失同义）", () => {
  const spec = { name: "qux", required: false, schema: {} };
  const [back] = jsonSchemaToParamSpecs(paramSpecsToJsonSchema([spec as any]));
  assert.equal(back.schema, undefined, "空 schema 对象应规范化为 undefined，而不是保留为 {}");
});

test("字段 description 和固定版本 schemaRef 往返保留", () => {
  const specs = [{ name: "product", required: true, description: "商品数据", schemaRef: { name: "canonical-product", version: 1 } }];
  const doc = paramSpecsToJsonSchema(specs);
  assert.deepEqual(doc.properties.product, { description: "商品数据", [SCHEMA_REF_KEYWORD]: { name: "canonical-product", version: 1 } });
  assert.deepEqual(jsonSchemaToParamSpecs(doc), specs);
});

test("schemaRef 和内联 schema 冲突，且缺失引用不会退化成未声明", () => {
  const ref = { name: "missing", version: 1 };
  assert.equal(resolveParamSchema({ name: "value", required: true, schemaRef: ref }).status, "missing");
  assert.deepEqual(resolveParamSchema({ name: "value", required: true, schemaRef: ref }).schema, null);
  assert.equal(validateParams([{ name: "value", required: false, schemaRef: ref }], { value: "x" }).length, 1);
  assert.equal(resolveParamSchema({ name: "value", required: true, schema: { type: "string" }, schemaRef: ref }).status, "conflict");
  assert.throws(() => paramSpecsToJsonSchema([{ name: "value", required: true, schema: { type: "string" }, schemaRef: ref }]));
});

test("旧的未固定 schemaRef 可以读取，供保存时升级", () => {
  const specs = jsonSchemaToParamSpecs({ properties: { value: { [SCHEMA_REF_KEYWORD]: { name: "legacy" } } } } as any);
  assert.deepEqual(specs[0].schemaRef, { name: "legacy" });
  assert.equal(resolveParamSchema(specs[0], () => ({ type: "string" })).status, "resolved");
});
