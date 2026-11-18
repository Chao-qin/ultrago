import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectContent, safeContentHref } from './content-format';

test('explicit content types override guesses without discarding malformed data', () => {
  assert.equal(detectContent('{"ok":true}', 'text/plain').kind, 'text');
  const malformed = detectContent('{bad', 'application/json; charset=utf-8');
  assert.equal(malformed.kind, 'text');
  assert.equal(malformed.raw, '{bad');
  assert.ok(malformed.warning);
});

test('detects structured values, serialized JSON, markdown and ordinary text', () => {
  for (const value of [{ ok: true }, [1, 2], false, 0, null, '{"ok":true}', '[1,2]']) {
    assert.equal(detectContent(value).kind, 'json');
  }
  assert.equal(detectContent('# Report\n\n**Ready**').kind, 'markdown');
  assert.equal(detectContent('Price * quantity').kind, 'text');
  assert.equal(detectContent('hello <script>alert(1)</script>').kind, 'text');
  assert.equal(detectContent('').raw, '');
});

test('content links reject executable and remote file schemes', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,bad', 'file:///etc/passwd', 'java\nscript:alert(1)']) {
    assert.equal(safeContentHref(href), undefined);
  }
  assert.equal(safeContentHref('https://example.com/a'), 'https://example.com/a');
});

test('JSON beyond the raw preview limit remains structured and retains all source characters', () => {
  const raw = JSON.stringify({ value: JSON.stringify({ body: 'x'.repeat(210_000) }) });
  const result = detectContent(raw);
  assert.equal(result.kind, 'json');
  assert.equal(result.raw, raw);
});
