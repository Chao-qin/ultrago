import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeScriptLanguage, normalizeScriptSchema } from './script-definition.js';

test('legacy script languages map to the supported inline runtime', () => {
  for (const language of [undefined, 'javascript', 'typescript', 'js', 'ts']) assert.equal(normalizeScriptLanguage(language), 'ts');
  assert.throws(() => normalizeScriptLanguage('python'));
});

test('script contracts must be schema objects, never silently discarded arrays or primitives', () => {
  for (const raw of ['[]', 'true', '42', '"string"', '{bad']) assert.throws(() => normalizeScriptSchema(raw));
  assert.equal(normalizeScriptSchema(undefined), '{}');
  assert.deepEqual(JSON.parse(normalizeScriptSchema('{"type":"object"}')), { type: 'object' });
});

test('script contracts reject JSON objects that are not valid JSON Schema', () => {
  assert.throws(
    () => normalizeScriptSchema('{"type":"object","required":"name"}'),
    /Schema 结构无效.*required/,
  );
  assert.throws(
    () => normalizeScriptSchema('{"properties":{"count":{"type":"bogus"}}}'),
    /Schema 结构无效.*type/,
  );
});
