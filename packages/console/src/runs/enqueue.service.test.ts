import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEnqueueParams } from "./enqueue.service.js";
import { normalizeScheduleDeliveries, normalizeScheduleParams } from "../schedules/schedules.service.js";

const schema = JSON.stringify([
  { name: "limit", required: true, schema: { type: "integer", minimum: 1 } },
  { name: "enabled", required: true, schema: { type: "boolean" } },
  { name: "overwrite", required: false, default: "overwrite", schema: { type: "string", enum: ["overwrite", "error"] } },
  { name: "outFile", required: true, defaultTemplate: "{{bookName}}-{{runId}}.md", schema: { type: "string", minLength: 1 } },
]);

test("console enqueue normalization matches backend typed parameter semantics", () => {
  const values = normalizeEnqueueParams(schema, { limit: "20", enabled: "false" }, {
    bookName: "book",
    runId: "run_1",
    planId: "plan_run_1",
    uuid: "uuid_1",
    timezone: "UTC",
  });

  assert.deepEqual(values, {
    limit: 20,
    enabled: false,
    overwrite: "overwrite",
    outFile: "book-run_1.md",
  });
});

test("schedule normalization stores static defaults and defers dynamic defaults", () => {
  const values = JSON.parse(normalizeScheduleParams(schema, JSON.stringify({ limit: "20", enabled: "false" }))) as Record<string, unknown>;
  assert.deepEqual(values, { limit: 20, enabled: false, overwrite: "overwrite" });
});

test("console rejects boolean garbage instead of coercing it to false", () => {
  assert.throws(
    () => normalizeEnqueueParams(schema, { limit: 2, enabled: "maybe" }, {
      bookName: "book",
      runId: "run_1",
      planId: "plan_run_1",
      uuid: "uuid_1",
    }),
    /must be boolean/,
  );
});

test("schedule delivery overrides use the shared resolver and reject invalid JSON shapes", () => {
  assert.equal(normalizeScheduleDeliveries('[{"kind":"print"}]'), '[{"kind":"print","on":"success","format":"markdown"}]');
  assert.throws(() => normalizeScheduleDeliveries("null"), /array/);
  assert.throws(() => normalizeScheduleDeliveries('[{"kind":"webhook"}]'), /requires url/);
});

for (const busy of [false, true]) {
  test(`flow enqueue links both identities before exposing a ${busy ? 'queued' : 'pending'} run`, async () => {
    const { EnqueueService } = await import('./enqueue.service.js');
    const calls: string[] = [];
    let created: Record<string, unknown> | undefined;
    const tx = {
      run: {
        findFirst: async ({ where }: any) => where.dedupeKey ? null : busy ? { id: 'busy' } : null,
        count: async () => 0,
        create: async ({ data }: any) => { calls.push('create'); created = data; return data; },
      },
      flowNodeRun: { updateMany: async ({ where, data }: any) => {
        assert.equal(where.id, 'node');
        assert.deepEqual(where.OR, [{ runId: null }, { runId: created!.id }]);
        assert.equal(data.runId, created!.id);
        calls.push('link');
        return { count: 1 };
      } },
    };
    const prisma = {
      book: { findFirst: async () => ({ id: 'book', name: 'book', paramSchema: '[]', deliveriesJson: '[]' }) },
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => { const result = await fn(tx); calls.push('commit'); return result; },
    };
    const result = await new EnqueueService(prisma as never).enqueue({ bookId: 'book', trigger: 'flow', mode: 'auto', params: {}, flowNodeRunId: 'node' });
    assert.equal(created!.flowNodeRunId, 'node');
    assert.equal(result.run.status, busy ? 'queued' : 'pending');
    assert.deepEqual(calls, ['create', 'link', 'commit']);
  });
}

test('flow dedupe race repairs an unlinked winner and rejects another node ownership', async () => {
  const { EnqueueService } = await import('./enqueue.service.js');
  const { Prisma } = await import('@prisma/client');
  for (const owner of [null, 'node', 'other-node']) {
    const winner = { id: 'winner', status: 'running', flowNodeRunId: owner };
    const linked: string[] = [];
    let transactions = 0;
    const tx = {
      run: {
        findFirst: async () => winner,
        update: async ({ data }: any) => { linked.push('run'); return { ...winner, ...data }; },
      },
      flowNodeRun: { updateMany: async ({ where, data }: any) => {
        assert.equal(where.id, 'node');
        assert.equal(data.runId, 'winner');
        linked.push('node');
        return { count: 1 };
      } },
    };
    const prisma = {
      book: { findFirst: async () => ({ id: 'book', name: 'book', paramSchema: '[]', deliveriesJson: '[]' }) },
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
        if (++transactions === 1) throw new Prisma.PrismaClientKnownRequestError('race', { code: 'P2002', clientVersion: 'test' });
        return fn(tx);
      },
    };
    const pending = new EnqueueService(prisma as never).enqueue({ bookId: 'book', trigger: 'flow', mode: 'auto', params: {}, dedupeKey: 'same-key', flowNodeRunId: 'node' });
    if (owner === 'other-node') {
      await assert.rejects(pending, /another flow node/);
      assert.deepEqual(linked, []);
    } else {
      assert.equal((await pending).run.id, 'winner');
      assert.deepEqual(linked, ['node', 'run']);
    }
  }
});
