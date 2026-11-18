import assert from 'node:assert/strict';
import test from 'node:test';

import { BUSINESS_OUTCOME_SCHEMA } from '../packages/shared/dist/flow-business-outcome.js';
import {
  checkProductFlowContract,
  checkSavedProductFlowContract,
  formatContractCheck,
  parseContractCheckArgs,
} from './check-product-flow-contract.mjs';
import { syncProductPreprocessPublishGraph } from './sync-product-preprocess-publish-flow.mjs';

const books = {
  capture: { id: 'capture-id', name: '1688-offer-snatch' },
  publish: { id: 'publish-id', name: 'doudian-publish-canonical' },
};

function sourceGraph() {
  return syncProductPreprocessPublishGraph({ nodes: [], edges: [] }, books);
}

function preprocessOutput() {
  return {
    canonical: {},
    publication: { canPublish: false, canDraft: false, missingRequired: [] },
    outcome: { status: 'blocked', reason: '缺少可填表商品', missingRequired: [] },
  };
}

test('source graph and current output pass while cosmetic graph details are ignored', () => {
  const graph = sourceGraph();
  graph.nodes[0].label = '运营自定义标签';
  graph.nodes[0].position = { x: 999, y: -999 };

  assert.deepEqual(checkProductFlowContract({ graph, output: preprocessOutput() }), {
    ok: true,
    differences: [],
  });
});

test('malformed graph entries produce differences instead of crashing the checker', () => {
  let result;
  assert.doesNotThrow(() => {
    result = checkProductFlowContract({ graph: { nodes: [null], edges: [null] } });
  });
  assert.equal(result.ok, false);
  assert.ok(result.differences.some((difference) => difference.nodeId === 'script-preprocess'));
});

test('extra incoming edges and duplicate edge ids fail the managed graph contract', () => {
  const graph = sourceGraph();
  graph.edges.push({
    id: 'edge-direct-publish-bypass',
    source: 'script-preprocess',
    sourceHandle: 'output',
    target: 'book-publish',
    targetHandle: 'product',
    kind: 'data',
  });
  graph.edges.push({ ...graph.edges.find((edge) => edge.id === 'edge-product') });

  const result = checkProductFlowContract({ graph });
  assert.equal(result.ok, false);
  assert.ok(result.differences.some((difference) =>
    difference.nodeId === 'book-publish'
      && difference.path === '/edges/edge-direct-publish-bypass'
      && /未声明/.test(difference.message)));
  assert.ok(result.differences.some((difference) =>
    difference.nodeId === 'book-publish'
      && difference.path === '/edges/edge-product'
      && /重复/.test(difference.message)));
});

test('publication, business outcome, and timing drift identify exact nodes and paths', () => {
  const graph = sourceGraph();
  const preprocess = graph.nodes.find((node) => node.id === 'script-preprocess');
  const branch = graph.nodes.find((node) => node.id === 'branch-ready');
  const businessOutput = graph.nodes.find((node) => node.id === 'flow-business-outcome');
  branch.config.cases[0].left = '$.projectionVerdict.canPublish';
  preprocess.config.outputSchema.properties.publication.properties.canPublish.type = 'string';
  preprocess.config.outputSchema.properties.phaseTimings.properties.stages.items.properties.durationMs.type = 'string';
  businessOutput.config.schema.properties.status.enum = ['published'];

  const result = checkProductFlowContract({ graph });
  assert.equal(result.ok, false);
  for (const expected of [
    ['branch-ready', '/config/cases/0/left'],
    ['script-preprocess', '/config/outputSchema/properties/publication/properties/canPublish/type'],
    ['script-preprocess', '/config/outputSchema/properties/phaseTimings/properties/stages/items/properties/durationMs/type'],
    ['flow-business-outcome', '/config/schema/properties/status/enum'],
  ]) {
    assert.ok(result.differences.some((difference) =>
      difference.nodeId === expected[0] && difference.path === expected[1]),
    `missing difference ${expected.join(': ')}: ${JSON.stringify(result.differences)}`);
  }
});

test('actual output uses shared strict schema validation and reports useful safe paths', () => {
  const output = {
    ...preprocessOutput(),
    phaseTimings: {
      totalMs: 'credential-value-must-not-leak',
      stages: [{ name: 'data_preparation', durationMs: -1, status: 'success' }],
    },
  };

  const result = checkProductFlowContract({ graph: sourceGraph(), output });
  assert.equal(result.ok, false);
  assert.ok(result.differences.some((difference) =>
    difference.nodeId === 'script-preprocess' && difference.path === '/phaseTimings/totalMs'));
  assert.ok(result.differences.some((difference) =>
    difference.nodeId === 'script-preprocess' && difference.path === '/phaseTimings/stages/0/durationMs'));
  assert.equal(JSON.stringify(result).includes('credential-value-must-not-leak'), false);
});

test('all business outcome source declarations use the shared schema', () => {
  const graph = sourceGraph();
  assert.deepEqual(graph.nodes.find((node) => node.id === 'script-preprocess').config.outputSchema.properties.outcome, BUSINESS_OUTCOME_SCHEMA);
  assert.deepEqual(graph.nodes.find((node) => node.id === 'flow-business-outcome').config.schema, BUSINESS_OUTCOME_SCHEMA);
  assert.equal(checkProductFlowContract({ graph }).ok, true);
});

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  };
}

test('saved-flow check performs GET only and accepts explicit flow id', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    if (init?.method !== 'GET') throw new Error(`write attempted: ${init?.method}`);
    requests.push({ url: String(url), method: init.method });
    return jsonResponse({ id: 'flow-1', name: '商品预处理与发布', graphJson: JSON.stringify(sourceGraph()) });
  };

  const result = await checkSavedProductFlowContract({
    baseUrl: 'http://console.test',
    flowId: 'flow-1',
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(requests, [{ url: 'http://console.test/api/flows/flow-1', method: 'GET' }]);
});

test('duplicate flow names fail safely without choosing or writing either flow', async () => {
  const fetchImpl = async (_url, init) => {
    if (init?.method !== 'GET') throw new Error(`write attempted: ${init?.method}`);
    return jsonResponse([
      { id: 'flow-1', name: '商品预处理与发布', graphJson: '{}' },
      { id: 'flow-2', name: '商品预处理与发布', graphJson: '{}' },
    ]);
  };

  const result = await checkSavedProductFlowContract({ baseUrl: 'http://console.test', fetchImpl });
  assert.equal(result.ok, false);
  assert.deepEqual(result.differences.map(({ nodeId, path }) => ({ nodeId, path })), [
    { nodeId: 'flow', path: '/name' },
  ]);
});

test('HTTP failures never echo response bodies', async () => {
  const fetchImpl = async () => jsonResponse(
    { error: 'credential-value-must-not-leak' },
    { ok: false, status: 503 },
  );

  await assert.rejects(
    checkSavedProductFlowContract({ baseUrl: 'http://console.test', fetchImpl }),
    (error) => {
      assert.match(error.message, /GET \/api\/flows failed \(503\)/);
      assert.equal(error.message.includes('credential-value-must-not-leak'), false);
      return true;
    },
  );
});

test('response body reader failures are sanitized for the checker and CLI', async () => {
  const secret = 'FAKE_BODY_READER_SECRET';
  const fetchImpl = async (_url, init) => {
    if (init?.method !== 'GET') throw new Error(`write attempted: ${init?.method}`);
    return {
      ok: true,
      status: 200,
      text: async () => { throw new Error(secret); },
    };
  };

  await assert.rejects(
    checkSavedProductFlowContract({ baseUrl: 'http://console.test', fetchImpl }),
    (error) => {
      assert.equal(error.message, 'GET /api/flows response body read failed');
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );

  const stdout = [];
  const stderr = [];
  const exitCode = await (await import('./check-product-flow-contract.mjs')).runContractCheckCli({
    argv: ['--url', 'http://console.test'],
    fetchImpl,
    stdout: { write: (text) => stdout.push(text) },
    stderr: { write: (text) => stderr.push(text) },
  });
  assert.equal(exitCode, 1);
  assert.equal(stdout.join(''), '');
  assert.equal(stderr.join(''), 'GET /api/flows response body read failed\n');
  assert.equal(stderr.join('').includes(secret), false);
});

test('network failures and guidance never expose URL credentials or dependency messages', async () => {
  const fetchImpl = async () => {
    throw new Error('credential-value-must-not-leak');
  };

  await assert.rejects(
    checkSavedProductFlowContract({
      baseUrl: 'http://operator:password-must-not-leak@console.test',
      fetchImpl,
    }),
    (error) => {
      assert.match(error.message, /GET \/api\/flows request failed/);
      assert.equal(error.message.includes('credential-value-must-not-leak'), false);
      assert.equal(error.message.includes('password-must-not-leak'), false);
      return true;
    },
  );

  const guidance = formatContractCheck({
    ok: false,
    differences: [{ nodeId: 'flow', path: '/name', message: 'not found' }],
  }, {
    baseUrl: 'http://operator:password-must-not-leak@console.test/$(FAKE_COMMAND_SECRET)?token=FAKE_QUERY_SECRET#FAKE_HASH_SECRET',
  });
  assert.equal(guidance.includes('operator'), false);
  assert.equal(guidance.includes('password-must-not-leak'), false);
  assert.equal(guidance.includes('FAKE_QUERY_SECRET'), false);
  assert.equal(guidance.includes('FAKE_HASH_SECRET'), false);
  assert.match(guidance, /--url 'http:\/\/console\.test\/\$\(FAKE_COMMAND_SECRET\)'/);
});

test('CLI arguments never infer a local output fixture and drift guidance is explicit', () => {
  assert.deepEqual(parseContractCheckArgs(['--url', 'http://console.test']), {
    baseUrl: 'http://console.test',
    flowId: undefined,
    outputPath: undefined,
  });
  assert.deepEqual(parseContractCheckArgs([
    '--url', 'http://console.test', '--flow-id', 'flow-1', '--output', 'fixture.json',
  ]), {
    baseUrl: 'http://console.test',
    flowId: 'flow-1',
    outputPath: 'fixture.json',
  });

  const text = formatContractCheck({
    ok: false,
    differences: [{ nodeId: 'script-preprocess', path: '/config/outputSchema', message: '与源契约不一致' }],
  }, { baseUrl: 'http://console.test' });
  assert.match(text, /未执行任何同步/);
  assert.match(text, /node scripts\/sync-product-preprocess-publish-flow\.mjs --url/);
  assert.match(text, /请自行执行/);
});

test('CLI returns a nonzero code for drift without performing a sync', async () => {
  const checker = await import('./check-product-flow-contract.mjs');
  assert.equal(typeof checker.runContractCheckCli, 'function', 'CLI runner must be injectable');
  const stdout = [];
  const stderr = [];
  const fetchImpl = async (_url, init) => {
    if (init?.method !== 'GET') throw new Error(`write attempted: ${init?.method}`);
    return jsonResponse([
      { id: 'flow-1', name: '商品预处理与发布', graphJson: '{}' },
      { id: 'flow-2', name: '商品预处理与发布', graphJson: '{}' },
    ]);
  };

  const exitCode = await checker.runContractCheckCli({
    argv: ['--url', 'http://console.test'],
    fetchImpl,
    stdout: { write: (text) => stdout.push(text) },
    stderr: { write: (text) => stderr.push(text) },
  });
  assert.equal(exitCode, 1);
  assert.equal(stderr.join(''), '');
  assert.match(stdout.join(''), /未执行任何同步/);
});

test('offline output checking resolves canonical references and rejects partial products', () => {
  const output = { ...preprocessOutput(), canonical: { title: { text: 'partial product' } } };
  const result = checkProductFlowContract({ graph: sourceGraph(), output });
  assert.equal(result.ok, false);
  assert.ok(result.differences.some((difference) => difference.path.startsWith('/canonical')));
});
