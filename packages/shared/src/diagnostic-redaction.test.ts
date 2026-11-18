import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactDiagnostic as redact } from './index.js';

test('nested diagnostic copies remove credential key variants and preserve business IDs', () => {
  const value = { productId: '123', values: [false, 0, null, { ACCESS_TOKEN: 'secret', 'api-key': 'secret', Authorization: 'secret', Cookie: 'secret', sessionId: 'secret', pass_word: 'secret', refreshToken: 'secret' }], nested: '{"access_token":"secret","productId":"123"}' };
  const before = JSON.stringify(value);
  const safe = redact(value) as typeof value;
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.equal(JSON.stringify(value), before);
  assert.equal(JSON.parse(safe.nested).productId, '123');
  assert.equal(safe.productId, '123');
  assert.deepEqual(safe.values.slice(0, 3), [false, 0, null]);
});

test('URLs strip credentials and sensitive query/hash parameters but retain safe product references', () => {
  const safe = redact({ url: 'https://user:secret@example.com/item?productId=123&access_token=secret#session=secret', invalid: 'javascript:secret()', message: 'request https://example.com/?api_key=secret failed', bearer: 'Bearer secret', raw: '{"password":"secret', harmless: '商品 123 未通过校验' }) as Record<string, string>;
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.equal(new URL(safe.url).searchParams.get('productId'), '123');
  assert.equal(safe.harmless, '商品 123 未通过校验');
});

test('ordinary diagnostic labels with colons remain readable', () => {
  for (const value of ['Error: product validation failed', 'SKU: missing required size']) assert.equal(redact(value), value);
});

test('truncated escaped JSON at different depths omits undecodable credential originals', () => {
  let encoded = JSON.stringify({ access_token: 'fixture-secret', productId: '123' });
  for (let depth = 1; depth <= 5; depth++) {
    encoded = JSON.stringify(encoded);
    for (const cut of [1, 2, 3, 5, 9]) {
      const damaged = encoded.slice(0, -cut);
      const source = { damaged, message: `request failed: ${damaged}` };
      const before = JSON.stringify(source);
      const safe = redact(source);
      assert.equal(JSON.stringify(safe).includes('fixture-secret'), false, `depth=${depth}, cut=${cut}`);
      assert.equal(JSON.stringify(source), before);
      assert.deepEqual(redact(safe), safe);
    }
  }
  const minimal = JSON.stringify(JSON.stringify({ access_token: 'fixture-secret' })).slice(0, -3);
  assert.equal(String(redact(minimal)).includes('fixture-secret'), false);
});

test('malformed credential text shares structured key detection and strips embedded URL credentials', () => {
  const values = [
    '{"api.key":"fixture-secret',
    '{"session_token":"fixture-secret',
    '{"passwd":"fixture-secret',
    '{"private.key":"fixture-secret',
    '{"api key":"fixture-secret',
    '{"link":"https://user:fixture-secret@example.com/product/123',
    '{"link":"https://fixture-secret@example.com/product/123',
    '{"link":"https://example.com/product/123#fixture-secret',
    String.raw`{"link":"https:\/\/user:fixture-secret@example.com/product/123`,
    String.raw`{"api\u002ekey":"fixture-secret`,
    'request failed: api.key=fixture-secret',
  ];
  for (const value of values) {
    assert.equal(String(redact(value)).includes('fixture-secret'), false, value);
  }
  assert.equal(redact('{"productId":"123'), '{"productId":"123');
});

test('URL evidence remains marked after stripping user information and fragments and is idempotent', () => {
  for (const value of [
    'https://user:fixture-secret@example.com/product/123',
    'https://fixture-secret@example.com/product/123',
    'https://example.com/product/123#fixture-secret',
    'https://example.com/product/123?token=fixture-secret',
  ]) {
    const safe = redact(value) as string;
    assert.equal(safe.includes('fixture-secret'), false);
    assert.ok(decodeURIComponent(safe).includes('[REDACTED]'), safe);
    assert.equal(redact(safe), safe);
    assert.equal(new URL(safe).protocol, 'https:');
    assert.equal(new URL(safe).pathname, '/product/123');
  }
});

test('cycles, depth, nested JSON and prototype-like keys are bounded without mutation', () => {
  const cycle: Record<string, unknown> = { productId: '123' };
  cycle.self = cycle;
  assert.doesNotThrow(() => JSON.stringify(redact(cycle)));
  assert.equal(cycle.self, cycle);
  let deep: unknown = { password: 'secret' };
  for (let i = 0; i < 40; i += 1) deep = { next: deep };
  let encoded = '{"token":"secret"}';
  for (let i = 0; i < 15; i += 1) encoded = JSON.stringify(encoded);
  const safe = redact({ deep, encoded, proto: JSON.parse('{"__proto__":{"password":"secret"},"constructor":{"token":"secret"},"productId":"123"}') });
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.equal(Object.prototype.hasOwnProperty.call({}, 'password'), false);
  assert.equal(redact(new Date('2026-09-11T00:00:00Z')), '2026-09-11T00:00:00.000Z');
});

test('prototype-like keys retain redacted presence without changing object prototypes', () => {
  const value = JSON.parse('{"__proto__":{"password":"secret"},"constructor":{"token":"secret"},"productId":"123"}');
  const before = JSON.stringify(value);
  const safe = redact(value) as Record<string, unknown>;
  assert.equal(Object.hasOwn(safe, '__proto__'), true);
  assert.equal(safe.__proto__, '[REDACTED]');
  assert.equal(safe.constructor, '[REDACTED]');
  assert.equal(Object.getPrototypeOf(safe), Object.prototype);
  assert.equal(JSON.stringify(value), before);
});
