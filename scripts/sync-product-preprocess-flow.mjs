#!/usr/bin/env node

import { BUSINESS_OUTCOME_SCHEMA } from '../packages/shared/dist/flow-business-outcome.js';

const FLOW_NAME = "商品预处理";
const DEFAULT_CONSOLE_URL = process.env.CONSOLE_URL || "http://127.0.0.1:8790";
// 多次模型调用共享商品级预算，节点超时需覆盖该预算。
const PRODUCT_PREPROCESS_TIMEOUT_MS = 600_000;


// `additionalProperties: false` 只认【同一层】的 `properties`，不看 `oneOf` 分支里
// 声明的那些 —— 这是 JSON Schema 的规定，不是 ajv 的脾气。少了顶层这行 properties，
// 任何非空对象都会被判成「多余属性」，于是两个参数【每一种合法写法都传不进去】：
// {kind:"auto"} 和 {kind:"fixed",leafId:N} 都被拒，{} 又过不了 oneOf 的 required。
// 参数事实上只能省略，钉类目 / 指定落盘路径这两条路整个不可用（2026-09-07 实测：
// 触发 flow 传 category 恒定 400，报 "must NOT have additional properties"）。
// 顶层把两支用到的键都声明出来，oneOf 继续管「哪几个键必须一起出现」。
export const CATEGORY_OVERRIDE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { enum: ["auto", "fixed"] },
    leafId: { type: "integer", minimum: 1 },
  },
  // 分支内也写 additionalProperties: false —— 顶层那行只挡「两支都没声明的键」，
  // 挡不住「auto 支带了 leafId」这种跨支混搭（顶层 properties 里两个键都合法，
  // 第一支又没禁止多余键，于是它会当成合法的 auto 通过）。
  oneOf: [
    { required: ["kind"], additionalProperties: false, properties: { kind: { const: "auto" } } },
    { required: ["kind", "leafId"], additionalProperties: false, properties: { kind: { const: "fixed" }, leafId: { type: "integer", minimum: 1 } } },
  ],
};

export const PERSIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { enum: ["none", "file"] },
    path: { type: "string", minLength: 1 },
  },
  // 同上：分支内也要挡，否则 {kind:"none", path:"x"} 会被当成合法的 none 放过。
  oneOf: [
    { required: ["kind"], additionalProperties: false, properties: { kind: { const: "none" } } },
    { required: ["kind", "path"], additionalProperties: false, properties: { kind: { const: "file" }, path: { type: "string", minLength: 1 } } },
  ],
};

export const PREPROCESS_CONFIG_SCHEMA = {
  'x-bcp-schema-ref': { name: 'product-preprocess-config', version: 2 },
};

export const PRODUCT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["raw"],
  properties: {
    raw: { 'x-bcp-schema-ref': { name: 'raw-1688-offer', version: 2 } },
    mode: { type: "string", enum: ["draft", "publish"] },
    category: CATEGORY_OVERRIDE_SCHEMA,
    persist: PERSIST_SCHEMA,
    preprocessConfig: PREPROCESS_CONFIG_SCHEMA,
  },
};

export const PRODUCT_PREPROCESS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ['canonical', 'publication', 'outcome'],
  properties: {
    canonical: {
      anyOf: [{ 'x-bcp-schema-ref': { name: 'canonical-product', version: 8 } }, { type: 'object', maxProperties: 0 }],
    },
    publication: {
      type: 'object',
      required: ['canPublish', 'canDraft', 'missingRequired'],
      properties: {
        canPublish: { type: 'boolean' },
        canDraft: { type: 'boolean' },
        missingRequired: { type: 'array', items: { type: 'string' } },
      },
    },
    outcome: BUSINESS_OUTCOME_SCHEMA,
    phaseTimings: {
      type: 'object',
      additionalProperties: false,
      required: ['totalMs', 'stages'],
      properties: {
        totalMs: { type: 'number', minimum: 0 },
        stages: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'durationMs', 'status'],
            properties: {
              name: { type: 'string', minLength: 1 },
              durationMs: { type: 'number', minimum: 0 },
              status: { type: 'string', enum: ['success', 'failed'] },
            },
          },
        },
      },
    },
    mode: { type: "string", enum: ["draft", "publish"] },
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 缺哪个节点补哪个,已有的原样保留(位置、label、用户自己加的配置都不动)。
 *
 *  原实现缺节点直接抛错,理由是「同步」不该替人画图。但实际卡住的场景不是
 *  「图画错了」,而是**图还没画** —— 一个空 flow 里三个节点都没有,于是这个
 *  脚本永远跑不了,而它想同步的那条 `timeoutMs: 600000` 恰恰是不同步就必然
 *  超时失败的配置(实测单个商品 223s,而 script 节点默认上限 300s)。
 *  让它自己把骨架补齐,是把「必须先手工画三个节点」这道门槛去掉。
 */
function ensureNodes(next) {
  const seed = [
    { id: "flow-input", type: "flowInput", position: { x: 0, y: 0 } },
    { id: "script-preprocess", type: "script", position: { x: 320, y: 0 } },
    { id: "flow-output", type: "flowOutput", position: { x: 640, y: 0 } },
  ];
  // 认节点的方式两种,是有意不同的:
  //   flowInput / flowOutput 按 **type** 认 —— 一张图里就一个入参、一个出参,
  //     用户把它叫什么 id 都是那一个,复用即可。
  //   script 按 **id** 认 —— 一张图里可以有好几个 script 节点(再挂个通知脚本
  //     完全合理),所以只认 `script-preprocess` 这一个。别人的 script 节点与
  //     本脚本无关,既不复用也不报错,原样留着。
  const find = () => ({
    input: next.nodes.find((n) => n.type === "flowInput"),
    script: next.nodes.find((n) => n.id === "script-preprocess" && n.type === "script"),
    output: next.nodes.find((n) => n.type === "flowOutput"),
  });
  let found = find();
  if (!found.input) next.nodes.push({ ...seed[0], config: {} });
  if (!found.script) next.nodes.push({ ...seed[1], config: {} });
  if (!found.output) next.nodes.push({ ...seed[2], config: {} });
  return find();
}

export function syncProductPreprocessGraph(graph) {
  const next = clone(graph);
  next.nodes = next.nodes || [];
  next.edges = next.edges || [];
  const { input, script, output } = ensureNodes(next);

  input.label = "商品预处理入参";
  input.config = {
    ...input.config,
    params: [
      {
        name: "raw",
        portId: "p-raw",
        required: true,
        description: "1688 原始抓取（raw-1688-offer@2 契约：offerId/sourceUrl/title/attributes/skus/captureMeta 必填）",
        schemaRef: { name: "raw-1688-offer", version: 2 },
      },
       {
        name: "mode",
        portId: "p-mode",
        required: false,
        description: "发布落点透传：draft 或 publish。预处理本身不改变此值。",
        schema: { type: "string", enum: ["draft", "publish"] },
      },
      {
        name: "category",
        portId: "p-category",
        required: false,
        description: "类目决策：留空或 auto 自动分析；fixed + leafId 使用人工确认的抖店叶子类目。",
        schema: clone(CATEGORY_OVERRIDE_SCHEMA),
      },
      {
        name: "persist",
        portId: "p-persist",
        required: false,
        description: "可选落盘：none 不落盘；file + path 将同一个返回 JSON 写入仓库内相对路径。",
        schema: clone(PERSIST_SCHEMA),
      },
      {
        name: "preprocessConfig",
        portId: "p-preprocess-config",
        required: false,
        description: "商品预处理策略配置：从 product-preprocess-config SchemaRecord 选择；省略时使用默认策略。",
        schemaRef: { name: "product-preprocess-config", version: 2 },
      },
    ],
  };

  script.config = {
    ...script.config,
    command: ["python3", ".claude/skills/product-preprocess/scripts/preprocess_wrapper.py"],
    timeoutMs: PRODUCT_PREPROCESS_TIMEOUT_MS,
    inputSchema: clone(PRODUCT_INPUT_SCHEMA),
    outputSchema: clone(PRODUCT_PREPROCESS_OUTPUT_SCHEMA),
  };
  delete script.config.cwd;

  output.config = {
    ...output.config,
    portId: "value",
    schema: clone(PRODUCT_PREPROCESS_OUTPUT_SCHEMA),
  };

  const incomingIndexes = next.edges
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge }) => edge.target === script.id);
  const insertAt = incomingIndexes.length > 0 ? incomingIndexes[0].index : next.edges.length;
  next.edges = next.edges.filter((edge) => edge.target !== script.id);
  next.edges.splice(insertAt, 0, ...[
    ["edge-raw", "p-raw", "raw"],
    ["edge-mode", "p-mode", "mode"],
    ["edge-category", "p-category", "category"],
    ["edge-persist", "p-persist", "persist"],
    ["edge-preprocess-config", "p-preprocess-config", "preprocessConfig"],
  ].map(([id, sourceHandle, targetHandle]) => ({
    id,
    source: input.id,
    sourceHandle,
    target: script.id,
    targetHandle,
    kind: "data",
  })));
  next.edges = next.edges.map((edge) =>
    edge.target === output.id ? { ...edge, targetHandle: "value" } : edge,
  );

  // script → flowOutput。原实现只重连 input 侧,假设这条边是人在画布上拉好的;
  // 于是自建骨架跑出来的图三个节点齐、超时也配好,却**没有任何数据流向出参**,
  // 看着像同步成功、实际跑不通。
  //
  // 端口 id 不是随便起的:script 的输出端口固定叫 `output`
  // (packages/shared/src/flow-ports.ts 的 checkOutputConsumption 就按这个 id 找),
  // flowOutput 的入口叫 `value`(与上面那行 targetHandle 归一、以及
  // output.config.portId 一致)。
  if (!next.edges.some((e) => e.source === script.id && e.target === output.id)) {
    next.edges.push({
      id: "edge-result",
      source: script.id,
      sourceHandle: "output",
      target: output.id,
      targetHandle: "value",
      kind: "data",
    });
  }
  return next;
}

async function requestJson(baseUrl, path, init) {
  const response = await fetch(new URL(path, `${baseUrl.replace(/\/$/, "")}/`), init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${init?.method || "GET"} ${path} ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

export async function syncProductPreprocessFlow({ baseUrl = DEFAULT_CONSOLE_URL, dryRun = false } = {}) {
  const flows = await requestJson(baseUrl, "/api/flows");
  const matches = flows.filter((flow) => flow.name === FLOW_NAME);
  // 多个同名 flow 仍然拒绝:改哪一个都是猜,而猜错会覆盖另一个的图。
  if (matches.length > 1) {
    throw new Error(`找到 ${matches.length} 个「${FLOW_NAME}」flow，不确定该同步哪一个，请先清理`);
  }
  let flow = matches[0];
  let created = false;
  if (!flow) {
    if (dryRun) {
      // dry-run 不写库,所以拿一个空图往下走,让调用方看到"会被同步成什么样"。
      return {
        id: null, name: FLOW_NAME, created: true, changed: true,
        graph: syncProductPreprocessGraph({ nodes: [], edges: [] }),
      };
    }
    flow = await requestJson(baseUrl, "/api/flows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: FLOW_NAME,
        description: "1688 采集商品 → 清洗/类目属性映射/合规检测 → 抖店 addV2 schema",
        graphJson: JSON.stringify({ nodes: [], edges: [] }),
      }),
    });
    created = true;
  }
  const graph = JSON.parse(flow.graphJson);
  const updatedGraph = syncProductPreprocessGraph(graph);
  const inputSchema = PRODUCT_INPUT_SCHEMA;
  const outputSchema = PRODUCT_PREPROCESS_OUTPUT_SCHEMA;
  // 只比图。`Flow.inputSchema` / `Flow.outputSchema` 是服务端从 graphJson 现算的
  // （`flows.service.ts` 的 update()：客户端传的这两个字段直接不进 data），
  // 且 deriveInputSchema 产出的是 **param 数组**、deriveOutputSchema 会把 schemaRef
  // 内联展开 —— 拿它们跟这里的裸 JSON Schema 比，两边形状就不是一回事，永远不等。
  // 于是此前每一次运行都报 `changed: true` 并发一次无意义的 PATCH：既污染了
  // `updatedAt`（UI 的 expectedUpdatedAt 乐观锁要读它），也让这个字段彻底失去信号
  // —— 真有漂移时你也分辨不出来。姊妹脚本 sync-product-preprocess-publish-flow.mjs
  // 一直就是只比图，这里对齐它。
  const changed = JSON.stringify(graph) !== JSON.stringify(updatedGraph);
  if (dryRun) {
    return { id: flow.id, name: flow.name, created, graph: updatedGraph, changed };
  }
  if (!changed) {
    return {
      id: flow.id,
      name: flow.name,
      created,
      inputSchema: JSON.parse(flow.inputSchema),
      outputSchema: JSON.parse(flow.outputSchema),
      changed: false,
    };
  }

  const updated = await requestJson(baseUrl, `/api/flows/${encodeURIComponent(flow.id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      graphJson: JSON.stringify(updatedGraph),
      inputSchema: JSON.stringify(inputSchema),
      outputSchema: JSON.stringify(outputSchema),
    }),
  });
  return { id: updated.id, name: updated.name, created, inputSchema: JSON.parse(updated.inputSchema), outputSchema: JSON.parse(updated.outputSchema), changed: true };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const dryRun = process.argv.includes("--dry-run");
  // --url <base> 与 register-schemas.mjs 对齐：换一个库就换一个 URL，
  // 不设置则回落到 CONSOLE_URL 环境变量 / 本机 8790。
  const urlIndex = process.argv.indexOf("--url");
  const baseUrl = urlIndex >= 0 ? process.argv[urlIndex + 1] : DEFAULT_CONSOLE_URL;
  syncProductPreprocessFlow({ baseUrl, dryRun })
    .then((result) => {
      console.log(JSON.stringify({
        id: result.id,
        name: result.name,
        created: result.created,
        changed: result.changed,
        ...(dryRun ? { graph: result.graph } : { inputSchema: result.inputSchema, outputSchema: result.outputSchema }),
      }, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
