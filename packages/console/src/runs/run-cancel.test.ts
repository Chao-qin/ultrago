import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunsService } from './runs.service.js';

test('unreachable backend cancellation remains retryable after the run is marked cancelled', async () => {
  const row = { id: 'run', status: 'running', planId: 'plan', finishedAt: null as Date | null };
  let attempts = 0;
  let deliveries = 0;
  const prisma = { run: {
    findFirst: async () => ({ ...row }),
    updateMany: async ({ data }: { data: Partial<typeof row> }) => { Object.assign(row, data); return { count: 1 }; },
  } };
  const backend = { cancelRun: async () => { attempts++; if (attempts === 1) throw new Error('fetch failed'); return { status: 'cancelled' }; } };
  const service = new RunsService(prisma as never, {} as never, backend as never, {} as never, { enqueueCancelled: async () => { deliveries++; } } as never);
  await assert.rejects(service.cancel('run'), /fetch failed/);
  assert.equal(row.status, 'cancelled');
  assert.equal((await service.cancel('run')).ok, true);
  assert.equal(attempts, 2);
  assert.equal(deliveries, 1);
});

test('a finished remote plan is a successful cancellation retry', async () => {
  const service = new RunsService({ run: { findFirst: async () => ({ status: 'cancelled', finishedAt: new Date(), planId: 'old' }) } } as never,
    {} as never, { cancelRun: async () => { throw new Error('HTTP 404: plan not found'); } } as never, {} as never, {} as never);
  assert.equal((await service.cancel('run')).ok, true);
});
