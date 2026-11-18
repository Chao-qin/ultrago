import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InternalRunner } from './internal-runner.js';

test('step results retain full values with distinct identities while status stays a short preview', async () => {
  const value = { value: JSON.stringify({ body: 'x'.repeat(9000) }), truncated: true };
  const runner = new InternalRunner({} as never, {} as never, { dispatch: async () => value } as never);
  const run = { runId: 'run', planId: 'plan', ranSteps: 0, currentGoal: 'inspect', stepHistory: [], results: [], target: {}, browserContext: { observe() {} } };
  const internals = runner as unknown as {
    runs: Map<string, unknown>;
    call(plan: string, method: string, params: object, prior: unknown[]): Promise<unknown>;
    snapshotRun(run: unknown): { stepHistory: Array<{ resultId: string; valuePreview: string; resultChars: number }> };
    handleStepResult(req: unknown, res: unknown): void;
  };
  internals.runs.set('plan', run);
  await internals.call('plan', 'browser.eval', { code: 'ignored' }, []);
  await internals.call('plan', 'browser.eval', { code: 'ignored' }, []);
  const snapshot = internals.snapshotRun(run);
  assert.equal(snapshot.stepHistory[0].valuePreview.length, 4096);
  assert.equal(snapshot.stepHistory[0].resultChars, JSON.stringify(value).length);
  assert.ok(snapshot.stepHistory[0].resultId);
  assert.notEqual(snapshot.stepHistory[0].resultId, snapshot.stepHistory[1].resultId);
  assert.equal(JSON.stringify(snapshot).includes('x'.repeat(5000)), false);
  let body: { raw?: string; upstreamTruncated?: boolean } = {};
  internals.handleStepResult({ params: { planId: 'plan', resultId: snapshot.stepHistory[0].resultId } }, { json: (v: typeof body) => { body = v; } });
  assert.equal(body.raw, JSON.stringify(value));
  assert.equal(body.upstreamTruncated, true);
});
