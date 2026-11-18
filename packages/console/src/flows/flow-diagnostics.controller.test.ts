import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FlowRunsController } from './flows.controller.js';
import type { FlowsService } from './flows.service.js';

test('run diagnostics copy redacts credentials without changing service evidence or wire dates', async () => {
  const raw = {
    id: 'flow-run', queuedAt: new Date('2026-09-11T00:00:00Z'),
    graphSnapshot: JSON.stringify({ nodes: [{ config: { apiKey: 'graph-secret' } }], edges: [] }),
    nodes: [{ inputJson: '{"Authorization":"Bearer input-secret","productId":"123"}', outputJson: '{"ok":true}', errorMessage: 'Cookie: error-secret' }],
  };
  const before = JSON.stringify(raw);
  const controller = new FlowRunsController({ getRun: async () => raw } as unknown as FlowsService);
  const safe = await controller.find('flow-run') as typeof raw;
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.equal(JSON.stringify(raw), before);
  assert.notEqual(safe, raw);
  assert.equal(safe.queuedAt, '2026-09-11T00:00:00.000Z');
  assert.equal(JSON.parse(safe.nodes[0].inputJson).productId, '123');
  assert.equal(JSON.parse(safe.graphSnapshot).nodes.length, 1);
});

test('controller copies never expose truncated multilayer credential JSON', async () => {
  let encoded = JSON.stringify({ access_token: 'fixture-secret' });
  for (let depth = 1; depth <= 4; depth++) {
    encoded = JSON.stringify(encoded);
    const raw = { id: 'flow-run', nodes: [{ inputJson: encoded.slice(0, -3), errorMessage: encoded.slice(0, -1) }] };
    const before = JSON.stringify(raw);
    const controller = new FlowRunsController({ getRun: async () => raw } as unknown as FlowsService);
    const safe = await controller.find('flow-run');
    assert.equal(JSON.stringify(safe).includes('fixture-secret'), false, `depth=${depth}`);
    assert.equal(JSON.stringify(raw), before);
  }
});
