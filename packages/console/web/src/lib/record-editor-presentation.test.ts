import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { editorEnumOptions, presentRecordSchema } from './record-editor-presentation';
import { getValue, validateEditorData } from './record-editor-model';
import type { EditorSchema } from './record-editor-model';

const PROFILE = JSON.parse(readFileSync(new URL('../../../../../.claude/skills/product-preprocess/shop-profile.schema.json', import.meta.url), 'utf8')) as EditorSchema;
const CONFIG = JSON.parse(readFileSync(new URL('../../../../../.claude/skills/product-preprocess/product-preprocess-config.schema.json', import.meta.url), 'utf8')) as EditorSchema;

test('actual shop enum fields have a business name and an explanation for every value', () => {
  const result = presentRecordSchema(PROFILE, 'shop-profile', 2);
  for (const path of [['listing', 'productType'], ['listing', 'reduceType'], ['listing', 'startSaleType'], ['listing', 'pickupMethod'], ['shipping', 'presellType'], ['afterSale', 'damagedOrderReturn']]) {
    const field = getValue(result, ['properties', path[0], 'properties', path[1]]) as EditorSchema;
    const options = editorEnumOptions(field);
    assert.ok(options?.length, path.join('.'));
    for (const option of options) {
      assert.notEqual(option.label, option.raw, path.join('.'));
      assert.ok(option.description, `${path.join('.')}=${option.raw}`);
    }
  }
  assert.equal(editorEnumOptions(getValue(result, ['properties', 'listing', 'properties', 'reduceType']) as EditorSchema)?.[0].label, '拍下减库存');
});
test('pricing strategies explain each formula without changing the contract or source schema', () => {
  const before = JSON.stringify(CONFIG);
  const result = presentRecordSchema(CONFIG, 'product-preprocess-config', 1);
  const options = editorEnumOptions(getValue(result, ['properties', 'pricing', 'properties', 'strategy']) as EditorSchema);
  assert.equal(options?.length, 4);
  assert.ok(options?.find((option) => option.value === 'percentage_plus_fixed')?.description?.includes('百分比'));
  assert.equal(JSON.stringify(CONFIG), before);
  assert.deepEqual(validateEditorData(CONFIG, { configId: 'x', shopProfile: {}, pricing: { strategy: 'invalid' } }), validateEditorData(result, { configId: 'x', shopProfile: {}, pricing: { strategy: 'invalid' } }));
});
test('metadata is scoped to the schema identity and matching typed enum values', () => {
  assert.strictEqual(presentRecordSchema(PROFILE, 'other-shop', 2), PROFILE);
  assert.strictEqual(presentRecordSchema(PROFILE, 'shop-profile', 99), PROFILE);
  const changed = structuredClone(PROFILE);
  (getValue(changed, ['properties', 'listing', 'properties', 'reduceType']) as EditorSchema).enum = ['1', '2'];
  const result = presentRecordSchema(changed, 'shop-profile', 2);
  assert.equal(editorEnumOptions(getValue(result, ['properties', 'listing', 'properties', 'reduceType']) as EditorSchema)?.[0].documented, false);
});
test('server-provided option metadata wins over the local fallback', () => {
  const changed = structuredClone(PROFILE);
  const field = getValue(changed, ['properties', 'listing', 'properties', 'reduceType']) as EditorSchema;
  field['x-enumNames'] = ['立即锁库', '付款锁库'];
  field['x-enumDescriptions'] = ['服务端说明一', '服务端说明二'];
  const result = presentRecordSchema(changed, 'shop-profile', 2);
  const options = editorEnumOptions(getValue(result, ['properties', 'listing', 'properties', 'reduceType']) as EditorSchema);
  assert.equal(options?.[0].label, '立即锁库');
  assert.equal(options?.[0].description, '服务端说明一');
});
test('generic const alternatives render typed choices and remain searchable by their meaning', () => {
  const options = editorEnumOptions({ oneOf: [{ const: 0, title: '零', description: '数字值' }, { const: '0', title: '文本零', description: '文本值' }, { const: false, title: '关闭' }, { const: null, title: '不指定' }] });
  assert.deepEqual(options?.map((option) => option.value), [0, '0', false, null]);
  assert.ok(options?.[1].search.includes('文本值'));
  assert.equal(editorEnumOptions({ oneOf: [{ type: 'string' }, { type: 'number' }] }), null);
});
test('missing metadata stays explicit rather than inventing a business meaning', () => {
  const options = editorEnumOptions({ enum: [8, '8'] });
  assert.equal(options?.[0].documented, false);
  assert.equal(options?.[0].raw, '8');
  assert.equal(options?.[1].raw, '"8"');
});
