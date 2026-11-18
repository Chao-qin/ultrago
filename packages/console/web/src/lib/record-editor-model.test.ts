import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffValues, getValue, setValue, parseDraft, pointer, resolveEditorSchema, schemaFields, validateEditorData, submissionData } from './record-editor-model';

test('editing nested values preserves unknown keys and the original snapshot', () => {
  const before = { shop: { name: '旧名称', extra: false }, unknown: [0, null, ''] };
  const after = setValue(before, ['shop', 'name'], '新名称');
  assert.deepEqual(after, { shop: { name: '新名称', extra: false }, unknown: [0, null, ''] });
  assert.equal(before.shop.name, '旧名称');
});
test('array removal is dense and absent property restoration deletes the key', () => {
  assert.deepEqual(setValue({ rows: [1, 2, 3] }, ['rows', 1], undefined), { rows: [1, 3] });
  assert.deepEqual(setValue({ name: 'added' }, ['name'], undefined), {});
});
test('JSON pointer preserves dots, slashes and tildes in property names', () => {
  assert.equal(pointer(['a/b', '~key', 'x.y']), '/a~1b/~0key/x.y');
  assert.equal(getValue({ 'a/b': { '~key': 0 } }, ['a/b', '~key']), 0);
});
test('diff ignores object ordering, preserves scalar types and treats array changes atomically', () => {
  assert.deepEqual(diffValues({ a: 1, b: false }, { b: false, a: 1 }), []);
  assert.deepEqual(diffValues({ a: 0 }, { a: '0' }).map((d) => d.path), [['a']]);
  assert.deepEqual(diffValues({ rows: [1, 2] }, { rows: [2] }).map((d) => d.path), [['rows']]);
});
test('draft parsing preserves every JSON root type and reports invalid input', () => {
  for (const value of [null, false, 0, '', [], {}]) assert.deepEqual(parseDraft(JSON.stringify(value)), { ok: true, value });
  assert.equal(parseDraft('{broken').ok, false);
  assert.equal(parseDraft('').ok, false);
});
test('string submissions are encoded for the existing server JSON parsing boundary', () => {
  assert.equal(submissionData('hello'), '"hello"');
  assert.deepEqual(submissionData({ value: 0 }), { value: 0 });
});
test('resolves local references and preserves the declared title', () => {
  const root = { $defs: { shop: { type: 'object', properties: { name: { type: 'string', title: '店名' } } } } };
  const result = resolveEditorSchema({ $ref: '#/$defs/shop', title: '店铺' }, root);
  assert.equal(result.title, '店铺');
  assert.equal(result.type, 'object');
  assert.equal(schemaFields(result, root)[0].label, '店名');
});
test('cyclic or missing references fall back without unbounded recursion', () => {
  const root = { $defs: { loop: { $ref: '#/$defs/loop' } } };
  assert.equal(resolveEditorSchema({ $ref: '#/$defs/loop' }, root).type, undefined);
});
test('full schema validation maps required and numeric errors to editable fields', () => {
  const issues = validateEditorData({ type: 'object', required: ['name'], properties: { name: { type: 'string' }, count: { type: 'integer', minimum: 1 } } }, { count: 0 });
  assert.ok(issues.some((issue) => pointer(issue.path) === '/name'));
  assert.ok(issues.some((issue) => pointer(issue.path) === '/count'));
});

test('registry-referenced fields are validated, including required fields inside the reference', () => {
  const schema = { type: 'object', properties: { shop: { 'x-bcp-schema-ref': { name: 'shop', version: 2 } } } };
  const resolver = () => ({ type: 'object', required: ['name'], properties: { name: { type: 'string' } } });
  assert.ok(validateEditorData(schema, { shop: {} }, resolver).some((issue) => pointer(issue.path) === '/shop/name'));
});
test('unresolved registry references cannot be reported as validated', () => {
  const schema = { type: 'object', properties: { shop: { 'x-bcp-schema-ref': { name: 'missing' } } } };
  assert.ok(validateEditorData(schema, { shop: {} }, () => null).some((issue) => issue.message.includes('未加载')));
});
