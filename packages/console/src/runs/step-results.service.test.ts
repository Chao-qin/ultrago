import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StepResultsService } from './step-results.service.js';
import { decodeStepPreview, encodeStepPreview } from './step-preview.js';

const resultId = '11111111-1111-4111-8111-111111111111';
const raw = JSON.stringify({ value: JSON.stringify({ body: 'x'.repeat(8000) }) });
const metadata = { resultId, chars: raw.length, truncated: true, upstreamTruncated: false };

test('preview metadata round trips without including the full payload', () => {
  const stored = encodeStepPreview(raw.slice(0, 4096), metadata);
  const decoded = decodeStepPreview(stored);
  assert.equal(decoded.preview.length, 4096);
  assert.deepEqual(decoded.metadata, metadata);
  assert.equal(decodeStepPreview('{"legacy":true}').preview, '{"legacy":true}');
});

function harness(runState = { id: 'run', planId: 'plan_run', status: 'success', flowNodeRunId: null as string | null }) {
  const landed = new Map<string, unknown>();
  const steps = [{ id: 'step', runId: 'run', deletedAt: null, valuePreview: encodeStepPreview(raw.slice(0, 4096), metadata) }];
  let fetches = 0;
  let backendAvailable = true;
  const prisma = {
    schemaRecord: { findFirst: async ({ where }: { where: { source: string } }) => landed.has(where.source) ? { id: 'record' } : null },
    run: { findFirst: async ({ where }: { where: { id: string; deletedAt: null } }) => where.id === 'run' ? runState : null },
    stepRun: { findFirst: async ({ where }: { where: { id: string; runId: string; deletedAt: null } }) => steps.find(step => step.id === where.id && step.runId === where.runId && step.deletedAt === where.deletedAt) ?? null },
  };
  const backend = { getStepResult: async () => { fetches++; return backendAvailable ? { raw, upstreamTruncated: false } : undefined; } };
  const landing = {
    readLandedValue: async (source: string) => landed.get(source),
    land: async (source: string, described: { outputsData: string }) => { landed.set(source, JSON.parse(described.outputsData)); },
  };
  const service = new StepResultsService(prisma as never, backend as never, landing as never);
  return { service, landed, steps, runState, fetches: () => fetches, expire: () => { backendAvailable = false; } };
}

test('flow steps stay available on demand without archiving successful intermediate values', async () => {
  const h = harness({ id: 'run', planId: 'plan_run', status: 'running', flowNodeRunId: 'any-node' });
  await h.service.archive('run', [{ resultId }]);
  h.runState.status = 'success';
  await h.service.archive('run', [{ resultId }]);
  assert.equal(h.landed.size, 0);
  assert.equal(h.fetches(), 0);
  assert.equal((await h.service.read('run', 'step')).raw, raw);
  h.runState.status = 'failed';
  await h.service.archive('run', [{ resultId }]);
  assert.equal(h.landed.size, 1);
});

test('complete result is read on demand using its owning run and action identity', async () => {
  const h = harness();
  const result = await h.service.read('run', 'step');
  assert.equal(result.raw, raw);
  assert.equal(result.available, true);
  assert.equal(h.fetches(), 1);
  await assert.rejects(() => h.service.read('other-run', 'step'), /not found/);
});

test('legacy truncated previews are not presented as complete results', async () => {
  const h = harness();
  h.steps[0].valuePreview = raw.slice(0, 4096);
  const result = await h.service.read('run', 'step');
  assert.equal(result.available, false);
  assert.equal(h.fetches(), 0);
});

test('archived results survive backend expiry and repeated polls do not fetch them again', async () => {
  const h = harness();
  const history = [{ valuePreview: raw.slice(0, 4096), resultId, resultChars: raw.length }];
  await h.service.archive('run', history);
  assert.equal(h.landed.size, 1);
  h.expire();
  await h.service.archive('run', history);
  const result = await h.service.read('run', 'step');
  assert.equal(result.raw, raw);
  assert.equal(h.fetches(), 1);
});

test('expired unarchived results are unavailable and missing steps cannot fetch results', async () => {
  const h = harness();
  h.expire();
  assert.equal((await h.service.read('run', 'step')).available, false);
  await assert.rejects(() => h.service.read('run', 'missing'), /step not found/);
  assert.equal(h.fetches(), 1);
});

test('different action identities archive independently', async () => {
  const h = harness();
  await h.service.archive('run', [
    { resultId },
    { resultId: '22222222-2222-4222-8222-222222222222' },
  ]);
  assert.equal(h.landed.size, 2);
  assert.equal(h.fetches(), 2);
});

test('queued archival does not wait for backend and retries without another run poll', async () => {
  const h = harness();
  let attempts = 0;
  h.service.archive = async () => ++attempts > 1;
  h.service.enqueue('run', [{ resultId }]);
  assert.equal(attempts, 0);
  const queue = h.service as unknown as { drain(): Promise<void>; pending: Map<string, { nextAt: number }> };
  await queue.drain();
  assert.equal(attempts, 1);
  for (const item of queue.pending.values()) item.nextAt = 0;
  await queue.drain();
  assert.equal(attempts, 2);
  assert.equal(queue.pending.size, 0);
  h.service.onModuleDestroy();
});
