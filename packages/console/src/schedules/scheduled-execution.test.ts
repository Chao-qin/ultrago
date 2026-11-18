import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlowsService } from '../flows/flows.service.js';
import { ScriptsService } from '../scripts/scripts.service.js';
import { EnqueueService } from '../runs/enqueue.service.js';
import { Prisma } from '@prisma/client';

interface StoredRun {
  id: string;
  status: string;
  scheduleId?: string;
  dedupeKey?: string;
  flowId?: string;
  scriptId?: string;
  queuedAt?: Date;
  [key: string]: unknown;
}

function runStore() {
  const rows = new Map<string, StoredRun>();
  let sequence = 0;
  const delegate = {
    create: async ({ data }: { data: Omit<StoredRun, 'id'> & { id?: string } }) => {
      const id = data.id ?? `run-${++sequence}`;
      if (rows.has(id)) throw Object.assign(new Error('duplicate primary key'), { code: 'P2002' });
      const row = { ...data, id } as StoredRun;
      rows.set(id, row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Partial<StoredRun> }) => {
      const row = rows.get(where.id);
      assert.ok(row, 'only an existing run can be completed');
      Object.assign(row, data);
      return row;
    },
  };
  return { rows, delegate };
}

const fire = { scheduleId: 'schedule-1', dedupeKey: 'schedule:schedule-1:1789088400000' };
const firedAt = new Date('2026-09-11T01:00:00Z');
const script = { id: 'script-1', language: 'ts', source: 'return 1;', inputSchema: '{}', outputSchema: '{}' };

function scriptHarness(store = runStore()) {
  const svc = new ScriptsService({ run: store.delegate } as never, {} as never);
  let executions = 0;
  // 进程执行是外部副作用；保留真实的运行认领与状态落库路径。
  Object.assign(svc, { execute: async () => {
    executions++;
    await Promise.resolve();
    return { ok: true, durationMs: 1 };
  } });
  return { svc, ...store, executions: () => executions };
}

function flowHarness(store = runStore()) {
  const flow = { id: 'flow-1', name: 'test', enabled: true, deletedAt: null, graphJson: '{"nodes":[],"edges":[]}' };
  const svc = new FlowsService({ flow: { findFirst: async () => flow }, flowRun: store.delegate } as never, undefined as never);
  return { svc, ...store };
}

test('script schedule attaches its owner and deduplicates concurrent fire claims across service instances', async () => {
  const first = scriptHarness();
  const second = scriptHarness({ rows: first.rows, delegate: first.delegate });
  const [a, b] = await Promise.all([
    first.svc.runForSchedule(script, {}, firedAt, 60000, fire),
    second.svc.runForSchedule(script, {}, firedAt, 60000, fire),
  ]);
  assert.equal(a.runId, b.runId);
  assert.equal(first.rows.size, 1);
  assert.equal(first.executions() + second.executions(), 1);
  assert.equal(first.rows.get(a.runId)?.scheduleId, 'schedule-1');
  assert.equal(first.rows.get(a.runId)?.dedupeKey, fire.dedupeKey);
});

test('script replay after completion returns the original result without executing again', async () => {
  const { svc, executions } = scriptHarness();
  const a = await svc.runForSchedule(script, {}, firedAt, 60000, fire);
  const b = await svc.runForSchedule(script, {}, firedAt, 60000, fire);
  assert.deepEqual(b, a);
  assert.equal(executions(), 1);
});

test('script startup exceptions settle the attributed run as failed rather than leaving it starting', async () => {
  const { svc, rows } = scriptHarness();
  Object.assign(svc, { execute: async () => { throw new Error('script startup failed'); } });
  const result = await svc.runForSchedule(script, {}, firedAt, 60000, fire);
  assert.equal(result.status, 'failed');
  assert.equal(rows.get(result.runId)?.scheduleId, 'schedule-1');
  assert.equal(rows.get(result.runId)?.errorMessage, 'script startup failed');
  const replay = await svc.runForSchedule(script, {}, firedAt, 60000, fire);
  assert.deepEqual(replay, result);
});

test('different script fire times and different schedules stay independent', async () => {
  const { svc, rows, executions } = scriptHarness();
  for (const context of [fire, { ...fire, dedupeKey: 'schedule:schedule-1:1789088460000' }, { scheduleId: 'schedule-2', dedupeKey: 'schedule:schedule-2:1789088400000' }]) {
    await svc.runForSchedule(script, {}, firedAt, 60000, context);
  }
  assert.equal(rows.size, 3);
  assert.equal(executions(), 3);
});

test('flow schedule attaches its owner and deduplicates concurrent claims across instances', async () => {
  const first = flowHarness();
  const second = flowHarness({ rows: first.rows, delegate: first.delegate });
  const [a, b] = await Promise.all([
    first.svc.trigger('flow-1', {}, 'schedule', 'auto', undefined, fire),
    second.svc.trigger('flow-1', {}, 'schedule', 'auto', undefined, fire),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(first.rows.size, 1);
  assert.equal(first.rows.get(a.id)?.scheduleId, 'schedule-1');
  assert.equal(first.rows.get(a.id)?.dedupeKey, fire.dedupeKey);
});

test('flow replay preserves a completed run instead of reinitializing it', async () => {
  const { svc, rows } = flowHarness();
  const a = await svc.trigger('flow-1', {}, 'schedule', 'auto', undefined, fire);
  rows.get(a.id)!.status = 'success';
  const b = await svc.trigger('flow-1', {}, 'schedule', 'auto', undefined, fire);
  assert.equal(b.id, a.id);
  assert.equal(b.status, 'success');
  assert.equal(rows.size, 1);
});

test('unrelated storage failures are not swallowed as duplicate execution', async () => {
  const { svc, delegate } = scriptHarness();
  delegate.create = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(svc.runForSchedule(script, {}, firedAt, 60000, fire), /storage unavailable/);
});

test('book schedule replay returns terminal runs, including after an insert race', async () => {
  for (const race of [false, true]) {
    const existing = { id: 'book-run', bookId: 'book-1', dedupeKey: fire.dedupeKey, status: 'success', queuedAt: firedAt };
    let reads = 0;
    let scheduleUpdates = 0;
    const delegate = {
      findFirst: async ({ where }: { where: { dedupeKey?: string; status?: { in: string[] } } }) => {
        reads++;
        if (race && reads === 1) return null;
        if (where.status && !where.status.in.includes(existing.status)) return null;
        return existing;
      },
      count: async () => 0,
      create: async () => { throw new Prisma.PrismaClientKnownRequestError('duplicate key', { code: 'P2002', clientVersion: 'test' }); },
    };
    const prisma = {
      book: { findFirst: async () => ({ id: 'book-1', name: 'book', paramSchema: '[]', deliveriesJson: '[]' }) },
      run: delegate,
      schedule: { update: async () => { scheduleUpdates++; } },
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(prisma),
    };
    const svc = new EnqueueService(prisma as never);
    const result = await svc.enqueue({ bookId: 'book-1', params: {}, mode: 'auto', trigger: 'schedule', ...fire });
    assert.equal(result.run.id, 'book-run');
    assert.equal(result.deduped, true);
    assert.equal(scheduleUpdates, 0);
  }
});
