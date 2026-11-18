import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHistoryQuery, mergeHistoryPage } from './run-history.js';

test('history rejects invalid paging and target kinds', () => {
  for (const query of [{ page: '0' }, { page: '1.5' }, { pageSize: '101' }, { targetType: 'invalid' }]) {
    assert.throws(() => parseHistoryQuery(query));
  }
  assert.deepEqual(parseHistoryQuery({}), { page: 1, pageSize: 25, search: '', includeDeleted: false });
});

test('mixed history pages use global time order and source-safe keys', () => {
  const rows = [
    { id: 'same', source: 'run', queuedAt: new Date('2026-09-01'), targetType: 'book' },
    { id: 'script', source: 'run', queuedAt: new Date('2026-09-03'), targetType: 'script' },
    { id: 'same', source: 'flow', queuedAt: new Date('2026-09-02'), targetType: 'flow' },
  ];
  assert.deepEqual(mergeHistoryPage(rows, 1, 2).map((row) => row.targetType), ['script', 'flow']);
  assert.deepEqual(mergeHistoryPage(rows, 2, 2).map((row) => row.targetType), ['book']);
});
