import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inferSchema,
  inferenceUncertainPaths,
  mergeInferredFields,
  parseContractDefault,
  parseScriptContract,
  schemaOfParams,
  schemaRefContract,
  scriptContractRef,
  resolveScriptContract,
  replaceObjectFields,
  visualContractProblems,
  validateScriptContractDefinition,
} from './script-contract.js';

test('empty stored contracts mean no declared shape', () => {
  assert.equal(parseScriptContract(undefined), null);
  assert.equal(parseScriptContract('null'), null);
  assert.equal(parseScriptContract('{}'), null);
});

test('visual fields round-trip required flags, defaults and registry citations', () => {
  const schema = schemaOfParams([
    { name: 'keyword', required: true, description: '搜索关键词', schema: { type: 'string', default: '新品' } },
    { name: 'product', required: false, schemaRef: { name: 'product', version: 2 } },
  ]);
  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      keyword: { type: 'string', default: '新品', description: '搜索关键词' },
      product: { 'x-bcp-schema-ref': { name: 'product', version: 2 } },
    },
    required: ['keyword'],
  });
});

test('advanced schemas that cannot round-trip stay in advanced mode', () => {
  assert.deepEqual(visualContractProblems({ type: 'object', oneOf: [{ type: 'string' }, { type: 'number' }] }), ['oneOf']);
  assert.deepEqual(visualContractProblems({ type: 'object', properties: { count: { type: 'integer', minimum: 1 } } }), []);
});

test('advanced schema validation distinguishes value mismatches from invalid declarations', () => {
  assert.deepEqual(validateScriptContractDefinition({
    type: 'object',
    properties: { count: { type: 'integer' } },
    required: ['count'],
  }), { ok: true, errors: [] });
  const invalid = validateScriptContractDefinition({ type: 'object', required: 'count' });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((message) => message.includes('required')));
});

test('a successful trial result produces a reviewable nested output schema', () => {
  assert.deepEqual(inferSchema({ ok: true, rows: [{ id: 1, label: 'A' }] }), {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'integer' }, label: { type: 'string' } },
          required: ['id', 'label'],
        },
      },
    },
    required: ['ok', 'rows'],
  });
});

test('ambiguous values are left unconstrained instead of inventing a type', () => {
  assert.deepEqual(inferSchema(null), {});
  assert.deepEqual(inferSchema([]), { type: 'array', items: {} });
  assert.deepEqual(inferSchema([1, 'two']), { type: 'array', items: {} });
  assert.deepEqual(inferenceUncertainPaths(inferSchema({ rows: [1, 'two'], value: null })), ['$.rows[]', '$.value']);
});

test('visual defaults keep their declared runtime type', () => {
  assert.equal(parseContractDefault('hello', { type: 'string' }), 'hello');
  assert.equal(parseContractDefault('12', { type: 'integer' }), 12);
  assert.equal(parseContractDefault('false', { type: 'boolean' }), false);
  assert.deepEqual(parseContractDefault('{"limit":2}', { type: 'object' }), { limit: 2 });
  assert.throws(() => parseContractDefault('nope', { type: 'number' }), /有效的数字/);
});

test('a whole contract can cite a pinned registry schema without another database field', () => {
  const schema = schemaRefContract({ name: 'product', version: 3 });
  assert.deepEqual(schema, { 'x-bcp-schema-ref': { name: 'product', version: 3 } });
  assert.deepEqual(scriptContractRef(schema), { name: 'product', version: 3 });
  assert.equal(scriptContractRef({ type: 'object' }), undefined);
});

test('whole-contract references resolve for forms and editor types', () => {
  const stored = schemaRefContract({ name: 'product', version: 3 });
  const resolved = resolveScriptContract(stored, () => ({ type: 'object', properties: { sku: { type: 'string' } } }));
  assert.deepEqual(resolved, { type: 'object', properties: { sku: { type: 'string' } } });
});

test('editing nested object fields preserves parent metadata and replaces only its field shape', () => {
  const original = {
    type: 'object',
    title: '分页',
    default: { limit: 20 },
    properties: { obsolete: { type: 'string' } },
    required: ['obsolete'],
  };
  assert.deepEqual(replaceObjectFields(original, [
    { name: 'limit', required: true, schema: { type: 'integer', minimum: 1 } },
    { name: 'cursor', required: false, schema: { type: 'string' } },
  ]), {
    type: 'object',
    title: '分页',
    default: { limit: 20 },
    properties: {
      limit: { type: 'integer', minimum: 1 },
      cursor: { type: 'string' },
    },
    required: ['limit'],
  });
});

test('field mode recognizes the constraints it can edit without forcing advanced JSON', () => {
  assert.deepEqual(visualContractProblems({
    type: 'object',
    properties: {
      email: { type: 'string', format: 'email', minLength: 3 },
      rows: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', properties: {} } },
    },
  }), []);
});

test('an inferred object can be adopted field by field without replacing existing fields', () => {
  const current = {
    type: 'object',
    properties: {
      keep: { type: 'string', description: '人工定义' },
      count: { type: 'string' },
    },
    required: ['keep'],
  };
  const inferred = inferSchema({ count: 2, ignored: true });
  assert.deepEqual(mergeInferredFields(current, inferred, ['count']), {
    type: 'object',
    properties: {
      keep: { type: 'string', description: '人工定义' },
      count: { type: 'integer' },
    },
    required: ['keep', 'count'],
  });
});
