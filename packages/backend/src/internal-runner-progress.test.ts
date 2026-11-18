import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { InternalRunner } from './internal-runner.js';
import type { Request, Response } from 'express';
import type { RunFinishInfo } from './playback.js';

interface RunSnapshot {
  planId: string;
  status: string;
  ranSteps: number;
  totalSteps: number;
  error?: string;
  stepHistory: Array<{ status: string; stepIndex: number }>;
}

async function executeFixture(failure: 'local' | 'browser' | 'none' | 'cancelled' | 'escalated') {
  const directory = await mkdtemp(join(tmpdir(), 'bcp-run-progress-'));
  const previousCwd = process.cwd();
  const previousLocalEval = process.env.BCP_LOCAL_EVAL;
  const emitted: RunFinishInfo[] = [];
  let observedCursor: number | undefined;
  const events = { since: () => ({ events: [], maxSeq: 0 }), emitRunFinished: (info: RunFinishInfo) => emitted.push(info) };
  const dispatcher = { dispatch: async (_target: unknown, _method: unknown, params: { final?: boolean }) => {
    if (failure === 'cancelled' && params.final) {
      internal.handleCancel({ params: { planId: 'fixture-plan' } } as unknown as Request, response as unknown as Response);
      throw new Error('fixture browser failure');
    }
    if (failure === 'escalated' && params.final) throw Object.assign(new Error('fixture browser failure'), { errorInfo: { code: 'LOCATOR_NO_MATCH' } });
    if (failure === 'browser' && params.final) throw new Error('fixture browser failure');
    return { value: true };
  } };
  const backend = new InternalRunner({} as never, events as never, dispatcher as never);
  const internal = backend as unknown as {
    runs: Map<string, { execPromise: Promise<unknown> }>;
    handleStart(req: Request, res: Response): Promise<void>;
    handleCancel(req: Request, res: Response): void;
    call(plan: string, method: string, params: Record<string, unknown>, prior: unknown[], opts?: unknown): Promise<unknown>;
    snapshotRun(run: unknown): RunSnapshot;
  };
  const call = internal.call.bind(backend);
  internal.call = async (plan, method, params, prior, opts) => {
    if (params.final) observedCursor = internal.snapshotRun(internal.runs.get(plan)).ranSteps;
    return call(plan, method, params, prior, opts);
  };
  const steps = Array.from({ length: 35 }, (_, index) => ({
    goal: index === 34 ? 'assemble receipt' : `read fixture ${index}`,
    action: { method: index === 34 && failure === 'local' ? 'local.eval' : 'browser.eval', params: { tabId: 1, final: index === 34, code: 'throw new Error("fixture receipt assembly failure")' } },
    verify: { actionSucceeded: true },
  }));
  let responseStatus = 0;
  const response = { status: (status: number) => { responseStatus = status; return response; }, json: () => {} };
  try {
    // Playback journals its terminal result relative to cwd even with fake transports.
    process.chdir(directory);
    process.env.BCP_LOCAL_EVAL = 'on';
    await internal.handleStart({ body: {
      name: 'cursor-fixture', mode: 'auto', planId: 'fixture-plan', runId: 'fixture-run',
      target: { kind: 'chrome', instanceId: 'fixture' },
      playbookJson: JSON.stringify({ goal: 'cursor fixture', steps }),
    } } as Request, response as unknown as Response);
    assert.equal(responseStatus, 202);
    const run = internal.runs.get('fixture-plan')!;
    if (failure === 'none' || failure === 'escalated') await run.execPromise;
    else await assert.rejects(run.execPromise, /fixture (?:receipt assembly|browser) failure/);
    return { snapshot: internal.snapshotRun(run), observedCursor, emitted, steps };
  } finally {
    process.chdir(previousCwd);
    if (previousLocalEval === undefined) delete process.env.BCP_LOCAL_EVAL;
    else process.env.BCP_LOCAL_EVAL = previousLocalEval;
    await rm(join(directory, '.playbook-runs.jsonl'), { force: true });
    await rmdir(directory);
  }
}

async function persistSnapshot(snapshot: RunSnapshot, steps: unknown[]) {
  const { DispatcherService } = await tsImport(new URL('../../console/src/runs/dispatcher.service.ts', import.meta.url).href, {
    parentURL: import.meta.url,
    tsconfig: new URL('../../console/tsconfig.json', import.meta.url).pathname,
  });
  const persisted: Record<string, unknown> = {
    id: 'fixture-run', bookId: 'fixture-book', status: 'running', queuedAt: new Date(), scheduleId: null,
    book: { outputSchema: null, outputSchemaRef: null },
  };
  const run = {
    findFirst: async () => persisted,
    findUnique: async () => persisted,
    update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(persisted, data),
  };
  const tx = { run, stepRun: { deleteMany: async () => {}, create: async () => {} } };
  const prisma = { run, book: { findUnique: async () => ({ playbookJson: JSON.stringify({ steps }) }) }, $transaction: async (work: (value: typeof tx) => Promise<void>) => work(tx) };
  const service = new DispatcherService(prisma, { getRun: async () => snapshot }, {}, {}, { enqueue: () => {}, preview: () => null });
  service.watched.add(snapshot.planId);
  await service.pollWatched();
  return persisted;
}

for (const failure of ['local', 'browser'] as const) test(`${failure} failure retains the actual 35th-step cursor through console persistence`, async () => {
  const { snapshot, observedCursor, emitted, steps } = await executeFixture(failure);
  const persisted = await persistSnapshot(snapshot, steps);
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.totalSteps, 35);
  assert.equal(emitted[0].ranSteps, 34);
  assert.equal(persisted.failedStep, 34);
  assert.equal(snapshot.ranSteps, 34);
  assert.equal(observedCursor, 34);
  if (failure === 'local') assert.ok(snapshot.stepHistory.every(entry => entry.status === 'success'));
  else {
    assert.equal(snapshot.stepHistory.at(-1)?.status, 'failed');
    assert.equal(snapshot.stepHistory.at(-1)?.stepIndex, 34);
  }
});

test('successful completion still reports the completed step count and no failed step', async () => {
  const { snapshot, steps } = await executeFixture('none');
  assert.equal(snapshot.status, 'success');
  assert.equal(snapshot.ranSteps, 35);
  assert.equal((await persistSnapshot(snapshot, steps)).failedStep, null);
});

test('cancellation retains its progressed cursor and is never persisted as a failed step', async () => {
  const { snapshot, emitted, steps } = await executeFixture('cancelled');
  assert.equal(snapshot.status, 'cancelled');
  assert.equal(emitted[0].status, 'cancelled');
  assert.equal(emitted[0].ranSteps, 0);
  assert.equal(snapshot.ranSteps, 34);
  assert.equal((await persistSnapshot(snapshot, steps)).failedStep, null);
});

test('recoverable browser action failure retains its escalation and failed-history cursor', async () => {
  const { snapshot, steps } = await executeFixture('escalated');
  assert.equal(snapshot.status, 'escalated');
  assert.equal(snapshot.ranSteps, 34);
  assert.equal((await persistSnapshot(snapshot, steps)).failedStep, 34);
});
