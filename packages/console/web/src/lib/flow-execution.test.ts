import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateNodeStatuses, isExecutingEdge } from './flow-execution.js';

test('map iterations keep an active instance visible regardless of row order', () => {
  for (const statuses of [['running', 'success', 'failed'], ['failed', 'success', 'running']]) {
    assert.equal(aggregateNodeStatuses(statuses.map((status) => ({ nodeId: 'map-body', status }))).get('map-body'), 'running');
  }
});

test('waiting iterations remain visible and terminal failures outrank completed instances', () => {
  assert.equal(aggregateNodeStatuses([{ nodeId: 'a', status: 'success' }, { nodeId: 'a', status: 'pending' }]).get('a'), 'pending');
  assert.equal(aggregateNodeStatuses([{ nodeId: 'a', status: 'failed' }, { nodeId: 'a', status: 'success' }]).get('a'), 'failed');
  assert.equal(aggregateNodeStatuses([{ nodeId: 'a', status: 'succeeded' }]).get('a'), 'success');
});

test('only connections into an executing target from an active or completed source animate', () => {
  const states = new Map([['done', 'success'], ['active', 'running'], ['waiting', 'pending'], ['failed', 'failed']]);
  assert.equal(isExecutingEdge('done', 'active', states), true);
  assert.equal(isExecutingEdge('active', 'waiting', states), false);
  assert.equal(isExecutingEdge('failed', 'active', states), false);
  assert.equal(isExecutingEdge('missing', 'active', states), false);
});
