import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { FlowRunnerService, terminateScriptTree } from './flow-runner.service.js';
import type { ChildProcess } from 'node:child_process';
import { MAP_STATE_KEY, initialMapState } from './flow-exec.js';
import { FlowsService } from './flows.service.js';
import { EventEmitter } from 'node:events';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const parents = new Map(['parent', 'child'].map((id) => [id, { id, status: 'running', startedAt: new Date() }]));
  const nodes = [
    { id: 'book0', flowRunId: 'parent', nodeType: 'book', status: 'success', runId: 'done', iteration: 0 },
    { id: 'book1', flowRunId: 'parent', nodeType: 'book', status: 'running', runId: 'book-run', iteration: 1 },
    { id: 'sub', flowRunId: 'parent', nodeType: 'flow', status: 'running', childFlowRunId: 'child' },
    { id: 'passive', flowRunId: 'child', nodeType: 'transform', status: 'pending' },
    { id: 'script', flowRunId: 'child', nodeType: 'script', status: 'running' },
  ] as Array<Record<string, any>>;
  const matches = (row: Record<string, any>, where: Record<string, any>): boolean =>
    Object.entries(where).every(([key, value]) => key === 'flowRun'
      ? matches(parents.get(row.flowRunId)!, value)
      : value?.in ? value.in.includes(row[key]) : row[key] === value);
  const snapshot = () => ({ ...parents.get('parent'), graphSnapshot: JSON.stringify({ nodes: [{ id: 'book', type: 'book', config: { bookId: 'bk' }, position: { x: 0, y: 0 } }], edges: [] }), paramsJson: '{}', mode: 'auto', nodes: nodes.filter((row) => row.flowRunId === 'parent') });
  const prisma = {
    run: { update: async () => ({}) },
    flowRun: {
      findMany: async () => [snapshot()],
      findUnique: async ({ where }: any) => parents.get(where.id),
      updateMany: async ({ where, data }: any) => {
        const row = parents.get(where.id);
        if (!row || !matches(row, where)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    flowNodeRun: {
      count: async (_args: unknown) => 0,
      findMany: async ({ where }: any) => nodes.filter((row) => matches(row, where)),
      findUnique: async ({ where }: any) => nodes.find((row) => row.id === where.id),
      findFirst: async ({ where }: any) => nodes.find((row) => matches(row, where)),
      update: async ({ where, data }: any) => Object.assign(nodes.find((row) => row.id === where.id)!, data),
      updateMany: async ({ where, data }: any) => {
        const rows = nodes.filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    },
  };
  const cancelled: string[] = [];
  const runner = new FlowRunnerService(prisma as never, null as never, null as never, null as never, null as never, null as never, null as never);
  Object.assign(runner, { reconciled: true, runs: { cancel: async (id: string) => { cancelled.push(id); return { ok: true }; } } });
  return { runner, parents, nodes, cancelled, prisma, snapshot };
}

test('script cancellation is not settled until its owned process closes', async () => {
  const { runner, nodes } = harness();
  const proc = Object.assign(new EventEmitter(), { pid: 123456, exitCode: null, signalCode: null });
  (runner as any).scriptProcs.set('script', proc);
  const kill = mock.method(process, 'kill', () => true);
  try {
    const pending = runner.cancelRun('child');
    await new Promise((done) => setImmediate(done));
    assert.equal(nodes.find((row) => row.id === 'script')!.status, 'running');
    proc.emit('close', null, 'SIGKILL');
    await pending;
    assert.equal(nodes.find((row) => row.id === 'script')!.status, 'cancelled');
  } finally { kill.mock.restore(); }
});

test('cancellation recursively settles map instances and passive nodes, preserving completed work', async () => {
  const { runner, parents, nodes, cancelled } = harness();
  await runner.cancelRun('parent');
  await runner.cancelRun('parent');
  assert.deepEqual(cancelled, ['book-run']);
  assert.equal(nodes[0].status, 'success');
  assert.ok(nodes.slice(1).every((row) => row.status === 'cancelled'));
  assert.ok([...parents.values()].every((row) => row.status === 'cancelled'));
});

test('a failed termination does not skip siblings and can be retried', async () => {
  const { runner, nodes } = harness();
  let attempts = 0;
  Object.assign(runner, { runs: { cancel: async () => { if (++attempts === 1) throw new Error('backend unavailable'); return { ok: true }; } } });
  await assert.rejects(runner.cancelRun('parent'), /book1.*backend unavailable/);
  assert.equal(nodes[3].status, 'cancelled');
  assert.match(nodes[1].errorMessage, /backend unavailable/);
  await runner.cancelRun('parent');
  assert.equal(attempts, 2);
  assert.equal(nodes[1].status, 'cancelled');
});

test('late completion cannot overwrite a cancelled node', async () => {
  const { runner, nodes } = harness();
  await runner.cancelRun('parent');
  await (runner as any).finishNode('book1', 'success', { output: { late: true } });
  assert.equal(nodes[1].status, 'cancelled');
  assert.equal(nodes[1].outputJson, undefined);
});

test('cancellation waits for enqueue attachment, cancels the new book and blocks later dispatch', async () => {
  const { runner, nodes, cancelled, parents } = harness();
  nodes.splice(0, nodes.length, { id: 'book1', nodeId: 'book', flowRunId: 'parent', nodeType: 'book', status: 'pending', iteration: null });
  const started = deferred<void>();
  const enqueued = deferred<{ run: { id: string } }>();
  let key = '';
  Object.assign(runner, { enqueue: { enqueue: async ({ dedupeKey, flowNodeRunId }: any) => { key = dedupeKey; started.resolve(); const result = await enqueued.promise; nodes.find((node) => node.id === flowNodeRunId)!.runId = result.run.id; return result; } } });
  const tick = runner.advance();
  await started.promise;
  const cancellation = runner.cancelRun('parent');
  const repeated = runner.cancelRun('parent');
  assert.equal(cancellation, repeated);
  enqueued.resolve({ run: { id: 'late-book' } });
  await Promise.all([tick, cancellation]);
  assert.equal(key, 'flow:parent:book:0');
  assert.deepEqual(cancelled, ['late-book']);
  assert.equal(nodes[0].status, 'cancelled');
  assert.equal(parents.get('parent')?.status, 'cancelled');
  await runner.advance();
  assert.deepEqual(cancelled, ['late-book']);
});

test('cancellation during script contract resolution prevents spawning', async () => {
  const { runner, nodes, snapshot, prisma } = harness();
  nodes.splice(0, nodes.length, { id: 'script', nodeId: 'script', flowRunId: 'parent', nodeType: 'script', status: 'pending', iteration: null });
  const started = deferred<void>();
  const schema = deferred<null>();
  Object.assign(runner, { schemas: { resolve: async () => { started.resolve(); return schema.promise; } } });
  prisma.flowRun.findMany = async () => [{ ...snapshot(), graphSnapshot: JSON.stringify({ nodes: [{ id: 'script', type: 'script', config: { inputSchemaRef: { name: 'input' } }, position: { x: 0, y: 0 } }], edges: [] }) }];
  let spawned = false;
  Object.assign(runner, { startScriptNode: () => { spawned = true; } });
  const tick = runner.advance();
  await started.promise;
  const cancellation = runner.cancelRun('parent');
  schema.resolve(null);
  await Promise.all([tick, cancellation]);
  assert.equal(spawned, false);
  assert.equal(nodes[0].status, 'cancelled');
});

test('a map that published an item is cancelled, while a completed map remains successful', async () => {
  const { runner, nodes } = harness();
  nodes.push({ id: 'active-map', flowRunId: 'parent', nodeType: 'map', status: 'success', outputJson: JSON.stringify({ [MAP_STATE_KEY]: initialMapState([1, 2]) }) });
  nodes.push({ id: 'done-map', flowRunId: 'parent', nodeType: 'map', status: 'success', outputJson: JSON.stringify({ [MAP_STATE_KEY]: initialMapState([]) }) });
  await runner.cancelRun('parent');
  assert.equal(nodes.at(-2)?.status, 'cancelled');
  assert.equal(nodes.at(-1)?.status, 'success');
});

test('script termination signals the process group and reports permission failures', () => {
  const kill = mock.method(process, 'kill', () => true);
  try {
    terminateScriptTree({ pid: 123456 } as ChildProcess);
    assert.deepEqual(kill.mock.calls[0].arguments, [-123456, 'SIGKILL']);
    kill.mock.mockImplementation(() => { throw Object.assign(new Error('already gone'), { code: 'ESRCH' }); });
    assert.doesNotThrow(() => terminateScriptTree({ pid: 123456 } as ChildProcess));
    kill.mock.mockImplementation(() => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); });
    assert.throws(() => terminateScriptTree({ pid: 123456 } as ChildProcess), /permission denied/);
  } finally {
    kill.mock.restore();
  }
});

test('a child flow created during cancellation is recursively stopped after attachment', async () => {
  const { runner, nodes, snapshot, prisma, parents } = harness();
  nodes.splice(0, nodes.length, { id: 'sub', nodeId: 'sub', flowRunId: 'parent', nodeType: 'flow', status: 'pending', iteration: null });
  const started = deferred<void>();
  const child = deferred<{ id: string }>();
  Object.assign(runner, { flows: { trigger: async () => { started.resolve(); return child.promise; } } });
  prisma.flowRun.findMany = async () => [{ ...snapshot(), graphSnapshot: JSON.stringify({ nodes: [{ id: 'sub', type: 'flow', config: { flowId: 'child-definition' }, position: { x: 0, y: 0 } }], edges: [] }) }];
  const tick = runner.advance();
  await started.promise;
  const cancellation = runner.cancelRun('parent');
  nodes.push({ id: 'child-passive', flowRunId: 'child', nodeType: 'merge', status: 'pending' });
  child.resolve({ id: 'child' });
  await Promise.all([tick, cancellation]);
  assert.equal(parents.get('child')?.status, 'cancelled');
  assert.ok(nodes.every((row) => row.status === 'cancelled'));
});

test('map book iterations have independent enqueue identities', async () => {
  const { runner, nodes } = harness();
  const keys: string[] = [];
  Object.assign(runner, { enqueue: { enqueue: async ({ dedupeKey }: any) => { keys.push(dedupeKey); return { run: { id: 'book-run' } }; } } });
  for (const iteration of [0, 1]) {
    await (runner as any).startBookNode({ id: 'parent', mode: 'auto' }, { config: { bookId: 'bk' } }, { ...nodes[1], nodeId: 'book', iteration }, {});
  }
  assert.deepEqual(keys, ['flow:parent:book:0', 'flow:parent:book:1']);
});

test('the public flow cancellation entry invokes the runner and retries incomplete cancellations', async () => {
  const { runner, parents } = harness();
  const flows = new FlowsService(null as never, null as never);
  Object.assign(flows, { getRun: async (id: string) => parents.get(id) });
  Object.assign(runner, { flows, dispatcher: { registerTickStep: () => {} } });
  runner.onModuleInit();
  assert.equal((await flows.cancelRun('parent'))?.status, 'cancelled');
  assert.equal((await flows.cancelRun('parent'))?.status, 'cancelled');
});

test('a hung startup cannot delay stopping already attached nodes or prevent retry', async () => {
  const { runner, nodes, cancelled } = harness();
  const hung = deferred<number>();
  (runner as any).advancing.set('parent', hung.promise);
  nodes.push({ id: 'starting', flowRunId: 'parent', nodeType: 'book', status: 'running', runId: null });
  Object.assign(runner, { starting: new Set(['starting']) });
  const outcome = runner.cancelRun('parent');
  await assert.rejects(Promise.race([outcome, new Promise((_, reject) => setTimeout(() => reject(new Error('cleanup blocked by startup')), 100))]), /startup.*pending/);
  assert.deepEqual(cancelled, ['book-run']);
  assert.equal(nodes[1].status, 'cancelled');
  await assert.rejects(runner.cancelRun('parent'), /startup.*pending/);
});

test('failed cancellation retains the global acting slot until a successful retry', async () => {
  const { runner, nodes, prisma, parents, snapshot } = harness();
  nodes.splice(0, nodes.length,
    { id: 'old', flowRunId: 'parent', nodeType: 'book', status: 'running', runId: 'old-book' },
    { id: 'next', nodeId: 'book', flowRunId: 'child', nodeType: 'book', status: 'pending', iteration: null },
  );
  prisma.flowNodeRun.count = async ({ where }: any) => nodes.filter((row) => row.status === where.status && where.nodeType.in.includes(row.nodeType) && where.flowRun.status.in.includes(parents.get(row.flowRunId)!.status)).length;
  prisma.flowRun.findMany = async () => [{ ...snapshot(), id: 'child', status: 'running', nodes: [nodes[1]] }];
  let attempts = 0;
  let enqueued = 0;
  Object.assign(runner, {
    runs: { cancel: async () => { if (++attempts === 1) throw new Error('backend unavailable'); return { ok: true }; } },
    enqueue: { enqueue: async () => { enqueued++; return { run: { id: 'next-book' } }; } },
  });
  await assert.rejects(runner.cancelRun('parent'), /backend unavailable/);
  await runner.advance();
  assert.equal(enqueued, 0);
  await runner.cancelRun('parent');
  await runner.advance();
  assert.equal(enqueued, 1);
});

test('a late enqueue is stopped automatically after the cancellation response reports pending cleanup', async () => {
  const { runner, nodes, cancelled, prisma } = harness();
  nodes.splice(0, nodes.length,
    { id: 'attached', nodeId: 'attached', flowRunId: 'parent', nodeType: 'book', status: 'running', runId: 'attached-book', iteration: null },
    { id: 'starting', nodeId: 'book', flowRunId: 'parent', nodeType: 'book', status: 'pending', runId: null, iteration: null },
  );
  Object.assign(prisma.run, { findUnique: async () => ({ status: 'running' }) });
  const entered = deferred<void>();
  const enqueued = deferred<{ run: { id: string } }>();
  Object.assign(runner, { enqueue: { enqueue: async ({ flowNodeRunId }: any) => { entered.resolve(); const result = await enqueued.promise; nodes.find((node) => node.id === flowNodeRunId)!.runId = result.run.id; return result; } } });
  const tick = runner.advance();
  await entered.promise;
  await assert.rejects(runner.cancelRun('parent'), /startup cleanup pending/);
  assert.deepEqual(cancelled, ['attached-book']);
  assert.equal(nodes[1].status, 'running');
  enqueued.resolve({ run: { id: 'late-book' } });
  await tick;
  assert.deepEqual(cancelled, ['attached-book', 'late-book']);
  assert.ok(nodes.every((row) => row.status === 'cancelled'));
});

test('a hanging backend cleanup has a bounded response and keeps its eventual completion', async () => {
  const { runner, nodes } = harness();
  const stopped = deferred<{ ok: boolean }>();
  let calls = 0;
  Object.assign(runner, { runs: { cancel: async () => { calls++; return stopped.promise; } } });
  const original = globalThis.setTimeout;
  const timer = mock.method(globalThis, 'setTimeout', ((callback: () => void) => original(callback, 5)) as typeof setTimeout);
  try {
    await assert.rejects(runner.cancelRun('parent'), /termination confirmation pending/);
    assert.equal(nodes[1].status, 'running');
    await assert.rejects(runner.cancelRun('parent'), /termination confirmation pending/);
    assert.equal(calls, 1);
    stopped.resolve({ ok: true });
    await runner.cancelRun('parent');
    assert.equal(nodes[1].status, 'cancelled');
  } finally {
    timer.mock.restore();
  }
});

test('late map failure and item publication cannot overwrite cancelled nodes', async () => {
  const { runner, nodes, parents } = harness();
  nodes.splice(0, nodes.length,
    { id: 'map', nodeId: 'map', flowRunId: 'parent', nodeType: 'map', status: 'cancelled', iteration: null },
    { id: 'collect', nodeId: 'collect', flowRunId: 'parent', nodeType: 'collect', status: 'cancelled', iteration: null },
  );
  parents.get('parent')!.status = 'cancelled';
  await (runner as any).failMap('parent', 'map', 'collect', 'late failure', initialMapState([1]));
  await (runner as any).publishMapItem('map', initialMapState([2]));
  assert.deepEqual(nodes.map((row) => row.status), ['cancelled', 'cancelled']);
  assert.equal(nodes[0].outputJson, undefined);
});

test('ordinary late skips preserve cancellation and earlier map iteration history', async () => {
  const { runner, nodes, prisma, parents, snapshot } = harness();
  nodes.splice(0, nodes.length,
    { id: 'failed', nodeId: 'source', flowRunId: 'parent', nodeType: 'transform', status: 'failed', iteration: null },
    { id: 'current', nodeId: 'target', flowRunId: 'parent', nodeType: 'transform', status: 'pending', iteration: null },
    { id: 'historical', nodeId: 'target', flowRunId: 'parent', nodeType: 'transform', status: 'pending', iteration: 0 },
  );
  const update = prisma.flowNodeRun.updateMany;
  prisma.flowNodeRun.updateMany = async (args: any) => {
    if (args.data.status === 'skipped') {
      parents.get('parent')!.status = 'cancelled';
      nodes[1].status = 'cancelled';
    }
    return update(args);
  };
  const graphSnapshot = JSON.stringify({ nodes: [
    { id: 'source', type: 'transform', config: {} }, { id: 'target', type: 'transform', config: {} },
  ], edges: [{ id: 'edge', source: 'source', target: 'target' }] });
  await (runner as any).advanceOne({ ...snapshot(), graphSnapshot }, false);
  assert.equal(nodes[1].status, 'cancelled');
  assert.equal(nodes[2].status, 'pending');
});

test('restart recovery settles cancelled orphan scripts with a diagnostic and releases their slot', async () => {
  const { runner, nodes, parents } = harness();
  nodes.splice(0, nodes.length, { id: 'orphan', flowRunId: 'parent', nodeType: 'script', status: 'running' });
  parents.get('parent')!.status = 'cancelled';
  await (runner as any).reconcile();
  assert.equal(nodes[0].status, 'cancelled');
  assert.match(nodes[0].errorMessage, /重启.*无法确认/);
  assert.ok(nodes[0].finishedAt instanceof Date);
});
