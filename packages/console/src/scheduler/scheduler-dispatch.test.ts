import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SchedulerService } from './scheduler.service.js';
import { SchedulesService } from '../schedules/schedules.service.js';

const START = Date.parse('2026-09-11T00:00:00Z');
const END = START + 60_000;

function schedule(targetType: 'book' | 'flow' | 'script') {
  return {
    id: `schedule-${targetType}`, name: targetType, targetType, enabled: true, deletedAt: null,
    bookId: targetType === 'book' ? 'book-1' : null,
    flowId: targetType === 'flow' ? 'flow-1' : null,
    scriptId: targetType === 'script' ? 'script-1' : null,
    book: targetType === 'book' ? { id: 'book-1', enabled: true } : null,
    flow: targetType === 'flow' ? { id: 'flow-1', enabled: true } : null,
    script: targetType === 'script' ? { id: 'script-1' } : null,
    cronExpr: '* * * * *', timezone: 'UTC', mode: 'auto', paramsJson: '{"count":2}',
    deliveryOverridesJson: null, timeoutMs: 2000,
    createdAt: new Date(START - 60_000), updatedAt: new Date(START - 60_000),
  };
}

function harness(rows = [schedule('book'), schedule('flow'), schedule('script')]) {
  const calls: { kind: string; args: unknown[] }[] = [];
  let leases = 0;
  const prisma = {
    $executeRawUnsafe: async () => { leases++; return 1; },
    schedule: {
      findMany: async () => rows,
      findFirst: async ({ where }: { where: { id: string } }) => rows.find(row => row.id === where.id),
    },
  };
  const enqueue = { enqueue: async (...args: unknown[]) => { calls.push({ kind: 'book', args }); return { run: { id: 'book-run' } }; } };
  const flow = { trigger: async (...args: unknown[]) => { calls.push({ kind: 'flow', args }); return { id: 'flow-run' }; } };
  const script = { runForSchedule: async (...args: unknown[]) => { calls.push({ kind: 'script', args }); return { runId: 'script-run', status: 'success' }; } };
  const dispatcher = { kick: () => {} };
  const scheduler = new SchedulerService(prisma as never, enqueue as never, dispatcher as never, script as never, flow as never);
  const schedules = new SchedulesService(prisma as never, enqueue as never, dispatcher as never, script as never, flow as never);
  Object.assign(scheduler, { lastTick: START });
  return { scheduler, schedules, prisma, calls, leases: () => leases };
}

test('scheduler passes stable fire identity and schedule ownership to every target kind', async () => {
  const clock = mock.method(Date, 'now', () => END);
  try {
    const { scheduler, calls } = harness();
    await scheduler.tick();
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].args[0], {
      bookId: 'book-1', params: { count: 2 }, mode: 'auto', trigger: 'schedule', scheduleId: 'schedule-book',
      timezone: 'UTC', deliveryOverrides: undefined, dedupeKey: 'schedule:schedule-book:1789084860000',
    });
    assert.deepEqual(calls[1].args[5], { scheduleId: 'schedule-flow', dedupeKey: 'schedule:schedule-flow:1789084860000' });
    assert.deepEqual(calls[2].args[4], { scheduleId: 'schedule-script', dedupeKey: 'schedule:schedule-script:1789084860000' });
  } finally {
    clock.mock.restore();
  }
});

test('manual schedule triggers retain ownership but never collapse within the same millisecond', async () => {
  const clock = mock.method(Date, 'now', () => END);
  try {
    const { schedules, calls } = harness();
    for (const kind of ['book', 'flow', 'script']) {
      await schedules.runNow(`schedule-${kind}`);
      await schedules.runNow(`schedule-${kind}`);
    }
    for (const [offset, index] of [[0, 0], [2, 5], [4, 4]]) {
      const first = calls[offset].args[index] as { scheduleId: string; dedupeKey: string };
      const second = calls[offset + 1].args[index] as { scheduleId: string; dedupeKey: string };
      assert.ok(first?.scheduleId);
      assert.equal(second?.scheduleId, first.scheduleId);
      assert.notEqual(first?.dedupeKey, second?.dedupeKey);
    }
  } finally {
    clock.mock.restore();
  }
});

test('overlapping ticks do not reacquire a lease or begin another scan in the same instance', async () => {
  const { scheduler, prisma, leases } = harness([]);
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  prisma.schedule.findMany = async () => { await paused; return []; };
  const first = scheduler.tick();
  const second = scheduler.tick();
  release();
  await Promise.all([first, second]);
  assert.equal(leases(), 1);
});

test('a failed schedule read does not lose the scan window or leave the local guard locked', async () => {
  const clock = mock.method(Date, 'now', () => END);
  try {
    const { scheduler, prisma, calls } = harness([schedule('script')]);
    const original = prisma.schedule.findMany;
    prisma.schedule.findMany = async () => { throw new Error('read unavailable'); };
    await assert.rejects(scheduler.tick(), /read unavailable/);
    prisma.schedule.findMany = original;
    await scheduler.tick();
    assert.equal(calls.length, 1);
  } finally {
    clock.mock.restore();
  }
});

test('lease takeover does not backfill a schedule before it was created', async () => {
  const clock = mock.method(Date, 'now', () => END);
  try {
    const row = { ...schedule('script'), createdAt: new Date(START + 30_000) };
    const { scheduler, calls } = harness([row]);
    Object.assign(scheduler, { lastTick: START - 5 * 60_000 });
    await scheduler.tick();
    assert.equal(calls.length, 1);
    assert.equal((calls[0].args[2] as Date).getTime(), END);
  } finally {
    clock.mock.restore();
  }
});

test('bookkeeping updates do not erase pending fire times from the scan window', async () => {
  const clock = mock.method(Date, 'now', () => END);
  try {
    const row = { ...schedule('book'), createdAt: new Date(START - 120_000), updatedAt: new Date(START + 30_000) };
    const { scheduler, calls } = harness([row]);
    Object.assign(scheduler, { lastTick: START - 60_000 });
    await scheduler.tick();
    assert.equal(calls.length, 2);
  } finally {
    clock.mock.restore();
  }
});
