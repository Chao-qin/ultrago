import test from "node:test";
import assert from "node:assert/strict";
// ajv 是 @bcp/shared 的依赖，不是根依赖；pnpm 的严格 node_modules 下裸 specifier
// 在 scripts/ 里解析不到，所以按路径取。换成根依赖只为一个测试不值当。
import Ajv2020 from "../packages/shared/node_modules/ajv/dist/2020.js";
import {
  PRODUCT_PREPROCESS_OUTPUT_SCHEMA,
  syncProductPreprocessGraph,
  CATEGORY_OVERRIDE_SCHEMA,
  PERSIST_SCHEMA,
} from "./sync-product-preprocess-flow.mjs";

const oldGraph = {
  nodes: [
    {
      id: "flowInput-gms8k1",
      type: "flowInput",
      position: { x: -200, y: 0 },
      label: "商品预处理入参",
      config: {
        params: [
          { name: "raw", portId: "p-raw", required: true, schema: { type: "object" } },
        ],
      },
    },
    {
      id: "script-preprocess",
      type: "script",
      position: { x: 100, y: 0 },
      label: "商品预处理",
      config: {
        command: ["python3", ".claude/skills/product-preprocess/scripts/preprocess_wrapper.py", "--capture", "$capturePath"],
        cwd: process.cwd(),
        inputSchema: { type: "object", properties: { capturePath: { type: "string" } } },
        outputSchema: { type: "object", properties: { exitCode: { type: "number" } } },
      },
    },
    {
      id: "flowOutput-result",
      type: "flowOutput",
      position: { x: 400, y: 0 },
      label: "预处理结果",
      config: { portId: "p-result", schema: { type: "object", properties: { exitCode: { type: "number" } } } },
    },
  ],
  edges: [
    { id: "edge-capture", source: "flowInput-gms8k1", sourceHandle: "p-capture", target: "script-preprocess", targetHandle: "capturePath", kind: "data" },
    { id: "edge-outdir", source: "flowInput-gms8k1", sourceHandle: "p-outdir", target: "script-preprocess", targetHandle: "outDir", kind: "data" },
    { id: "edge-result", source: "script-preprocess", sourceHandle: "output", target: "flowOutput-result", targetHandle: "p-result", kind: "data" },
  ],
};

test("sync exposes only raw, category override, and one persistence union", () => {
  const graph = syncProductPreprocessGraph(oldGraph);
  const flowInput = graph.nodes.find((node) => node.id === "flowInput-gms8k1");
  const script = graph.nodes.find((node) => node.id === "script-preprocess");

  assert.deepEqual(flowInput.config.params, [{
    name: "raw",
    portId: "p-raw",
    required: true,
    description: "1688 原始抓取（raw-1688-offer@2 契约：offerId/sourceUrl/title/attributes/skus/captureMeta 必填）",
    schemaRef: { name: "raw-1688-offer", version: 2 },
  }, {
    name: "mode",
    portId: "p-mode",
    required: false,
    description: "发布落点透传：draft 或 publish。预处理本身不改变此值。",
    schema: { type: "string", enum: ["draft", "publish"] },
  }, {
    name: "category",
    portId: "p-category",
    required: false,
    description: "类目决策：留空或 auto 自动分析；fixed + leafId 使用人工确认的抖店叶子类目。",
    // 引用同一个常量而不是把 schema 再抄一遍：重复的那份不会自己跟着改，
    // 结果是「schema 修好了、测试却红了」——本条断言压的是【哪些参数、怎么接线】，
    // schema 内容由 sync-product-preprocess-flow 自己的用例守。
    schema: CATEGORY_OVERRIDE_SCHEMA,
  }, {
    name: "persist",
    portId: "p-persist",
    required: false,
    description: "可选落盘：none 不落盘；file + path 将同一个返回 JSON 写入仓库内相对路径。",
    schema: PERSIST_SCHEMA,
   }, {
     name: "preprocessConfig",
     portId: "p-preprocess-config",
     required: false,
     description: "商品预处理策略配置：从 product-preprocess-config SchemaRecord 选择；省略时使用默认策略。",
     schemaRef: { name: "product-preprocess-config", version: 2 },
   }]);
  assert.deepEqual(script.config.command, [
    "python3",
    ".claude/skills/product-preprocess/scripts/preprocess_wrapper.py",
  ]);
  assert.equal(script.config.timeoutMs, 600_000);
  assert.equal(Object.hasOwn(script.config, "cwd"), false);
  assert.deepEqual(script.config.inputSchema, {
    type: "object",
    additionalProperties: false,
    required: ["raw"],
    properties: {
      raw: script.config.inputSchema.properties.raw,
      mode: { type: "string", enum: ["draft", "publish"] },
      // 同上：引用常量，不再抄第二份。
      category: CATEGORY_OVERRIDE_SCHEMA,
      persist: PERSIST_SCHEMA,
      preprocessConfig: { 'x-bcp-schema-ref': { name: 'product-preprocess-config', version: 2 } },
    },
  });
  assert.deepEqual(graph.edges.filter((edge) => edge.target === "script-preprocess"), [
    {
      id: "edge-raw",
      source: "flowInput-gms8k1",
      sourceHandle: "p-raw",
      target: "script-preprocess",
      targetHandle: "raw",
      kind: "data",
    },
    {
      id: "edge-mode",
      source: "flowInput-gms8k1",
      sourceHandle: "p-mode",
      target: "script-preprocess",
      targetHandle: "mode",
      kind: "data",
    },
    {
      id: "edge-category",
      source: "flowInput-gms8k1",
      sourceHandle: "p-category",
      target: "script-preprocess",
      targetHandle: "category",
      kind: "data",
    },
    {
      id: "edge-persist",
      source: "flowInput-gms8k1",
      sourceHandle: "p-persist",
      target: "script-preprocess",
      targetHandle: "persist",
      kind: "data",
    },
    {
      id: "edge-preprocess-config",
      source: "flowInput-gms8k1",
      sourceHandle: "p-preprocess-config",
      target: "script-preprocess",
      targetHandle: "preprocessConfig",
      kind: "data",
    },
  ]);
});

test("sync gives the flow the complete JSON result contract", () => {
  const graph = syncProductPreprocessGraph(oldGraph);
  const output = graph.nodes.find((node) => node.id === "flowOutput-result");
  const script = graph.nodes.find((node) => node.id === "script-preprocess");

  assert.deepEqual(script.config.inputSchema.properties.raw, { 'x-bcp-schema-ref': { name: 'raw-1688-offer', version: 2 } });
  assert.deepEqual(script.config.outputSchema, PRODUCT_PREPROCESS_OUTPUT_SCHEMA);
  assert.deepEqual(output.config.schema, PRODUCT_PREPROCESS_OUTPUT_SCHEMA);
  assert.deepEqual(PRODUCT_PREPROCESS_OUTPUT_SCHEMA.properties.canonical.anyOf[0], { 'x-bcp-schema-ref': { name: 'canonical-product', version: 8 } });
  assert.equal('addv2' in PRODUCT_PREPROCESS_OUTPUT_SCHEMA.properties, false);
  assert.deepEqual(graph.edges.find((edge) => edge.id === "edge-result"), {
    ...oldGraph.edges[2],
    targetHandle: "value",
  });
  assert.equal(output.config.portId, "value");
});

test('preprocess timing contract is optional, strict, and accepts observed stages', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
  const validate = ajv.compile(PRODUCT_PREPROCESS_OUTPUT_SCHEMA);
  const oldOutput = {
    canonical: {},
    publication: { canPublish: false, canDraft: false, missingRequired: [] },
    outcome: { status: 'blocked', reason: '缺少可填表商品', missingRequired: [] },
  };
  assert.equal(validate(oldOutput), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    ...oldOutput,
    phaseTimings: {
      totalMs: 175,
      stages: [
        { name: 'data_preparation', durationMs: 75, status: 'success' },
        { name: 'projection_validation', durationMs: 100, status: 'failed' },
      ],
    },
  }), true, JSON.stringify(validate.errors));

  for (const phaseTimings of [
    { totalMs: -1, stages: [] },
    { totalMs: 1, stages: [{ name: '', durationMs: 1, status: 'success' }] },
    { totalMs: 1, stages: [{ name: 'data_preparation', durationMs: -1, status: 'success' }] },
    { totalMs: 1, stages: [{ name: 'data_preparation', durationMs: 1, status: 'skipped' }] },
    { totalMs: 1, stages: [{ name: 'data_preparation', durationMs: 1, status: 'success', secret: true }] },
  ]) {
    assert.equal(validate({ ...oldOutput, phaseTimings }), false, JSON.stringify(phaseTimings));
  }
});

test("sync is idempotent after the graph has the JSON contract", () => {
  const once = syncProductPreprocessGraph(oldGraph);
  assert.deepEqual(syncProductPreprocessGraph(once), once);
});

test("category / persist 的每一种合法写法都真的传得进去", () => {
  // `additionalProperties: false` 只认同一层的 `properties`，不看 oneOf 分支里的。
  // 少了顶层 properties 时，这两个参数的【每一种】合法写法都会被判成「多余属性」——
  // 参数事实上只能省略，而门面上它看起来是支持的。2026-09-07 实测：触发 flow 传
  // category 恒定 400。这条断言压的就是「合法值真的能过」，不是 schema 长什么样。
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const cases = [
    [CATEGORY_OVERRIDE_SCHEMA, { kind: "auto" }, true],
    [CATEGORY_OVERRIDE_SCHEMA, { kind: "fixed", leafId: 1000001874 }, true],
    [CATEGORY_OVERRIDE_SCHEMA, { kind: "fixed" }, false],          // 缺 leafId
    [CATEGORY_OVERRIDE_SCHEMA, { kind: "auto", leafId: 1 }, false], // auto 支不该带 leafId
    [CATEGORY_OVERRIDE_SCHEMA, { kind: "auto", zzz: 1 }, false],    // 真正的多余属性仍要拦
    [PERSIST_SCHEMA, { kind: "none" }, true],
    [PERSIST_SCHEMA, { kind: "file", path: "a/b.json" }, true],
    [PERSIST_SCHEMA, { kind: "file" }, false],                      // 缺 path
    [PERSIST_SCHEMA, { kind: "none", zzz: 1 }, false],
    [PERSIST_SCHEMA, { kind: "none", path: "a" }, false],  // 跨支混搭

  ];
  for (const [schema, value, want] of cases) {
    const got = ajv.validate(schema, value);
    assert.equal(got, want, `${JSON.stringify(value)} 期望 ${want}，实际 ${got}：${JSON.stringify(ajv.errors)}`);
  }
});
