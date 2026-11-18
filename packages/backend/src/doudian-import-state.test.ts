import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const book = JSON.parse(readFileSync(new URL('../../../resource/playbooks/doudian-publish-canonical.json', import.meta.url), 'utf8'));
const skuStep = book.steps.find((step: any) => step.action?.params?.code?.join('\n').includes('sku-import.csv'));
const submitStep = book.steps.find((step: any) => step.action?.params?.code?.join('\n').includes('const checked = JSON.parse(sessionStorage'));
const whiteStep = book.steps.find((step: any) => step.action?.params?.code?.join('\n').includes('out.blockingErrorLeft'));
const product = { category: { categoryProps: [] }, skus: [{ specs: [{ name: '颜色', value: '红色' }], price: 10, stock: 2 }] };

/** `bcpDom` as browser.eval injects it, reduced to what this node fixture can
 *  honestly answer. The book's eval code calls `bcpDom.visible` / `bcpDom.press`
 *  (the predicate unification replaced its hand-copied versions); this context
 *  has no layout engine and no real event system, so these are STUBS keeping
 *  the same shape — not the real primitives.
 *
 *  What that means for what these tests prove: they cover the STATE MACHINE of
 *  the import step (when it re-uploads, when it stops, what it reports), never
 *  the DOM semantics underneath. Visibility and the pointer sequence are
 *  covered against a real browser in `pnpm check:dom` (groups V and P) — the
 *  only place that can see `content-visibility`, a closed `<details>`, or a
 *  covering overlay at all. Duplicating them here would be a fake defence.
 *
 *  Why this exists: the same conversion left the SIGNAL path with no `bcpDom`
 *  at all (see PROTOCOL_VERSION v9) and this fixture with no `bcpDom` either —
 *  9 tests failed with a bare "bcpDom is not defined", which reads as a broken
 *  book rather than a harness that never knew about the injection contract. */
const domStubs = () => ({
  // Visible = a non-empty box, the half of the real predicate a fake DOM can
  // answer. The elements this fixture builds report 100x20.
  visible: (el: any) => {
    const r = el?.getBoundingClientRect?.();
    return !!r && r.width > 0 && r.height > 0;
  },
  // The real press ends in a `click` event on the target and reports false when
  // something covers it; nothing can cover anything here, so it always lands.
  press: (el: any) => {
    el?.dispatchEvent?.({ type: 'click' });
    return true;
  },
  // Same reasoning: the import state machine cannot advance until the files
  // land and the control reacts, so this reproduces the observable contract
  // (assign, input then change, report the count). Writing through the
  // prototype accessor — the part that actually keeps React from discarding it
  // — needs a real one, and is asserted in check:dom's V-set group.
  setFiles: (el: any, files: any[]) => {
    el.files = [...files];
    el.dispatchEvent({ type: 'input' });
    el.dispatchEvent({ type: 'change' });
    return el.files.length;
  },
});

function fixture(options: { ready?: boolean; disabled?: boolean; error?: string; recover?: boolean; missing?: boolean } = {}) {
  let now = 0;
  let uploads = 0;
  let clicks = 0;
  let retried = false;
  let text = options.error ?? '';
  const element = (label: string, click = () => {}) => ({
    textContent: label, children: [], disabled: options.disabled ?? false,
    getBoundingClientRect: () => ({ width: 100, height: 20, left: 0, top: 0 }),
    getAttribute: () => null,
    closest() { return this; },
    dispatchEvent(event: { type: string }) { if (event.type === 'click') click(); },
  });
  const smart = element('智能识别', () => { clicks++; text = '规格选项'; });
  const retry = element('重新上传', () => { retried = true; text = ''; });
  const input = { files: [], accept: '.csv', dispatchEvent(event: { type: string }) { if (event.type === 'change') uploads++; } };
  const document = {
    body: { get innerText() { return text; } }, visibilityState: 'hidden', hasFocus: () => false,
    querySelector: (selector: string) => selector.includes('.csv') && !options.missing ? input : null,
    querySelectorAll: (selector: string) => {
      if (selector.includes('input')) return options.missing ? [] : [input];
      if (selector.includes('modal') || selector.includes('alert')) return [];
      if (options.error && !retried) return options.recover ? [retry] : [];
      return options.ready && uploads > 0 ? [smart] : [];
    },
  };
  const context = {
    document, window: {}, Date: { now: () => now }, bcpDeadline: 10000,
    bcpWait: { sleep: async (ms: number) => { now += ms; } },
    bcpDom: domStubs(),
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    Event: class { constructor(public type: string) {} },
    MouseEvent: class { constructor(public type: string) {} },
    PointerEvent: class { constructor(public type: string) {} },
    File: class {}, DataTransfer: class { items = { add() {} }; files = []; },
  };
  return { context, stats: () => ({ uploads, clicks, now }), run: () => runInNewContext(skuStep.action.params.code.join('\n').replaceAll('{{product}}', JSON.stringify(product)), context) };
}

test('SKU timeout reports missing button and does not reinject the CSV', async () => {
  const f = fixture();
  await assert.rejects(f.run(), /SKU.*超时.*button.*missing/s);
  assert.equal(f.stats().uploads, 1);
  assert.equal(skuStep.onFail, 'escalate');
});

test('SKU disabled button is distinguished from a missing button', async () => {
  await assert.rejects(fixture({ ready: true, disabled: true }).run(), /button.*disabled/s);
});

test('SKU file error stops immediately with the page message', async () => {
  const f = fixture({ error: '文件格式错误，请重新上传' });
  await assert.rejects(f.run(), /文件格式错误/);
  assert.equal(f.stats().uploads, 0);
  assert.equal(f.stats().now, 0);
});

test('SKU recognition can complete while the document is in the background', async () => {
  const f = fixture({ ready: true });
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(f.stats().uploads, 1);
  assert.equal(f.stats().clicks, 1);
});

test('SKU existing specifications are accepted without another upload', async () => {
  const f = fixture({ error: '规格选项', missing: true });
  assert.equal((await f.run()).ok, true);
  assert.equal(f.stats().uploads, 0);
});

test('SKU system error is retried only through an available reupload control', async () => {
  const f = fixture({ error: '系统处理异常', recover: true, ready: true });
  assert.equal((await f.run()).ok, true);
  assert.equal(f.stats().uploads, 1);
  await assert.rejects(fixture({ error: '系统处理异常' }).run(), /系统处理异常/);
});

test('white background is now a non-mutating optional enhancement', async () => {
  const context = {
    bcpDeadline: 0, Date: { now: () => 0 }, bcpDom: domStubs(),
    document: { body: { innerText: '识别未通过，图片存在水印logo' }, getElementById: () => null, querySelectorAll: () => [] },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  };
  const result = await runInNewContext(whiteStep.action.params.code.join('\n'), context);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, '白底图为可选项，保留平台现有状态');
});

test('SKU missing CSV input stops with an actionable message', async () => {
  await assert.rejects(fixture({ missing: true }).run(), /CSV 文件输入控件/);
});

test('SKU already imported file is observed without injecting it again', async () => {
  const f = fixture();
  const input = f.context.document.querySelector('.csv')!;
  Object.assign(input, { files: [{ name: 'sku-import.csv' }] });
  await assert.rejects(f.run(), /超时/);
  assert.equal(f.stats().uploads, 0);
});

test('SKU upload delegates file delivery to the engine primitive', () => {
  const code = skuStep.action.params.code.join('\n');
  // This assertion used to pin the delivery sequence as SOURCE TEXT — native
  // setter present, `change` once, `input` zero times — and it went red for a
  // day when the book was fixed to send both events, because two artifacts
  // disagreed and neither was the authority. The authority was always the
  // engine's own upload op, so the sequence now lives in ONE place
  // (`bcpDom.setFiles`, asserted against a real browser in check:dom's V-set
  // group) and this step just calls it.
  //
  // What is worth pinning here is that it still does: a book that re-grows its
  // own DataTransfer + prototype-descriptor copy is exactly how the three
  // hand-copied versions drifted apart in the first place.
  assert.match(code, /bcpDom\.setFiles\(/);
  assert.equal(/new DataTransfer\(|getOwnPropertyDescriptor\(/.test(code), false);
});

test('SKU CSV and spec-picture matching strip only a leading bracketed marketing prefix', () => {
  const skuCode = skuStep.action.params.code.join('\n');
  const pictureStep = book.steps.find((step: any) => step.goal?.startsWith('把每张规格图匹配'));
  const pictureCode = pictureStep.action.params.code.join('\n');
  assert.match(skuCode, /csvSpecValue\(m\[d\]\)/);
  assert.match(pictureCode, /csvSpecValue\(v\.value\)/);
  assert.match(skuCode, /replace\(\/\^\[【\\\[]/);
});

test('book has no action that uploads a main image to the optional white-background field', () => {
  const whiteUploads = book.steps.filter((step: any) =>
    step.goal?.includes('白底图') && step.action?.params?.css === '#bcp-white-bg'
  );
  assert.deepEqual(whiteUploads, []);
});

test('submission navigation suppresses the site beforeunload prompt', () => {
  const code = submitStep.action.params.code.join('\n');
  assert.match(code, /window\.onbeforeunload = null/);
  assert.match(code, /stopImmediatePropagation\(\)/);
});
