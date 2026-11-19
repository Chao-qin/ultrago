import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Playbook } from "@bcp/shared";
import { applyParamDefaults, fillSlots, instantiateSteps, validatePlaybookParams } from "./playbook.js";

test("playbook params keep typed values at the action boundary", () => {
  const schema = [
    { name: "limit", required: true, schema: { type: "integer", minimum: 1 } },
    { name: "enabled", required: true, schema: { type: "boolean" } },
  ];
  const values = applyParamDefaults(schema, { limit: "20", enabled: "false" }, {
    bookName: "book",
    runId: "run_1",
    planId: "plan_run_1",
    uuid: "uuid_1",
    timezone: "UTC",
  });

  assert.deepEqual(values, { limit: 20, enabled: false });
  assert.deepEqual(validatePlaybookParams(schema, values), []);
  assert.deepEqual(fillSlots({ limit: "{{limit}}", enabled: "{{enabled}}" }, values), {
    limit: 20,
    enabled: false,
  });
});

test("whole-value slots preserve structured params and inline slots interpolate scalars", () => {
  const payload = { count: 2, enabled: true };
  const values = { payload, items: ["a", "b"], conversationId: "conv_123" };

  assert.deepEqual(fillSlots({ payload: "{{payload}}", items: "{{items}}" }, values), { payload, items: ["a", "b"] });
  assert.deepEqual(fillSlots({ url: "https://www.doubao.com/chat/{{conversationId}}" }, values), {
    url: "https://www.doubao.com/chat/conv_123",
  });
});

test("inline structured slots become JSON literals for browser eval", () => {
  const specPricesV2 = [{
    sell_properties: [{ property_name: "颜色", value_name: "红色" }],
    price: 1900,
    stock_num: 12,
  }];

  assert.deepEqual(fillSlots({ code: "const rows = {{specPricesV2}};" }, { specPricesV2 }), {
    code: "const rows = [{\"sell_properties\":[{\"property_name\":\"颜色\",\"value_name\":\"红色\"}],\"price\":1900,\"stock_num\":12}];",
  });
});

test("nested slots address structured object fields", () => {
  assert.deepEqual(fillSlots({ attachments: "{{images.detail}}" }, { images: { main: [], detail: [{ url: "x" }], spec: [] } }), {
    attachments: [{ url: "x" }],
  });
});

test("unresolved inline slots fail closed", () => {
  assert.throws(() => fillSlots({ url: "https://example.test/{{missing}}" }, {}), /unresolved playbook slot: missing/);
});

test("dynamic playbook defaults use the real execution context", () => {
  const schema = [{
    name: "outFile",
    required: true,
    defaultTemplate: "{{bookName}}-{{runId}}-{{planId}}-{{uuid}}.md",
    schema: { type: "string", minLength: 1 },
  }];
  const values = applyParamDefaults(schema, {}, {
    bookName: "book",
    runId: "run_1",
    planId: "plan_run_1",
    uuid: "uuid_1",
    timezone: "UTC",
  });

  assert.equal(values.outFile, "book-run_1-plan_run_1-uuid_1.md");
  assert.ok(!String(values.outFile).includes("pending"));
});

test("invalid boolean input is rejected by the shared runtime", () => {
  const schema = [{ name: "enabled", required: true, schema: { type: "boolean" } }];
  const values = applyParamDefaults(schema, { enabled: "not-a-boolean" }, {
    bookName: "book",
    runId: "run_1",
    planId: "plan_run_1",
    uuid: "uuid_1",
  });
  assert.match(validatePlaybookParams(schema, values).join(";"), /must be boolean/);
});

test("doubao-ask accepts data params and contains no executable input slots", async () => {
  const playbook = JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "../../../resource/playbooks/doubao-ask.json"), "utf8")) as Playbook;
  assert.deepEqual(playbook.params?.map((p) => p.name), ["message", "conversationId", "attachments", "outputFile", "requireJson"]);
  assert.equal(playbook.params?.some((p) => p.name.endsWith("Code")), false);

  const values = applyParamDefaults(playbook.params, {
    message: "你好\"\\\n请回答",
    attachments: [],
  }, {
    bookName: "doubao-ask",
    runId: "run_1",
    planId: "plan_1",
    uuid: "uuid_1",
    timezone: "UTC",
  });
  assert.deepEqual(validatePlaybookParams(playbook.params, values), []);
  assert.match(String(values.outputFile), /^doubao-run_1-uuid_1\.json$/);
  // 按 action.method 定位而不是按 step 下标：下标会随 book 改版整体位移（2026-08-23
  // DOM 版换成 API 监听版时就位移过），而这里真正要验的是"参数被原样注入到对应动作"。
  const steps = instantiateSteps(playbook.steps, values);
  const by = (method: string) => steps.find((s) => s.action?.method === method);
  assert.equal(steps[0]?.action?.params.url, "https://www.doubao.com/chat/");
  assert.equal(by("browser.paste")?.action?.params.text, "你好\"\\\n请回答");
  assert.deepEqual(by("browser.upload")?.action?.params.attachments, []);
  assert.deepEqual(by("local.writeFile")?.action?.params, { path: values.outputFile, overwrite: "overwrite" });
});

// ── 占位符填到哪一层 ──────────────────────────────────────────────────────

test("a slot is filled however deeply it is nested", () => {
  // Every slot in this repo's books sits at the top level, so this changes none
  // of them. It exists because `verify.elementValue.equals` is two levels down,
  // and a book that types a parameterised string has to be able to assert that
  // the string arrived.
  const filled = fillSlots({ outer: { inner: { text: "{{who}}" } }, list: [{ text: "{{who}}" }] }, { who: "你好" });
  assert.deepEqual(filled, { outer: { inner: { text: "你好" } }, list: [{ text: "你好" }] });
});

test("a whole-slot value keeps its runtime type at depth, not just at the top", () => {
  // `[object Object]` is what the string path would have produced.
  const attachments = [{ type: "image", url: "https://example/a.jpg" }];
  const filled = fillSlots({ nested: { attachments: "{{files}}" } }, { files: attachments });
  assert.deepEqual((filled.nested as { attachments: unknown }).attachments, attachments);
});

test("verify is instantiated too, so a parameterised assertion asserts the value actually typed", () => {
  // Without this the pair is unsatisfiable: the step types whatever was passed
  // and then asserts the field equals one specific recorded sentence. The
  // alternative was dropping the assertion, which is not a weaker check — it is
  // no check, and a replay that verifies nothing reports success regardless of
  // what the page did.
  const steps = [
    { goal: "填写标题", action: { method: "browser.type", params: { text: "{{title}}" } }, verify: { elementValue: { name: "标题", equals: "{{title}}" } } },
  ] as unknown as Playbook["steps"];

  const [step] = instantiateSteps(steps, { title: "旋转小新汽车载摆件" });
  assert.equal(step.action!.params.text, "旋转小新汽车载摆件");
  assert.equal((step.verify as { elementValue: { equals: string } }).elementValue.equals, "旋转小新汽车载摆件");
  assert.equal(step.action!.params.text, (step.verify as { elementValue: { equals: string } }).elementValue.equals, "打进去的和断言的必须是同一个值");
});

test("a step with no verify does not grow one", () => {
  const steps = [{ goal: "点", action: { method: "browser.click", params: {} } }] as unknown as Playbook["steps"];
  assert.equal("verify" in instantiateSteps(steps, {})[0], false);
});

// ── optional：数据少一项就少做一步 ─────────────────────────────────────────

test("optional 步骤的槽位填不上就整步丢弃，其余步骤原样保留", () => {
  const steps = [
    { goal: "传第 0 张", optional: true, action: { method: "browser.upload", params: { attachmentFrom: "{{images.0}}" } } },
    { goal: "传第 1 张", optional: true, action: { method: "browser.upload", params: { attachmentFrom: "{{images.1}}" } } },
    { goal: "填标题", action: { method: "browser.type", params: { text: "{{title}}" } } },
  ] as unknown as Playbook["steps"];

  const out = instantiateSteps(steps, { images: [{ url: "a.jpg" }], title: "标题" });
  assert.deepEqual(out.map((s) => s.goal), ["传第 0 张", "填标题"], "缺图的那一步不该进 plan");
  assert.deepEqual(out[0].action!.params.attachmentFrom, { url: "a.jpg" });
});

test("没标 optional 的步骤仍然 fail-closed：槽位缺失 = 整本书拒绝起跑", () => {
  // 这是 optional 的另一半，缺了它 optional 就成了「所有槽位都可缺」——那正是
  // 这套机制最该防的事：一本书悄悄少做几步，跑完还报成功。
  const steps = [
    { goal: "传主图", action: { method: "browser.upload", params: { attachmentFrom: "{{images.0}}" } } },
  ] as unknown as Playbook["steps"];
  assert.throws(() => instantiateSteps(steps, { images: [] }), /unresolved playbook slot: images\.0/);
});

test("optional 只吃「槽位缺失」这一种错，别的错照旧上抛", () => {
  // 少做一步必须是数据缺失的直接后果。别的 bug 被 optional 顺手吃掉，症状就是
  // 「plan 莫名其妙短了几步」，比原地报错难查一个量级。
  const steps = [
    { goal: "坏参数", optional: true, action: { method: "browser.upload", params: { get attachmentFrom(): never { throw new TypeError("boom"); } } } },
  ] as unknown as Playbook["steps"];
  assert.throws(() => instantiateSteps(steps, {}), /boom/);
});

test("发布书：主图 1–5 张都能起跑，上传步数跟着张数走", async () => {
  // #1 的回归。从前 canonical 只要少于 5 张主图，整本书在 instantiateSteps 就 throw：
  // 35 步一步没跑，报出来的还是引擎级 unresolved playbook slot —— 而 canonical.schema
  // 的 images.main 本来就是 minItems 1 / maxItems 5，1–4 张是完全合法的商品。
  const playbook = JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "../../../resource/playbooks/doudian-publish-canonical.json"), "utf8")) as Playbook;
  const product = (mainCount: number) => ({
    title: { text: "一次性换药盘" },
    category: { doudianLeafId: 1, doudianPath: ["测试类目"], categoryProps: [] },
    images: {
      main: Array.from({ length: mainCount }, (_, i) => ({ url: `https://example.test/m${i}.jpg` })),
      detail: [{ url: "https://example.test/d0.jpg" }],
    },
    skus: [], specs: [], attributes: [],
  });
  const mainUploads = (steps: Playbook["steps"]) => steps.filter(
    (s) => s.action?.method === "browser.upload" && typeof s.action.params.nth === "number",
  );

  for (const n of [1, 2, 3, 4, 5]) {
    const params = applyParamDefaults(playbook.params, { product: product(n), mode: 'draft' }, {
      bookName: playbook.name, runId: 'fixture', planId: 'fixture-plan', uuid: 'fixture-uuid',
    });
    const steps = instantiateSteps(playbook.steps, params);
    const uploads = mainUploads(steps);
    assert.equal(uploads.length, n, `${n} 张主图应产出 ${n} 个上传步骤`);
    assert.deepEqual(uploads.map((s) => s.action!.params.nth), Array.from({ length: n }, (_, i) => i),
      "留下的槽位下标必须是连续的 0..n-1，否则抖店那 5 个槽会被跳着填");
    assert.deepEqual(
      uploads.map((s) => (s.action!.params.attachmentFrom as { url: string }).url),
      Array.from({ length: n }, (_, i) => `https://example.test/m${i}.jpg`),
      "第 i 步必须拿到第 i 张图",
    );
  }
});

test("发布书：一张主图都没有仍然当场炸，不许静默发一个没有图的商品", async () => {
  const playbook = JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "../../../resource/playbooks/doudian-publish-canonical.json"), "utf8")) as Playbook;
  const product = {
    title: { text: "一次性换药盘" },
    category: { doudianLeafId: 1, doudianPath: ["测试类目"], categoryProps: [] },
    images: { main: [], detail: [{ url: "https://example.test/d0.jpg" }] },
    skus: [], specs: [], attributes: [],
  };
  assert.throws(() => instantiateSteps(playbook.steps, { product, mode: "draft" }),
    /unresolved playbook slot: product\.images\.main\.0/);
});


test("录制时 verify 里嵌套的本次取值也换成 {{slot}}，回放换数据才验得过", async () => {
  const { extractSlots } = await import("./playbook.js");
  const verify = { elementValue: { name: "标题", equals: "夏季连衣裙" }, networkOk: { urlIncludes: "/item/夏季连衣裙" }, textPresent: "夏季连衣裙" };
  assert.deepEqual(extractSlots(verify, { title: "夏季连衣裙" }), {
    elementValue: { name: "标题", equals: "{{title}}" },
    networkOk: { urlIncludes: "/item/夏季连衣裙" },
    textPresent: "{{title}}",
  });
});
