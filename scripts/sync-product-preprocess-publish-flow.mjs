#!/usr/bin/env node

import { PRODUCT_INPUT_SCHEMA, PRODUCT_PREPROCESS_OUTPUT_SCHEMA, PREPROCESS_CONFIG_SCHEMA } from './sync-product-preprocess-flow.mjs';
import { BUSINESS_OUTCOME_SCHEMA } from '../packages/shared/dist/flow-business-outcome.js';

const FLOW_NAME = '商品预处理与发布';
const CAPTURE_BOOK_NAME = '1688-offer-snatch';
const PUBLISH_BOOK_NAME = 'doudian-publish-canonical';
const DEFAULT_CONSOLE_URL = process.env.CONSOLE_URL || 'http://127.0.0.1:8790';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureNode(graph, id, type, position) {
  const existing = graph.nodes.find((node) => node.id === id);
  if (existing) return existing;
  const created = { id, type, position, config: {} };
  graph.nodes.push(created);
  return created;
}

export function syncProductPreprocessPublishGraph(graph, { capture, publish }) {
  if (!capture?.id) throw new Error(`找不到采集 book「${CAPTURE_BOOK_NAME}」`);
  if (!publish?.id) throw new Error(`找不到发布 book「${PUBLISH_BOOK_NAME}」`);
  const next = clone(graph);
  next.nodes ??= [];
  next.edges ??= [];
  const retired = new Set(['book-publish-draft', 'script-outcome-publish', 'script-outcome-draft', 'script-outcome-fallback', 'flow-output']);
  next.nodes = next.nodes.filter((node) => !retired.has(node.id));

  const input = ensureNode(next, 'flow-input', 'flowInput', { x: 0, y: 0 });
  const captureNode = ensureNode(next, 'book-capture', 'book', { x: 300, y: 0 });
  const preprocess = ensureNode(next, 'script-preprocess', 'script', { x: 600, y: 0 });
  const branch = ensureNode(next, 'branch-ready', 'branch', { x: 900, y: 0 });
  const publishNode = ensureNode(next, 'book-publish', 'book', { x: 1200, y: -100 });
  const merge = ensureNode(next, 'merge-business-outcome', 'merge', { x: 1500, y: 0 });
  const output = ensureNode(next, 'flow-business-outcome', 'flowOutput', { x: 1800, y: 0 });

  input.label = '商品预处理与发布入参';
  input.config = {
    params: [
      { name: 'offerUrl', portId: 'p-offer-url', required: true, description: '1688 商品详情页 URL', schema: { type: 'string', minLength: 1 } },
      { name: 'profile', portId: 'p-profile', required: true, schemaRef: { name: 'shop-profile' } },
      { name: 'category', portId: 'p-category', required: false, schema: clone(PRODUCT_INPUT_SCHEMA.properties.category) },
      { name: 'preprocessConfig', portId: 'p-preprocess-config', required: false, description: '商品预处理策略配置：从 product-preprocess-config SchemaRecord 选择；省略时使用默认策略。', schemaRef: { name: 'product-preprocess-config', version: 2 } },
    ],
  };
  captureNode.label = '1688 商品采集';
  captureNode.config = { bookId: capture.id, mode: 'auto', resumePolicy: 'retry' };
  preprocess.label = '商品预处理';
  preprocess.config = {
    command: ['python3', '.claude/skills/product-preprocess/scripts/preprocess_wrapper.py'],
    timeoutMs: 600_000,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['raw', 'profile'],
      properties: {
        raw: clone(PRODUCT_INPUT_SCHEMA.properties.raw),
        profile: { 'x-bcp-schema-ref': { name: 'shop-profile' } },
        category: clone(PRODUCT_INPUT_SCHEMA.properties.category),
        preprocessConfig: clone(PREPROCESS_CONFIG_SCHEMA),
      },
    },
    outputSchema: clone(PRODUCT_PREPROCESS_OUTPUT_SCHEMA),
  };
  branch.label = '是否具备填表条件';
  branch.config = {
    cases: [{ id: 'draftable', label: '具备填表条件', left: '$.publication.canDraft', op: 'isTrue' }],
    otherwise: true,
  };
  publishNode.label = '抖店发布或存草稿';
  publishNode.config = { bookId: publish.id, mode: 'auto', constants: { mode: 'auto' }, resumePolicy: 'verify-before-retry' };
  merge.label = '业务结果';
  merge.config = { inputs: [{ id: 'completed' }, { id: 'stopped' }] };
  output.label = '业务结果';
  output.config = { portId: 'value', schema: clone(BUSINESS_OUTCOME_SCHEMA) };

  const managedTargets = new Set([captureNode.id, preprocess.id, branch.id, publishNode.id, merge.id, output.id]);
  for (const edge of next.edges) {
    if (retired.has(edge.target) || managedTargets.has(edge.target)) continue;
    if ((edge.source === branch.id && edge.sourceHandle === 'ready')
      || (edge.source === input.id && ['p-out-file', 'p-persist'].includes(edge.sourceHandle))) {
      throw new Error(`自定义连线 ${edge.id} 使用将被移除的端口 ${edge.sourceHandle}，请先手动调整连线`);
    }
  }
  const replacements = {
    'book-publish-draft': { source: publishNode.id, sourceHandle: 'outputs' },
    'script-outcome-publish': { source: publishNode.id, sourceHandle: 'outputs', srcPath: '$.outcome' },
    'script-outcome-draft': { source: publishNode.id, sourceHandle: 'outputs', srcPath: '$.outcome' },
    'script-outcome-fallback': { source: branch.id, sourceHandle: 'otherwise', srcPath: '$.outcome' },
    'flow-output': { source: preprocess.id, sourceHandle: 'output' },
  };
  next.edges = next.edges.filter((edge) => !retired.has(edge.target) && !managedTargets.has(edge.target)).map((edge) => {
    const replacement = replacements[edge.source];
    if (!replacement) return edge;
    const srcPath = replacement.srcPath ? `${replacement.srcPath}${(edge.srcPath ?? '$').slice(1)}` : edge.srcPath;
    return { ...edge, ...replacement, ...(srcPath ? { srcPath } : {}) };
  });
  const wire = (id, source, sourceHandle, target, targetHandle, srcPath) => ({
    id, source: source.id, sourceHandle, target: target.id, targetHandle, kind: 'data', ...(srcPath ? { srcPath } : {}),
  });
  next.edges.push(
    wire('edge-offer-url', input, 'p-offer-url', captureNode, 'offerUrl'),
    wire('edge-raw', captureNode, 'outputs', preprocess, 'raw'),
    wire('edge-profile', input, 'p-profile', preprocess, 'profile'),
    wire('edge-category', input, 'p-category', preprocess, 'category'),
    wire('edge-preprocess-config', input, 'p-preprocess-config', preprocess, 'preprocessConfig'),
    wire('edge-preprocess-ready', preprocess, 'output', branch, 'input'),
    wire('edge-product', branch, 'draftable', publishNode, 'product', '$.canonical'),
    wire('edge-publication', branch, 'draftable', publishNode, 'publication', '$.publication'),
    wire('edge-completed', publishNode, 'outputs', merge, 'completed', '$.outcome'),
    wire('edge-stopped', branch, 'otherwise', merge, 'stopped', '$.outcome'),
    wire('edge-business-outcome', merge, 'output', output, 'value'),
  );
  return next;
}

async function requestJson(baseUrl, path, init) {
  const response = await fetch(new URL(path, `${baseUrl.replace(/\/$/, '')}/`), init);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${init?.method || 'GET'} ${path} ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

export async function syncProductPreprocessPublishFlow({ baseUrl = DEFAULT_CONSOLE_URL, dryRun = false } = {}) {
  const [flows, books] = await Promise.all([requestJson(baseUrl, '/api/flows'), requestJson(baseUrl, '/api/books')]);
  const capture = books.find((candidate) => candidate.name === CAPTURE_BOOK_NAME);
  const publish = books.find((candidate) => candidate.name === PUBLISH_BOOK_NAME);
  if (!capture || !publish) throw new Error(`未索引采集或发布 book（${CAPTURE_BOOK_NAME} / ${PUBLISH_BOOK_NAME}），请先重新扫描 books`);
  const matches = flows.filter((flow) => flow.name === FLOW_NAME);
  if (matches.length > 1) throw new Error(`找到 ${matches.length} 个「${FLOW_NAME}」flow，不确定该同步哪一个，请先清理`);
  let flow = matches[0];
  let created = false;
  if (!flow) {
    if (dryRun) return { id: null, name: FLOW_NAME, created: true, changed: true, graph: syncProductPreprocessPublishGraph({ nodes: [], edges: [] }, { capture, publish }) };
    flow = await requestJson(baseUrl, '/api/flows', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: FLOW_NAME, description: '采集与预处理商品，由发布 book 选择发布或草稿并核验回执', graphJson: JSON.stringify({ nodes: [], edges: [] }) }),
    });
    created = true;
  }
  const graph = JSON.parse(flow.graphJson);
  const updatedGraph = syncProductPreprocessPublishGraph(graph, { capture, publish });
  const changed = JSON.stringify(graph) !== JSON.stringify(updatedGraph);
  if (dryRun) return { id: flow.id, name: flow.name, created, changed, graph: updatedGraph };
  if (!changed) return { id: flow.id, name: flow.name, created, changed: false };
  const updated = await requestJson(baseUrl, `/api/flows/${encodeURIComponent(flow.id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ graphJson: JSON.stringify(updatedGraph) }),
  });
  return { id: updated.id, name: updated.name, created, changed: true };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const urlIndex = process.argv.indexOf('--url');
  const baseUrl = urlIndex >= 0 ? process.argv[urlIndex + 1] : DEFAULT_CONSOLE_URL;
  syncProductPreprocessPublishFlow({ baseUrl, dryRun: process.argv.includes('--dry-run') })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
