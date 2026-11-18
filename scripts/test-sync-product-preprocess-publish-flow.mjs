import test from "node:test";
import assert from "node:assert/strict";
import { tsImport } from '../packages/shared/node_modules/tsx/dist/esm/api/index.mjs';
import Ajv2020 from '../packages/shared/node_modules/ajv/dist/2020.js';
import { BUSINESS_OUTCOME_SCHEMA } from '../packages/shared/dist/flow-business-outcome.js';
import { syncProductPreprocessPublishGraph } from "./sync-product-preprocess-publish-flow.mjs";
import { PRODUCT_INPUT_SCHEMA } from "./sync-product-preprocess-flow.mjs";

const books = {
  capture: { id: "book-capture", name: "1688-offer-snatch" },
  publish: { id: "book-publish", name: "doudian-publish-canonical" },
};

test('sync selects profile and delegates draft or publish decisions to one book', () => {
  const graph = syncProductPreprocessPublishGraph({ nodes: [], edges: [] }, books);
  const input = graph.nodes.find((node) => node.id === 'flow-input');
   assert.deepEqual(input.config.params.map((param) => param.name), ['offerUrl', 'profile', 'category', 'preprocessConfig']);
  assert.deepEqual(input.config.params[2].schema, PRODUCT_INPUT_SCHEMA.properties.category);
  const branch = graph.nodes.find((node) => node.id === 'branch-ready');
  assert.deepEqual(branch.config, {
    cases: [{ id: 'draftable', label: '具备填表条件', left: '$.publication.canDraft', op: 'isTrue' }], otherwise: true,
  });
  const publish = graph.nodes.find((node) => node.id === 'book-publish');
  assert.deepEqual(publish.config, { bookId: books.publish.id, mode: 'auto', constants: { mode: 'auto' }, resumePolicy: 'verify-before-retry' });
  assert.equal(graph.nodes.some((node) => node.id === 'book-publish-draft'), false);
  assert.deepEqual(graph.edges.filter((edge) => edge.target === publish.id).map((edge) => [edge.targetHandle, edge.srcPath]), [['product', '$.canonical'], ['publication', '$.publication']]);
});

test("sync is idempotent", () => {
  const once = syncProductPreprocessPublishGraph({ nodes: [], edges: [] }, books);
  assert.deepEqual(syncProductPreprocessPublishGraph(once, books), once);
});

const engine = await tsImport('../packages/console/src/flows/flow-exec.ts', import.meta.url);
const { resolvePortsClient } = await tsImport('../packages/console/web/src/lib/flow-ports-client.ts', import.meta.url);
const validateOutcome = new Ajv2020({ strict: false }).compile(BUSINESS_OUTCOME_SCHEMA);

function executeAfterPreprocessing(preprocess, bookReceipt) {
  const graph = syncProductPreprocessPublishGraph({ nodes: [], edges: [] }, books);
  const outputs = new Map([['script-preprocess', { output: preprocess }]]);
  const statuses = new Map(graph.nodes.map((node) => [node.id, ['flow-input', 'book-capture', 'script-preprocess'].includes(node.id) ? 'success' : 'pending']));
  const calledBooks = [];
  for (let tick = 0; tick < graph.nodes.length; tick += 1) {
    for (const id of engine.skippedNodeIds(graph, statuses, engine.branchChoicesOf(graph, outputs))) statuses.set(id, 'skipped');
    const ready = engine.readyNodeIds(graph, statuses);
    if (!ready.length) break;
    for (const id of ready) {
      const node = graph.nodes.find((candidate) => candidate.id === id);
      const input = engine.resolveInputs(node, graph, outputs);
      if (node.type === 'branch') outputs.set(id, { [engine.selectBranch(node.config, input.input)]: input.input });
      else if (node.type === 'book') {
        calledBooks.push({ id, input });
        outputs.set(id, { outputs: bookReceipt, status: 'success' });
      } else if (node.type === 'merge') outputs.set(id, { output: engine.mergeValue(node.config, input) });
      else if (node.type === 'flowOutput') outputs.set(id, { value: input.value });
      else assert.fail(`unexpected runnable node: ${node.type}`);
      statuses.set(id, 'success');
    }
  }
  return { graph, outputs, statuses, calledBooks };
}

for (const [name, publication, expectedBook, expectedStatus] of [
  ['cannot fill form', { canPublish: false, canDraft: false, missingRequired: ['营业资质'] }, false, 'needs_input'],
  ['blocked', { canPublish: false, canDraft: false, missingRequired: [] }, false, 'blocked'],
  ['publish receipt', { canPublish: true, canDraft: true, missingRequired: [] }, true, 'published'],
  ['draft receipt', { canPublish: false, canDraft: true, missingRequired: ['营业资质'] }, true, 'draft_saved'],
  ['uncertain receipt', { canPublish: true, canDraft: true, missingRequired: [] }, true, 'needs_verification'],
]) test(`real graph reaches business exit: ${name}`, () => {
  const outcome = { status: expectedStatus, reason: name, missingRequired: publication.missingRequired };
  const preprocess = { canonical: { title: '商品' }, publication, outcome };
  const result = executeAfterPreprocessing(preprocess, { outcome });
  assert.deepEqual(result.calledBooks.map((call) => call.id), expectedBook ? ['book-publish'] : []);
  if (expectedBook) assert.deepEqual(result.calledBooks[0].input, { product: { title: '商品' }, publication, mode: 'auto' });
  assert.equal(result.statuses.get('flow-business-outcome'), 'success');
  assert.deepEqual(result.outputs.get('flow-business-outcome')?.value, outcome);
  assert.equal(validateOutcome(outcome), true, JSON.stringify(validateOutcome.errors));
  assert.equal(result.graph.nodes.some((node) => node.id === 'flow-output'), false);
});

test('business exit wires use real resolved ports and shared outcome schema', () => {
  const graph = syncProductPreprocessPublishGraph({ nodes: [], edges: [] }, books);
  const ports = resolvePortsClient(graph, Object.values(books), []);
  const edges = graph.edges.filter((edge) => /outcome/.test(edge.target) || /outcome/.test(edge.source));
  assert.equal(edges.length, 3);
  for (const edge of edges) {
    assert.ok(ports.get(edge.source).some((port) => port.id === edge.sourceHandle && port.direction === 'out'), edge.id);
    assert.ok(ports.get(edge.target).some((port) => port.id === edge.targetHandle && port.direction === 'in'), edge.id);
  }
  const output = graph.nodes.find((node) => node.id === 'flow-business-outcome');
  assert.equal(output.label, '业务结果');
  assert.equal(output.config.schema.required.includes('missingRequired'), true);
});
