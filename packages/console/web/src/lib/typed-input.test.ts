import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumOptionIndex, jsonInputText, parseJsonInput } from './typed-input';

test('JSON inputs preserve invalid drafts and distinguish blank, null and structured values', () => {
  assert.equal(parseJsonInput(' '), undefined);
  assert.equal(parseJsonInput('null'), null);
  assert.equal(parseJsonInput('{unfinished'), '{unfinished');
  assert.deepEqual(parseJsonInput('{"enabled":false}'), { enabled: false });
  assert.equal(jsonInputText(null), 'null');
});

test('enum options preserve the difference between numeric, boolean and string values', () => {
  const options = [0, '0', false, 'false'];
  assert.equal(enumOptionIndex(options, 0), '0');
  assert.equal(enumOptionIndex(options, false), '2');
  assert.equal(enumOptionIndex(options, 'false'), '3');
  assert.equal(enumOptionIndex(options, null), undefined);
});
