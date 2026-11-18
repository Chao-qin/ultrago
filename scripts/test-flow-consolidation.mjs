import assert from 'node:assert/strict';
import test from 'node:test';
import { syncProductPreprocessPublishGraph } from './sync-product-preprocess-publish-flow.mjs';
import { PRODUCT_PREPROCESS_OUTPUT_SCHEMA } from './sync-product-preprocess-flow.mjs';

const books = { capture: { id: 'capture' }, publish: { id: 'publish' } };

test('listing graph has one publishing book and no intermediate artifact output', () => {
  const graph = syncProductPreprocessPublishGraph({ nodes: [], edges: [] }, books);
  assert.equal(graph.nodes.length, 7);
  assert.equal(graph.nodes.filter((node) => node.type === 'script').length, 1);
  assert.equal(graph.nodes.filter((node) => node.type === 'flowOutput').length, 1);
  assert.deepEqual(graph.nodes.filter((node) => node.type === 'book').map((node) => node.config.bookId), ['capture', 'publish']);
  const input = graph.nodes.find((node) => node.type === 'flowInput');
  assert.deepEqual(input.config.params.map((param) => param.name), ['offerUrl', 'profile', 'category', 'preprocessConfig']);
  const publish = graph.nodes.find((node) => node.config.bookId === 'publish');
  assert.equal(publish.config.constants.mode, 'auto');
  assert.equal(publish.config.resumePolicy, 'verify-before-retry');
  assert.equal(graph.edges.find((edge) => edge.target === publish.id && edge.targetHandle === 'publication').srcPath, '$.publication');
});

test('preprocess output contains one product and references the existing canonical contract', () => {
  assert.deepEqual(PRODUCT_PREPROCESS_OUTPUT_SCHEMA.required, ['canonical', 'publication', 'outcome']);
  assert.equal(PRODUCT_PREPROCESS_OUTPUT_SCHEMA.properties.addv2, undefined);
  assert.equal(PRODUCT_PREPROCESS_OUTPUT_SCHEMA.properties.doudianValues, undefined);
  assert.deepEqual(PRODUCT_PREPROCESS_OUTPUT_SCHEMA.properties.canonical.anyOf[0], { 'x-bcp-schema-ref': { name: 'canonical-product', version: 8 } });
});

test('sync retires the former outcome scripts and stays idempotent', () => {
  const graph = syncProductPreprocessPublishGraph({
    nodes: [
      { id: 'book-publish-draft', type: 'book', config: {} },
      { id: 'script-outcome-publish', type: 'script', config: {} },
      { id: 'script-outcome-draft', type: 'script', config: {} },
      { id: 'script-outcome-fallback', type: 'script', config: {} },
      { id: 'flow-output', type: 'flowOutput', config: {} },
      { id: 'custom', type: 'transform', config: { expression: '$' } },
    ], edges: [],
  }, books);
  assert.equal(graph.nodes.length, 8);
  assert.deepEqual(graph.nodes.find((node) => node.id === 'custom').config, { expression: '$' });
  assert.deepEqual(syncProductPreprocessPublishGraph(graph, books), graph);
});

test('migration refuses custom wires whose old branch or input meaning cannot be preserved', () => {
  for (const [source, sourceHandle] of [['branch-ready', 'ready'], ['flow-input', 'p-out-file'], ['flow-input', 'p-persist']]) {
    assert.throws(() => syncProductPreprocessPublishGraph({ nodes: [], edges: [{ id: 'custom-wire', source, sourceHandle, target: 'custom-node', targetHandle: 'input' }] }, books), /custom-wire/);
  }
});
