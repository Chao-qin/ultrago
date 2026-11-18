import assert from 'node:assert/strict';
import test from 'node:test';
import { BUSINESS_OUTCOME_SCHEMA, summarizeFlowRun } from './flow-business-outcome.js';

const outcome = { status: 'sent', label: '已送达', level: 'success', reason: '服务返回回执', missingRequired: [], resourceId: 'message-1' };
const graph = {
  nodes: [
    { id: 'arbitrary-task', type: 'book', config: { resumePolicy: 'verify-before-retry' } },
    { id: 'result', type: 'flowOutput', config: { portId: 'value', schema: BUSINESS_OUTCOME_SCHEMA } },
  ],
  edges: [{ source: 'arbitrary-task', sourceHandle: 'outputs', srcPath: '$.outcome', target: 'result', targetHandle: 'value' }],
};
const row = (value: unknown = outcome) => ({ nodeId: 'arbitrary-task', status: 'success', runId: 'run-1', outputJson: JSON.stringify({ outputs: { outcome: value } }) });

test('business results follow declared output wires for any book and status', () => {
  const result = summarizeFlowRun({ status: 'success', graphSnapshot: graph, nodes: [row()] });
  assert.equal(result?.status, 'sent');
  assert.equal(result?.resourceId, 'message-1');
  assert.equal(result?.runId, 'run-1');
});

test('renaming every node does not change business classification', () => {
  const renamed = {
    nodes: graph.nodes.map((node) => ({ ...node, id: `new-${node.id}` })),
    edges: graph.edges.map((edge) => ({ ...edge, source: `new-${edge.source}`, target: `new-${edge.target}` })),
  };
  const result = summarizeFlowRun({ status: 'success', graphSnapshot: renamed, nodes: [{ ...row(), nodeId: 'new-arbitrary-task' }] });
  assert.equal(result?.status, 'sent');
});

test('a protected attempted operation without a result requires verification', () => {
  const result = summarizeFlowRun({ status: 'failed', graphSnapshot: graph, nodes: [{ nodeId: 'arbitrary-task', status: 'failed', startedAt: new Date(), runId: 'run-1' }] });
  assert.equal(result?.status, 'needs_verification');
  assert.equal(result?.runId, 'run-1');
});

test('a downstream failure preserves a verified operation result', () => {
  assert.equal(summarizeFlowRun({ status: 'failed', graphSnapshot: graph, nodes: [row()] })?.status, 'sent');
});

test('unstarted failures are not reported as external operations', () => {
  assert.equal(summarizeFlowRun({ status: 'failed', graphSnapshot: graph, nodes: [{ nodeId: 'arbitrary-task', status: 'skipped' }] })?.status, 'failed');
});

test('ordinary outputs and familiar product node names do not opt into business reporting', () => {
  assert.equal(summarizeFlowRun({ status: 'success', graphSnapshot: {
    nodes: [{ id: 'script-preprocess', type: 'script', config: {} }, { id: 'book-publish', type: 'book', config: {} }], edges: [],
  }, nodes: [] }), null);
});

test('active runs do not claim a final result', () => {
  for (const status of ['pending', 'running', 'paused']) {
    assert.equal(summarizeFlowRun({ status, graphSnapshot: graph, nodes: [row()] }), null);
  }
});

test('malformed, offloaded and unsafe outcome evidence is handled conservatively', () => {
  for (const value of [null, { $ref: 'archive.json' }, { status: 'sent' }]) {
    assert.equal(summarizeFlowRun({ status: 'success', graphSnapshot: graph, nodes: [row(value)] })?.status, 'needs_verification');
  }
  const result = summarizeFlowRun({ status: 'success', graphSnapshot: graph, nodes: [row({ ...outcome, resourceUrl: 'javascript:alert(1)', receiptUrl: 'https://example.com/receipt' })] });
  assert.equal(result?.resourceUrl, undefined);
  assert.equal(result?.receiptUrl, 'https://example.com/receipt');
});

test('branch and merge relay business results without scripts or ID conventions', () => {
  const snapshot = {
    nodes: [
      { id: 'choice', type: 'branch', config: {} },
      { id: 'join', type: 'merge', config: {} },
      graph.nodes[1],
    ],
    edges: [
      { source: 'choice', sourceHandle: 'otherwise', srcPath: '$.outcome', target: 'join', targetHandle: 'stopped' },
      { source: 'join', sourceHandle: 'output', target: 'result', targetHandle: 'value' },
    ],
  };
  const result = summarizeFlowRun({ status: 'success', graphSnapshot: snapshot, nodes: [{ nodeId: 'choice', status: 'success', outputJson: JSON.stringify({ otherwise: { outcome: { ...outcome, status: 'needs_input' } } }) }] });
  assert.equal(result?.status, 'needs_input');
});

test('merge traversal composes projections and ignores order edges', () => {
  const snapshot = {
    nodes: [...graph.nodes, { id: 'join', type: 'merge', config: {} }],
    edges: [
      { source: 'arbitrary-task', sourceHandle: 'outputs', target: 'join', targetHandle: 'completed', srcPath: '$.nested', kind: 'data' },
      { source: 'join', sourceHandle: 'output', target: 'result', targetHandle: 'value', srcPath: '$.outcome', kind: 'data' },
      { source: 'order-only', sourceHandle: 'outputs', target: 'join', targetHandle: 'completed', kind: 'order' },
    ],
  };
  const result = summarizeFlowRun({ status: 'success', graphSnapshot: snapshot, nodes: [{ ...row(), outputJson: JSON.stringify({ outputs: { nested: { outcome } } }) }] });
  assert.equal(result?.status, 'sent');
  assert.equal(result?.runId, 'run-1');
});

test('multiple output ports referring to the same outcome do not duplicate it', () => {
  const snapshot = {
    nodes: [...graph.nodes, { ...graph.nodes[1], id: 'result2' }],
    edges: [...graph.edges, { ...graph.edges[0], target: 'result2' }],
  };
  const outputRows = ['result', 'result2'].map((nodeId) => ({ nodeId, status: 'success', outputJson: JSON.stringify({ value: outcome }) }));
  assert.equal(summarizeFlowRun({ status: 'success', graphSnapshot: snapshot, nodes: [row(), ...outputRows] })?.status, 'sent');
});
