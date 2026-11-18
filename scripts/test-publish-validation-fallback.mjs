import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const book = JSON.parse(readFileSync(new URL('../resource/playbooks/doudian-publish-canonical.json', import.meta.url), 'utf8'));
const validation = book.steps.find((step) => step.action?.params?.code?.some((line) => line.includes(".find(b => (b.innerText || '').trim() === '填写检查')")));
const submit = book.steps.find((step) => step.action?.params?.code?.some((line) => line.includes("const want = mode === 'publish'")));
const receiptReload = book.steps.find((step) => step.goal?.startsWith('独立刷新回执页'));
const receipt = book.steps.find((step) => step.action?.params?.code?.some((line) => line.includes('const recordOf =')));

function harness(errors, requestedMode = 'publish', publication = { canPublish: false, canDraft: false, missingRequired: [] }) {
  const storage = new Map();
  const clicks = [];
  const product = { title: { text: '测试商品标题' } };
  const location = { origin: 'https://fxg.jinritemai.com', pathname: '/ffa/g/create' };
  Object.defineProperty(location, 'href', {
    get: () => location.origin + location.pathname,
    set: (url) => { location.pathname = new URL(url).pathname; },
  });
  const element = (text) => ({
    textContent: text, innerText: text, children: [], parentElement: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    scrollIntoView() {},
    contains: () => false,
    dispatchEvent(event) {
      if (event.type === 'click') {
        clicks.push(text);
        if (text !== '填写检查') document.body.innerText = '保存成功';
      }
    },
  });
  const button = element('填写检查');
  const tags = errors.map((error) => ({ ...element('错误'), parentElement: element(error) }));
  const row = { innerText: `${product.title.text} ID:123456789012 草稿`,
    querySelectorAll: () => [], __reactFiber$test: { memoizedProps: { record: { product_id: '123456789012' } } } };
  const document = {
    body: { innerText: '' }, elementFromPoint: () => null,
    querySelectorAll(selector) {
      if (selector === 'button') return [button];
      if (selector === '.sp-tag-content') return tags;
      if (selector === 'button,span,div') return [element('保存草稿'), element('发布商品')];
      if (selector === 'tr,[class*=row]') return [row];
      return [];
    },
  };
  const context = {
    document, location, bcpDeadline: Date.now() + 60_000,
    bcpWait: { sleep: async () => {} }, setTimeout: (callback) => callback(),
    bcpDom: {
      visible: () => true,
      press: (target) => { target.dispatchEvent({ type: 'click' }); return true; },
    },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    MouseEvent: class { constructor(type) { this.type = type; } },
    PointerEvent: class { constructor(type) { this.type = type; } },
  };
  context.window = context;
  context.addEventListener = () => {};
  const run = (code) => runInNewContext(code.join('\n')
    .replaceAll('{{mode}}', requestedMode)
    .replaceAll('{{publication}}', JSON.stringify(publication))
    .replaceAll('{{product.title.text}}', product.title.text)
    .replaceAll('{{product}}', JSON.stringify(product)), context);
  return { run, clicks, location };
}

test('publish falls back to draft after platform validation errors and reports actual receipt', async () => {
  const h = harness(['适用年龄必填']);
  const checked = await h.run(validation.action.params.code);
  assert.equal(checked.ok, true);
  assert.equal(checked.mode, 'draft');
  assert.equal(await h.run(validation.verify.evalCheck.code), true);
  const submitted = await h.run(submit.action.params.code);
  assert.equal(submitted.mode, 'draft');
  assert.equal(h.clicks.includes('发布商品'), false);
  assert.equal(h.location.pathname, '/ffa/g/draft');
  const result = await h.run(receipt.action.params.code);
  assert.equal(result.mode, 'draft');
  assert.match(result.reason, /适用年龄必填/);
});

test('complete fields publish; explicit draft remains draft', async () => {
  for (const mode of ['publish', 'draft']) {
    const h = harness([], mode);
    assert.equal((await h.run(validation.action.params.code)).mode, mode);
    assert.equal(await h.run(validation.verify.evalCheck.code), true);
    assert.equal((await h.run(submit.action.params.code)).mode, mode);
    assert.equal(h.clicks.at(-1), mode === 'publish' ? '发布商品' : '保存草稿');
  }
});

test('auto mode selects publish or draft inside the book from preprocessing eligibility', async () => {
  for (const canPublish of [true, false]) {
    const h = harness([], 'auto', { canPublish, canDraft: true, missingRequired: canPublish ? [] : ['资质'] });
    const checked = await h.run(validation.action.params.code);
    assert.equal(checked.mode, canPublish ? 'publish' : 'draft');
    assert.equal(await h.run(validation.verify.evalCheck.code), true);
    assert.equal((await h.run(submit.action.params.code)).mode, checked.mode);
  }
});

test('auto mode cannot submit a blocked or malformed eligibility decision', async () => {
  for (const publication of [undefined, { canPublish: true, canDraft: false }, { canPublish: 'false', canDraft: true }]) {
    const h = harness([], 'auto', publication);
    await assert.rejects(() => h.run(validation.action.params.code), /publication/i);
    assert.equal((await h.run(submit.action.params.code)).ok, false);
    assert.deepEqual(h.clicks.filter((label) => label !== '填写检查'), []);
  }
});

test('submission requires a completed validation result', async () => {
  const h = harness([]);
  assert.equal((await h.run(submit.action.params.code)).ok, false);
  assert.deepEqual(h.clicks, []);
});

test('receipt refresh is separate from the read eval', () => {
  assert.equal(receiptReload?.action?.method, 'browser.reload');
  assert.deepEqual(receiptReload?.after, { all: ['receiptReady'] });
  const receiptCode = receipt.action.params.code.join('\n');
  assert.doesNotMatch(receiptCode, /location\.reload\(\)/);
  assert.match(receiptCode, /bcpWait\.until\(\(\) => !!findRow\(\)/);
});
