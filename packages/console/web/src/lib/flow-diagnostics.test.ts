import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveFlowDiagnostics, exportFlowDiagnostics } from './flow-diagnostics.js';
import type { FlowRunRow } from './types.js';

function run(input: unknown = { input: { canPublish: false } }): FlowRunRow {
  return {
    id: 'fixture', flowId: 'flow', graphSnapshot: JSON.stringify({ nodes: [{ id: 'branch', type: 'branch', label: '原始快照判断', config: { cases: [{ id: 'publish', left: '$.canPublish', op: 'isTrue' }, { id: 'draft', left: '$.canDraft', op: 'isTrue' }], otherwise: true } }], edges: [] }),
    status: 'success', trigger: 'manual', mode: 'auto', paramsJson: '{}', errorMessage: null, failedNodeId: null,
    queuedAt: '2026-09-11T00:00:00Z', startedAt: null, finishedAt: null, durationMs: 100,
    nodes: [{ id: 'branch-row', nodeId: 'branch', nodeType: 'branch', status: 'success', iteration: null, slot: null, runId: null, inputJson: JSON.stringify(input), outputJson: '{"otherwise":{}}', errorMessage: null, startedAt: null, finishedAt: null, durationMs: 2 }],
  };
}

test('diagnostics distinguish false, missing, not-run and missing historical input', () => {
  const fixture = run();
  const model = deriveFlowDiagnostics(fixture);
  assert.equal(model.branches[0].label, '原始快照判断');
  assert.equal(model.branches[0].selectedPort, 'otherwise');
  assert.deepEqual(model.branches[0].cases.map((row) => [row.value, row.presence]), [[false, 'present'], [undefined, 'missing']]);
  assert.equal(deriveFlowDiagnostics({ ...fixture, nodes: [] }).branches[0].state, 'not_run');
  fixture.nodes![0].inputJson = null;
  assert.equal(deriveFlowDiagnostics(fixture).branches[0].state, 'unavailable');
  fixture.nodes![0].inputJson = '{"$ref":"offloaded"}';
  assert.equal(deriveFlowDiagnostics(fixture).branches[0].state, 'unavailable');
  assert.equal(deriveFlowDiagnostics({ ...fixture, graphSnapshot: 'broken' }).snapshotAvailable, false);
});

test('redacted comparisons remain unavailable while saved output confirms the port', () => {
  const fixture = run({ canPublish: '[REDACTED]' });
  const model = deriveFlowDiagnostics(fixture);
  assert.equal(model.branches[0].cases[0].matched, null);
  assert.equal(model.branches[0].selectedPort, 'otherwise');
  fixture.nodes![0].outputJson = null;
  assert.equal(deriveFlowDiagnostics(fixture).branches[0].selectedPort, null);
});

test('phase timings use measured outer total and server resume protection with legacy notice', () => {
  const fixture = run();
  fixture.nodes![0].outputJson = JSON.stringify({ output: { phaseTimings: { totalMs: 100, stages: [{ name: 'data_preparation', durationMs: 30, status: 'completed' }] } } });
  assert.equal(deriveFlowDiagnostics(fixture).timings[0].totalMs, 100);
  assert.match(deriveFlowDiagnostics(fixture).resumeNotice!, /旧版服务/);
  assert.equal(deriveFlowDiagnostics({ ...fixture, resumeBlockReason: '请核验已提交的商品' }).resumeNotice, '请核验已提交的商品');
  assert.equal(deriveFlowDiagnostics({ ...fixture, resumeBlockReason: null }).resumeNotice, null);
});

test('failed node label resolves from the snapshot and falls back to the raw id', () => {
  // 面板要把运行级错误指名到节点上（"哪个节点挂的"）。快照里有标签就用标签，
  // 快照缺失/是旧版时退回节点 id —— 退回 id 好过退回空白，用户至少能对上线。
  const fixture = run();
  assert.equal(deriveFlowDiagnostics(fixture).failedNodeLabel, null);
  assert.equal(deriveFlowDiagnostics({ ...fixture, failedNodeId: 'branch' }).failedNodeLabel, '原始快照判断');
  assert.equal(deriveFlowDiagnostics({ ...fixture, failedNodeId: 'gone' }).failedNodeLabel, 'gone');
  assert.equal(deriveFlowDiagnostics({ ...fixture, failedNodeId: 'branch', graphSnapshot: 'broken' }).failedNodeLabel, 'branch');
});

test('diagnostic export is a marked nonmutating redacted snapshot', () => {
  const fixture = run();
  fixture.paramsJson = '{"password":"secret","productId":"123"}';
  const before = JSON.stringify(fixture);
  const exported = JSON.parse(exportFlowDiagnostics(fixture));
  assert.equal(exported.redacted, true);
  assert.equal(JSON.stringify(exported).includes('secret'), false);
  assert.equal(JSON.parse(exported.run.paramsJson).productId, '123');
  assert.equal(JSON.stringify(fixture), before);
});

test('diagnostic export omits truncated multilayer credential originals without mutating evidence', () => {
  let encoded = JSON.stringify({ access_token: 'fixture-secret' });
  for (let depth = 1; depth <= 4; depth++) {
    encoded = JSON.stringify(encoded);
    const fixture = run();
    fixture.nodes![0].inputJson = encoded.slice(0, -3);
    fixture.errorMessage = encoded.slice(0, -1);
    const before = JSON.stringify(fixture);
    const exported = exportFlowDiagnostics(fixture);
    assert.equal(JSON.parse(exported).redacted, true);
    assert.equal(exported.includes('fixture-secret'), false, `depth=${depth}`);
    assert.equal(JSON.stringify(fixture), before);
  }
});

test('branch diagnostics select wrapped input exactly like execution and retain saved ready port', () => {
  const fixture = run({ input: { projectionVerdict: { publication: { canPublish: true } } } });
  const graph = JSON.parse(fixture.graphSnapshot);
  graph.nodes[0].config.cases = [{ id: 'ready', left: '$.projectionVerdict.publication.canPublish', op: 'isTrue' }];
  fixture.graphSnapshot = JSON.stringify(graph);
  fixture.nodes![0].outputJson = '{"ready":{}}';
  const before = JSON.stringify(fixture);
  const branch = deriveFlowDiagnostics(fixture).branches[0];
  assert.equal(branch.selectedPort, 'ready');
  assert.deepEqual(branch.cases.map(item => [item.value, item.presence, item.matched]), [[true, 'present', true]]);
  assert.equal(JSON.stringify(fixture), before);
});

test('wrapped false, missing and redacted operands stay distinct with nullish and legacy fallbacks', () => {
  for (const [input, value, presence, matched] of [
    [{ input: { canPublish: false } }, false, 'present', false],
    [{ input: {} }, undefined, 'missing', false],
    [{ input: '[REDACTED]' }, undefined, 'redacted', null],
    [{ input: { canPublish: '[REDACTED]' } }, '[REDACTED]', 'redacted', null],
    [{ input: null, canPublish: true }, true, 'present', true],
    [{ canPublish: true }, true, 'present', true],
  ] as const) {
    const item = deriveFlowDiagnostics(run(input)).branches[0].cases[0];
    assert.deepEqual([item.value, item.presence, item.matched], [value, presence, matched]);
  }
  for (const input of [false, 0, '']) {
    const fixture = run({ input, canPublish: true });
    const graph = JSON.parse(fixture.graphSnapshot);
    graph.nodes[0].config.cases = [{ id: 'scalar', left: '$', op: 'isFalse' }];
    fixture.graphSnapshot = JSON.stringify(graph);
    assert.equal(deriveFlowDiagnostics(fixture).branches[0].cases[0].value, input);
  }
});

test('offloaded evidence inside the persisted input port remains unavailable', () => {
  assert.equal(deriveFlowDiagnostics(run({ input: { $ref: 'offloaded' } })).branches[0].state, 'unavailable');
});

test('redacted URL comparisons remain unavailable and preserve the actual recorded port', () => {
  const fixture = run({ left: 'https://user:first-secret@example.com/product', right: 'https://user:second-secret@example.com/product' });
  const graph = JSON.parse(fixture.graphSnapshot);
  graph.nodes[0].config.cases = [{ id: 'equal', left: '$.left', op: 'eq', right: '$.right' }];
  fixture.graphSnapshot = JSON.stringify(graph);
  const before = JSON.stringify(fixture);
  const model = deriveFlowDiagnostics(fixture);
  assert.equal(model.branches[0].cases[0].presence, 'redacted');
  assert.equal(model.branches[0].cases[0].matched, null);
  assert.equal(model.branches[0].selectedPort, 'otherwise');
  assert.equal(JSON.stringify(model).includes('first-secret'), false);
  assert.equal(JSON.stringify(fixture), before);
});
