import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeBookCode, normalizeDelivery, validateBookV2 } from '@bcp/shared';
import { DESKTOP_BOOK_NAMES, desktopBookSchemas, isTrustedDesktopBook } from './desktop-books.js';
import { PlanRunner, type EvidenceReader } from './orchestrator.js';
import { applyParamDefaults, instantiateSteps, validatePlaybookParams } from './playbook.js';

const directory = fileURLToPath(new URL('../../../resource/playbooks', import.meta.url));
const rawSchema = fileURLToPath(new URL('../../../.claude/skills/product-preprocess/raw-1688-offer.schema.json', import.meta.url));

for (const name of DESKTOP_BOOK_NAMES) test(`desktop book ${name} validates and trusts only the shipped source`, async () => {
  const book = JSON.parse(await readFile(`${directory}/${name}.json`, 'utf8'));
  const pages = validateBookV2(book).pages;
  normalizeBookCode(book);
  const params = applyParamDefaults(book.params, name === '1688-offer-snatch' ? { offerUrl: 'https://detail.1688.com/offer/123456.html' } : {}, { bookName: name, runId: 'fixture', planId: 'fixture', uuid: 'fixture' });
  assert.deepEqual(validatePlaybookParams(book.params, params), []);
  const steps = instantiateSteps(book.steps, params);
  const runner = new PlanRunner({ networkBodies: () => ({ bodies: [], maxSeq: 0 }) } as unknown as EvidenceReader);
  assert.equal((await runner.create(book.goal, steps, undefined, undefined, pages)).total, steps.length);
  assert.equal(await isTrustedDesktopBook(book, { desktop: true, directory }), true);
  const dispatched = structuredClone(book);
  dispatched.deliveries = (book.deliveries || []).map((delivery: { kind: string; artifact?: string }) => normalizeDelivery({ ...delivery, ...(delivery.kind === 'file' ? { artifact: 'baidu-fixture-report.md' } : {}) }));
  assert.equal(await isTrustedDesktopBook(dispatched, { desktop: true, directory }), true, 'Console交付快照不应使原版执行代码失去信任');
  assert.equal(await isTrustedDesktopBook(book, { desktop: false, directory }), false);
  const changed = structuredClone(book);
  changed.steps.find((step: { action?: { method?: string } }) => step.action?.method === 'local.eval').action.params.code = 'return process.env;';
  assert.equal(await isTrustedDesktopBook(changed, { desktop: true, directory }), false);
  changed.deliveries = dispatched.deliveries;
  assert.equal(await isTrustedDesktopBook(changed, { desktop: true, directory }), false, '交付覆盖不能授权修改后的代码');
  assert.equal(await isTrustedDesktopBook({ ...book, name: '../baidu-hot-search' }, { desktop: true, directory }), false);
  for (const step of book.steps) {
    const code = step.action?.params?.code;
    if (code) assert.doesNotMatch(code, /\{\{/, 'trusted executable code must not interpolate caller parameters');
  }
});

test('bundled desktop schema citations resolve to their precise input/output contracts', async () => {
  const schemas = await desktopBookSchemas(directory, rawSchema);
  assert.deepEqual(schemas.map((schema) => [schema.name, schema.version]), [['book-input-baidu-hot-search', 1], ['book-input-1688-offer-snatch', 2], ['raw-1688-offer', 2]]);
  assert.ok(schemas[1].jsonSchema.required?.includes('offerUrl'));
  assert.ok(schemas[2].jsonSchema.required?.includes('captureMeta'));
});
