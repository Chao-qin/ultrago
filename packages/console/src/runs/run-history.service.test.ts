import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunHistoryService } from './run-history.service.js';

function historyRepository() {
  const calls: Array<{ source: string; operation: string; query: Record<string, unknown> }> = [];
  const row = (id: string, day: number, targetType: string) => ({
    id, queuedAt: new Date(`2026-09-0${day}`), targetType, status: 'success', trigger: 'manual', mode: 'auto', durationMs: 10, deletedAt: null,
    book: targetType === 'book' ? { name: 'Book' } : null,
    script: targetType === 'script' ? { name: 'Script' } : null,
    flow: targetType === 'flow' ? { name: 'Flow' } : null,
  });
  const runRows = [row('book-new', 5, 'book'), row('script', 3, 'script'), row('book-old', 1, 'book')];
  const flowRows = [row('flow-new', 4, 'flow'), row('flow-old', 2, 'flow')];
  const repository = (source: string, rows: ReturnType<typeof row>[]) => ({
    count: async (query: Record<string, unknown>) => { calls.push({ source, operation: 'count', query }); return rows.length; },
    findMany: async (query: Record<string, unknown>) => { calls.push({ source, operation: 'findMany', query }); return rows.slice(0, query.take as number); },
  });
  const tx = { run: repository('run', runRows), flowRun: repository('flow', flowRows) };
  const prisma = { $transaction: async (callback: (transaction: typeof tx) => unknown) => callback(tx) };
  return { service: new RunHistoryService(prisma as never), calls };
}

test('history pagination combines both sources before taking the requested page', async () => {
  const { service } = historyRepository();
  const second = await service.list({ page: '2', pageSize: '2' });
  assert.equal(second.total, 5);
  assert.deepEqual(second.items.map((row) => row.id), ['script', 'flow-old']);
  assert.equal(second.items[1].key, 'flow:flow-old');
  const pastEnd = await service.list({ page: '99', pageSize: '2' });
  assert.equal(pastEnd.page, 3);
  assert.deepEqual(pastEnd.items.map((row) => row.id), ['book-old']);
});

test('type, status, deletion and search reach the repository and disabled sources are not queried', async () => {
  const { service, calls } = historyRepository();
  await service.list({ targetType: 'script', status: 'failed', search: '  price check  ' });
  assert.equal(calls.some((call) => call.source === 'flow'), false);
  for (const call of calls) {
    assert.deepEqual(call.query.where, {
      deletedAt: null, status: { in: ['failed'] }, targetType: 'script',
      OR: [{ book: { name: { contains: 'price check' } } }, { script: { name: { contains: 'price check' } } }, { flow: { name: { contains: 'price check' } } }],
    });
  }
});

test('invalid statuses reject before any repository query', async () => {
  const { service, calls } = historyRepository();
  await assert.rejects(service.list({ status: 'made-up' }));
  assert.deepEqual(calls, []);
});
