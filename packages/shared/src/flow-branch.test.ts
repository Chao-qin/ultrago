import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explainBranch as explain, matchesCase, redactDiagnostic } from './index.js';
import type { BranchNodeConfig } from './flow-types.js';

test('branch explanation uses execution predicates and first match, preserving false versus absent', () => {
  const config: BranchNodeConfig = { cases: [{ id: 'ready', left: '$.canPublish', op: 'isTrue' }, { id: 'draft', left: '$.canDraft', op: 'isTrue' }], otherwise: true };
  for (const value of [true, 'true']) assert.equal(explain(config, { canPublish: value, canDraft: true }).selectedPort, 'ready');
  const result = explain(config, { canPublish: false });
  assert.equal(result.selectedPort, 'otherwise');
  assert.deepEqual(result.cases.map(({ value, presence, matched }) => ({ value, presence, matched })), [{ value: false, presence: 'present', matched: false }, { value: undefined, presence: 'missing', matched: false }]);
});

test('redacted operands never invent comparison results or selections', () => {
  const result = explain({ cases: [{ id: 'private', left: '$.token', op: 'ne', right: 'allowed' }], otherwise: true }, { token: '[REDACTED]' });
  assert.equal(result.cases[0].presence, 'redacted');
  assert.equal(result.cases[0].matched, null);
  assert.equal(result.selectedPort, null);
});

test('redacted path ancestors remain unavailable rather than becoming missing', () => {
  const config: BranchNodeConfig = { cases: [{ id: 'empty', left: '$.credentials.allowed', op: 'isEmpty' }] };
  const result = explain(config, { credentials: '[REDACTED]' });
  assert.equal(result.cases[0].presence, 'redacted');
  assert.equal(result.cases[0].matched, null);
});

test('unary comparisons ignore a redacted right operand just as the runner does', () => {
  const result = explain({ cases: [{ id: 'ready', left: '$.ready', op: 'isTrue', right: '[REDACTED]' }] }, { ready: true });
  assert.equal(result.selectedPort, 'ready');
  assert.equal(result.cases[0].matched, true);
});

test('URL redaction never turns distinct credential-bearing operands into a confirmed match', () => {
  const branchCase = { id: 'equal', left: '$.left', op: 'eq' as const, right: '$.right' };
  const config: BranchNodeConfig = { cases: [branchCase], otherwise: true };
  const pairs = [
    ['https://example.com/product?token=first-secret', 'https://example.com/product?token=second-secret'],
    ['https://user:first-secret@example.com/product', 'https://user:second-secret@example.com/product'],
    ['https://first-secret@example.com/product', 'https://second-secret@example.com/product'],
    ['https://example.com/product#first-secret', 'https://example.com/product#second-secret'],
  ];
  for (const [left, right] of pairs) {
    const input = { left, right };
    assert.equal(matchesCase(branchCase, input), false);
    const safe = redactDiagnostic(input);
    const explanation = explain(config, safe);
    assert.equal(explanation.cases[0].presence, 'redacted', left);
    assert.equal(explanation.cases[0].matched, null, left);
    assert.equal(explanation.selectedPort, null, left);
    assert.equal(matchesCase(branchCase, input), false);
  }
  const encoded = explain(config, { left: 'https://example.com/?token=%5BREDACTED%5D', right: 'https://example.com/?token=%5BREDACTED%5D' });
  assert.equal(encoded.cases[0].matched, null);
});
