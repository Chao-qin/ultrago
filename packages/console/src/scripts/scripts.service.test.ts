import assert from 'node:assert/strict';
import test from 'node:test';
import { ScriptsService } from './scripts.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function fixture(overrides: Record<string, unknown> = {}) {
  const writes: Array<{ kind: string; value: unknown }> = [];
  const script = {
    id: 'script-1',
    name: 'Echo',
    description: null,
    language: 'ts',
    source: 'return { value: params.value };',
    inputSchema: JSON.stringify({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }),
    outputSchema: JSON.stringify({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }),
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
  const prisma = {
    script: { findFirst: async () => script },
    run: {
      create: async (args: unknown) => {
        writes.push({ kind: 'create', value: args });
        return { id: 'run-1' };
      },
      update: async (args: unknown) => {
        writes.push({ kind: 'update', value: args });
        return args;
      },
    },
  } as unknown as PrismaService;
  const schemas = {
    resolve: async () => ({ jsonSchema: JSON.stringify({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }) }),
  };
  return { service: new ScriptsService(prisma, schemas as never), writes };
}

test('manual run records the saved script execution in run history', async () => {
  const { service, writes } = fixture();
  const result = await (service as unknown as {
    runManual(id: string, params: Record<string, unknown>, timeoutMs?: number): Promise<{ runId: string; status: string }>;
  }).runManual('script-1', { value: 'hello' });
  assert.deepEqual(result, { runId: 'run-1', status: 'success' });
  assert.deepEqual(writes.map((write) => write.kind), ['create', 'update']);
  assert.match(JSON.stringify(writes[0].value), /"trigger":"manual"/);
  assert.match(JSON.stringify(writes[0].value), /"scriptId":"script-1"/);
  assert.match(JSON.stringify(writes[1].value), /"status":"success"/);
});

test('draft test remains unrecorded', async () => {
  const { service, writes } = fixture();
  const result = await service.test('script-1', { value: 'hello' });
  assert.equal(result.ok, true);
  assert.deepEqual(writes, []);
});

test('standalone scripts resolve embedded registry schemas before validation', async () => {
  const { service } = fixture({
    source: 'return { value: 42 };',
    outputSchema: JSON.stringify({ 'x-bcp-schema-ref': { name: 'result', version: 1 } }),
  });
  const result = await service.test('script-1', {});
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /value/);
});

test('standalone scripts reject invalid input before execution', async () => {
  const { service } = fixture({ source: 'return { ok: true };', outputSchema: 'null' });
  const result = await service.test('script-1', { value: 42 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /^入参不满足 inputSchema/);
});
