import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScriptBudget } from './script-budget.js';
import { runScriptProcess } from './flow-runner.service.js';

const packet = (remainingMs: unknown, stage = 'image-detection') =>
  `BCP_BUDGET_V1 ${JSON.stringify({ stage, remainingMs })}\n`;

test('work estimates extend the deadline even when a packet spans stderr chunks', () => {
  const budget = new ScriptBudget(0, 600_000, 1_800_000);
  const text = packet(1_080_000);
  assert.equal(budget.consume(`ordinary log\n${text.slice(0, 14)}`, 335_000), false);
  assert.equal(budget.consume(text.slice(14), 335_000), true);
  assert.equal(budget.deadlineAt, 1_415_000);
  assert.equal(budget.stage, 'image-detection');
});

test('later work receives time without exceeding the process safety ceiling', () => {
  const budget = new ScriptBudget(10_000, 600_000, 1_800_000);
  budget.consume(packet(1_000_000), 300_000);
  budget.consume(packet(1_000_000, 'image-upload'), 1_200_000);
  assert.equal(budget.deadlineAt, 1_810_000);
  assert.equal(budget.consume(packet(2_000_000), 1_700_000), false);
  assert.equal(budget.deadlineAt, 1_810_000);
});

test('expired work cannot revive a process deadline', () => {
  const budget = new ScriptBudget(0, 100, 1_000);
  assert.equal(budget.consume(packet(500), 100), false);
  assert.equal(budget.deadlineAt, 100);
});

test('invalid and oversized messages cannot change the deadline or hide later valid work', () => {
  const budget = new ScriptBudget(0, 100, 1_000);
  for (const message of [packet(-1), packet('500'), packet(null), packet(1.5), packet(500, ''),
    'BCP_BUDGET_V1 nope\n', `BCP_BUDGET_V1 ${'x'.repeat(10_000)}\n`]) {
    assert.equal(budget.consume(message, 10), false);
  }
  assert.equal(budget.deadlineAt, 100);
  assert.equal(budget.consume(packet(500), 10), true);
  assert.equal(budget.deadlineAt, 510);
});

test('command work can outlive its initial timeout after announcing its budget', async () => {
  const result = await runScriptProcess({
    command: [process.execPath, '-e',
      `process.stderr.write(${JSON.stringify(packet(1_500))});setTimeout(() => process.stdout.write('{"ok":true}\\n'), 600);`],
    timeoutMs: 400,
  }, {}, { input: null, output: null });
  assert.equal(result.ok, true, result.stderr);
  assert.deepEqual(result.output, { ok: true });
});

test('a command with no further work estimate still times out', async () => {
  const result = await runScriptProcess({
    command: [process.execPath, '-e',
      `process.stderr.write(${JSON.stringify(packet(100))});setInterval(() => {}, 100);`],
    timeoutMs: 250,
  }, {}, { input: null, output: null });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /超时/);
});

test('managed Python work announcements reach the flow deadline controller', async () => {
  const result = await runScriptProcess({
    command: ['python3', '-c', [
      'import json, sys, time',
      'sys.path.insert(0, ".claude/skills/product-preprocess")',
      'from execution_budget import announce_work',
      'announce_work("image-detection", 1)',
      'time.sleep(0.7)',
      'print(json.dumps({"ok": True}))',
    ].join('\n')],
    timeoutMs: 500,
  }, {}, { input: null, output: null });
  assert.equal(result.ok, true, result.stderr);
  assert.deepEqual(result.output, { ok: true });
  assert.match(result.stderr, /BCP_BUDGET_V1/);
});

test('inline scripts retain their fixed deadline even if they print a budget packet', async () => {
  const result = await runScriptProcess({
    source: `process.stderr.write(${JSON.stringify(packet(2_000))});await new Promise(r => setTimeout(r, 600));return { ok: true };`,
    timeoutMs: 400,
  }, {}, { input: null, output: null });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /BCP_BUDGET_V1/);
  assert.match(result.stderr, /超时/);
});
