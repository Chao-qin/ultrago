#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateRecordData } from '../packages/shared/dist/schema-records.js';
import { resolveEmbeddedSchemaRefs } from '../packages/shared/dist/schema-ref-resolution.js';
import { syncProductPreprocessPublishGraph } from './sync-product-preprocess-publish-flow.mjs';
import { PRODUCT_PREPROCESS_OUTPUT_SCHEMA } from './sync-product-preprocess-flow.mjs';

const FLOW_NAME = '商品预处理与发布';
const DEFAULT_CONSOLE_URL = process.env.CONSOLE_URL || 'http://127.0.0.1:8790';
// 期望的 canonical 版本从契约自身推导，不在这里再手写一份。手写的第二份会漂移，
// 而漂移后的表现是「这个检查永远失败」——canonical 升到 @7（记录本次运行使用的
// preprocess-config 摘要）时，这里仍停在 @6，于是整条验收链一直是红的，比不检查
// 更糟：真出契约差异时没人看得出区别。断言本身保留 —— 只有这一个引用能被解析，
// 其余 ref 会让回调收到不匹配的值并在此抛错。
const EXPECTED_CANONICAL_REF = PRODUCT_PREPROCESS_OUTPUT_SCHEMA.properties.canonical.anyOf[0]['x-bcp-schema-ref'];
const outputValidationSchema = await resolveEmbeddedSchemaRefs(PRODUCT_PREPROCESS_OUTPUT_SCHEMA, async (ref) => {
  if (ref.name !== EXPECTED_CANONICAL_REF.name || ref.version !== EXPECTED_CANONICAL_REF.version)
    throw new Error('未知的预处理输出 schema 引用');
  return JSON.parse(await readFile(new URL('../.claude/skills/product-preprocess/canonical.schema.json', import.meta.url), 'utf8'));
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pointerPart(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function compareContract(expected, actual, nodeId, path, differences) {
  if (Object.is(expected, actual)) return;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      differences.push({ nodeId, path, message: '与源契约的类型不一致' });
      return;
    }
    if (expected.length !== actual.length) {
      differences.push({ nodeId, path, message: '与源契约的数组长度不一致' });
      return;
    }
    for (let index = 0; index < expected.length; index += 1) {
      compareContract(expected[index], actual[index], nodeId, `${path}/${index}`, differences);
    }
    return;
  }
  if (isObject(expected)) {
    if (!isObject(actual)) {
      differences.push({ nodeId, path, message: '与源契约的类型不一致' });
      return;
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      const childPath = `${path}/${pointerPart(key)}`;
      if (!Object.hasOwn(actual, key)) {
        differences.push({ nodeId, path: childPath, message: '缺少源契约声明' });
      } else if (!Object.hasOwn(expected, key)) {
        differences.push({ nodeId, path: childPath, message: '存在源契约未声明的字段' });
      } else {
        compareContract(expected[key], actual[key], nodeId, childPath, differences);
      }
    }
    return;
  }
  differences.push({ nodeId, path, message: '与源契约不一致' });
}

function sourceGraphFor(graph) {
  const node = (id) => graph.nodes.find((candidate) => candidate?.id === id);
  const captureId = node('book-capture')?.config?.bookId ?? '__missing_capture_book__';
  const publishId = node('book-publish')?.config?.bookId
    ?? node('book-publish-draft')?.config?.bookId
    ?? '__missing_publish_book__';
  return syncProductPreprocessPublishGraph({ nodes: [], edges: [] }, {
    capture: { id: captureId },
    publish: { id: publishId },
  });
}

function validationDifference(error) {
  const separator = error.indexOf(' ');
  const path = separator < 0 ? '/' : error.slice(0, separator);
  const detail = separator < 0 ? '不符合源输出契约' : error.slice(separator + 1);
  return {
    nodeId: 'script-preprocess',
    path: path || '/',
    message: `实际输出不符合源契约：${detail}`,
  };
}

export function checkProductFlowContract({ graph, output } = {}) {
  const differences = [];
  if (!isObject(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return {
      ok: false,
      differences: [{ nodeId: 'flow', path: '/graphJson', message: 'Flow 图不是有效的 nodes/edges 对象' }],
    };
  }

  const expected = sourceGraphFor(graph);
  for (const expectedNode of expected.nodes) {
    const actualNode = graph.nodes.find((candidate) => candidate?.id === expectedNode.id);
    if (!actualNode) {
      differences.push({ nodeId: expectedNode.id, path: '/nodes', message: '缺少源契约节点' });
      continue;
    }
    compareContract(expectedNode.type, actualNode.type, expectedNode.id, '/type', differences);
    compareContract(expectedNode.config, actualNode.config, expectedNode.id, '/config', differences);
  }
  for (const expectedEdge of expected.edges) {
    const actualEdge = graph.edges.find((candidate) => candidate?.id === expectedEdge.id);
    const nodeId = expectedEdge.target;
    if (!actualEdge) {
      differences.push({ nodeId, path: `/edges/${pointerPart(expectedEdge.id)}`, message: '缺少源契约连线' });
      continue;
    }
    compareContract(expectedEdge, actualEdge, nodeId, `/edges/${pointerPart(expectedEdge.id)}`, differences);
  }
  const managedTargets = new Set(expected.edges.map((edge) => edge.target));
  const expectedEdgeIds = new Set(expected.edges.map((edge) => edge.id));
  const edgesById = new Map();
  for (const [index, edge] of graph.edges.entries()) {
    if (!isObject(edge)) continue;
    if (typeof edge.id === 'string') {
      const matches = edgesById.get(edge.id) ?? [];
      matches.push(edge);
      edgesById.set(edge.id, matches);
    }
    if (managedTargets.has(edge.target) && !expectedEdgeIds.has(edge.id)) {
      const edgePath = typeof edge.id === 'string' ? pointerPart(edge.id) : index;
      differences.push({
        nodeId: edge.target,
        path: `/edges/${edgePath}`,
        message: '存在源契约未声明的入边',
      });
    }
  }
  for (const [edgeId, matches] of edgesById) {
    if (matches.length < 2) continue;
    differences.push({
      nodeId: typeof matches[0].target === 'string' ? matches[0].target : 'flow',
      path: `/edges/${pointerPart(edgeId)}`,
      message: `边 ID 重复 ${matches.length} 次`,
    });
  }

  if (output !== undefined) {
    const validation = validateRecordData(outputValidationSchema, output);
    if (!validation.ok) {
      differences.push(...(validation.errors ?? ['不符合源输出契约']).map(validationDifference));
    }
  }
  return { ok: differences.length === 0, differences };
}

async function requestJson(baseUrl, path, fetchImpl) {
  let url;
  try {
    url = new URL(path, `${baseUrl.replace(/\/$/, '')}/`);
  } catch {
    throw new Error(`GET ${path} request URL is invalid`);
  }
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET' });
  } catch {
    throw new Error(`GET ${path} request failed`);
  }
  if (!response.ok) throw new Error(`GET ${path} failed (${response.status})`);
  let text;
  try {
    text = await response.text();
  } catch {
    throw new Error(`GET ${path} response body read failed`);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`GET ${path} returned invalid JSON`);
  }
}

export async function checkSavedProductFlowContract({
  baseUrl = DEFAULT_CONSOLE_URL,
  flowId,
  output,
  fetchImpl = fetch,
} = {}) {
  let flow;
  if (flowId) {
    flow = await requestJson(baseUrl, `/api/flows/${encodeURIComponent(flowId)}`, fetchImpl);
  } else {
    const flows = await requestJson(baseUrl, '/api/flows', fetchImpl);
    if (!Array.isArray(flows)) {
      return { ok: false, differences: [{ nodeId: 'flow', path: '/api/flows', message: 'Flow 列表响应不是数组' }] };
    }
    const matches = flows.filter((candidate) => candidate?.name === FLOW_NAME);
    if (matches.length !== 1) {
      return {
        ok: false,
        differences: [{
          nodeId: 'flow',
          path: '/name',
          message: matches.length === 0
            ? `找不到「${FLOW_NAME}」Flow`
            : `找到 ${matches.length} 个同名 Flow，拒绝猜测检查目标`,
        }],
      };
    }
    [flow] = matches;
  }
  if (!isObject(flow) || typeof flow.graphJson !== 'string') {
    return { ok: false, differences: [{ nodeId: 'flow', path: '/graphJson', message: 'Flow 缺少图快照' }] };
  }
  let graph;
  try {
    graph = JSON.parse(flow.graphJson);
  } catch {
    return { ok: false, differences: [{ nodeId: 'flow', path: '/graphJson', message: 'Flow 图不是合法 JSON' }] };
  }
  return checkProductFlowContract({ graph, output });
}

export function parseContractCheckArgs(argv) {
  const parsed = {
    baseUrl: DEFAULT_CONSOLE_URL,
    flowId: undefined,
    outputPath: undefined,
  };
  const names = new Map([
    ['--url', 'baseUrl'],
    ['--flow-id', 'flowId'],
    ['--output', 'outputPath'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = names.get(argv[index]);
    if (!key) throw new Error(`未知参数：${argv[index]}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argv[index]} 缺少值`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

export function formatContractCheck(result, { baseUrl = DEFAULT_CONSOLE_URL } = {}) {
  if (result.ok) return '商品 Flow 契约一致；检查过程仅执行了读取。';
  const lines = ['商品 Flow 契约存在差异：'];
  for (const difference of result.differences) {
    lines.push(`- ${difference.nodeId} ${difference.path}: ${difference.message}`);
  }
  let publicBaseUrl = '[invalid URL]';
  try {
    const url = new URL(baseUrl);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    publicBaseUrl = url.href.replace(/\/$/, '');
  } catch {
    // Invalid URL details may themselves contain credentials, so the display stays generic.
  }
  const quote = String.fromCharCode(39);
  const quotedUrl = `${quote}${publicBaseUrl.replaceAll(quote, `${quote}"${quote}"${quote}`)}${quote}`;
  lines.push('未执行任何同步。以下命令请自行执行（由你运行）：');
  lines.push(`- 先只读预演：node scripts/sync-product-preprocess-publish-flow.mjs --dry-run --url ${quotedUrl}`);
  lines.push(`- 确认后同步：node scripts/sync-product-preprocess-publish-flow.mjs --url ${quotedUrl}`);
  return lines.join('\n');
}

export async function runContractCheckCli({
  argv,
  fetchImpl = fetch,
  readFileImpl = readFile,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  try {
    const args = parseContractCheckArgs(argv);
    let output;
    if (args.outputPath !== undefined) {
      try {
        output = JSON.parse(await readFileImpl(resolve(args.outputPath), 'utf8'));
      } catch {
        throw new Error('无法读取或解析显式指定的 --output JSON 文件');
      }
    }
    const result = await checkSavedProductFlowContract({
      baseUrl: args.baseUrl,
      flowId: args.flowId,
      output,
      fetchImpl,
    });
    stdout.write(`${formatContractCheck(result, args)}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : '契约检查失败'}\n`);
    return 1;
  }
}

async function main() {
  process.exitCode = await runContractCheckCli({ argv: process.argv.slice(2) });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => {
    process.stderr.write('契约检查失败\n');
    process.exitCode = 1;
  });
}
