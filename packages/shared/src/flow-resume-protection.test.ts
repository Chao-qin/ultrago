import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FlowGraph } from './flow-types.js';
import { getResumeBlockReason } from './flow-resume-protection.js';

const graph = (resumePolicy?: 'retry' | 'verify-before-retry'): FlowGraph => ({
  nodes: [{
    id: 'publish', type: 'book', label: '发布商品', position: { x: 0, y: 0 },
    config: { bookId: 'publish-book', ...(resumePolicy ? { resumePolicy } : {}) },
  }],
  edges: [],
});

test('started protected books require verification regardless of their last local status', () => {
  for (const evidence of [
    { status: 'failed', startedAt: new Date(1) },
    { status: 'running' },
    { status: 'success', iteration: 0 },
    { status: 'pending', runId: 'external-run' },
    { status: 'skipped', startedAt: '2026-09-11T00:00:00Z' },
  ]) {
    const reason = getResumeBlockReason(graph('verify-before-retry'), [
      { nodeId: 'publish', nodeType: 'book', ...evidence },
    ]);
    assert.match(reason ?? '', /核验/);
    assert.match(reason ?? '', /发布商品/);
  }
});

test('a pending book with no execution evidence may run for the first time', () => {
  assert.equal(getResumeBlockReason(graph('verify-before-retry'), [
    { nodeId: 'publish', nodeType: 'book', status: 'pending', runId: null, startedAt: null },
  ]), null);
});

test('legacy started books explain the missing recovery declaration', () => {
  assert.match(getResumeBlockReason(graph(), [
    { nodeId: 'publish', nodeType: 'book', status: 'failed', runId: 'external-run' },
  ]) ?? '', /旧.*快照.*核验/);
});

test('an explicit retry declaration permits retrying an operator-classified safe read', () => {
  assert.equal(getResumeBlockReason(graph('retry'), [
    { nodeId: 'publish', nodeType: 'book', status: 'failed', startedAt: new Date(1) },
  ]), null);
});

test('copied rows and non-book computations do not acquire a retry restriction', () => {
  assert.equal(getResumeBlockReason(graph('verify-before-retry'), []), null);
  assert.equal(getResumeBlockReason({ nodes: [], edges: [] }, [
    { nodeId: 'compute', nodeType: 'script', status: 'running' },
  ]), null);
});

const subflowGraph: FlowGraph = {
  nodes: [{
    id: 'nested', type: 'flow', label: '发布子流程', position: { x: 0, y: 0 },
    config: { flowId: 'publish-flow' },
  }],
  edges: [],
};

test('started subflows require checking prior child runs before they can be triggered again', () => {
  for (const evidence of [
    { status: 'failed', childFlowRunId: 'prior-child' },
    { status: 'running' },
    { status: 'pending', startedAt: new Date(1) },
    { status: 'success', iteration: 0 },
  ]) {
    assert.match(getResumeBlockReason(subflowGraph, [
      { nodeId: 'nested', nodeType: 'flow', ...evidence },
    ]) ?? '', /子流程.*核验/);
  }
  assert.match(getResumeBlockReason(subflowGraph, [
    { nodeId: 'nested', nodeType: 'flow', status: 'failed', childFlowRunId: 'prior-child' },
  ]) ?? '', /prior-child/);
});

test('a subflow with no execution evidence may start for the first time', () => {
  assert.equal(getResumeBlockReason(subflowGraph, [
    { nodeId: 'nested', nodeType: 'flow', status: 'pending', childFlowRunId: null, startedAt: null },
  ]), null);
});
