import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
let browser;
before(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] }); });
after(async () => browser?.close());

const raw = JSON.stringify({ value: JSON.stringify({ capturedAt: '2026-09-11', samples: [{ rq: JSON.stringify({ field: 'embedded-result' }) }] }) });
const step = {
  id: 'step', runId: 'run', stepIndex: 0, goal: '读取调用记录', actionMethod: 'browser.eval',
  actionParams: null, verifySummary: null, status: 'success', startedAt: '2026-09-11T00:00:00Z',
  finishedAt: '2026-09-11T00:00:01Z', durationMs: 1000, valuePreview: raw.slice(0, 40),
  errorMessage: null, resultAvailable: true, resultChars: raw.length, previewTruncated: true,
};

async function withPage(stepRow, body, exercise) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.setDefaultTimeout(5000);
  let fullReads = 0;
  await page.route('**/api/**', async route => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 403, json: {} });
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/runs/run/steps/step/result') { fullReads++; return route.fulfill({ json: body }); }
    if (path === '/api/runs/run') return route.fulfill({ json: {
      id: 'run', targetType: 'book', book: { id: 'book', name: '测试 Book' }, status: 'success',
      trigger: 'manual', mode: 'auto', planId: 'plan', paramsJson: '{}', durationMs: 1000,
      queuedAt: step.startedAt, startedAt: step.startedAt, finishedAt: step.finishedAt,
      attempt: 1, steps: [stepRow], deliveries: [],
    } });
    if (path === '/api/schema-records') return route.fulfill({ json: [] });
    return route.continue();
  });
  try {
    await page.goto(`${process.env.CONSOLE_URL ?? 'http://localhost:8790'}/#/runs/run`);
    await page.getByText('读取调用记录', { exact: true }).waitFor();
    await exercise(page, () => fullReads);
  } finally { await page.close(); }
}

test('step results load only on demand and nested JSON strings can be expanded', async () => {
  await withPage(step, { available: true, raw, upstreamTruncated: false }, async (page, reads) => {
    assert.equal(reads(), 0);
    await page.getByRole('button', { name: '查看完整结果' }).click();
    await page.getByText('JSON 字符串', { exact: false }).first().click();
    for (let depth = 0; depth < 8; depth++) {
      if (await page.getByText('embedded-result', { exact: true }).isVisible()) break;
      await page.locator('.step-result-view details:not([open]) > summary:visible').first().click();
    }
    await page.getByText('embedded-result', { exact: true }).waitFor();
    assert.equal(reads(), 1);
    await page.getByRole('tab', { name: '输入参数', exact: true }).click();
    assert.equal(await page.getByText('embedded-result', { exact: true }).isVisible(), false);
    await page.getByRole('tab', { name: /执行轨迹/ }).click();
    await page.getByText('embedded-result', { exact: true }).waitFor();
    assert.equal(reads(), 1);
    await page.getByRole('button', { name: '收起完整结果' }).click();
    assert.ok((await page.locator('.step-result-view').innerText()).includes(step.valuePreview));
    assert.equal(await page.getByText('embedded-result', { exact: true }).count(), 0);
    await page.getByRole('button', { name: '查看完整结果' }).click();
    assert.equal(reads(), 1);
    const overflow = await page.locator('.step-result-view').evaluate(el => ({
      width: el.clientWidth, scroll: el.scrollWidth,
      children: Array.from(el.querySelectorAll('*')).filter(child => child.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).slice(0, 12).map(child => ({ tag: child.tagName, className: child.className, width: child.getBoundingClientRect().width })),
    }));
    assert.ok(overflow.scroll <= overflow.width, JSON.stringify(overflow));
  });
});

test('legacy truncated data is shown as an incomplete preview, not a complete JSON result', async () => {
  await withPage({ ...step, valuePreview: 'x'.repeat(4096), resultAvailable: false }, {}, async page => {
    await page.getByText(/历史.*4096.*截断/).waitFor();
    assert.equal(await page.getByRole('button', { name: '查看完整结果' }).count(), 0);
  });
});

test('upstream truncation remains visible after loading the saved result', async () => {
  await withPage(step, { available: true, raw, upstreamTruncated: true }, async page => {
    await page.getByRole('button', { name: '查看完整结果' }).click();
    await page.getByText(/执行端已截断/).waitFor();
  });
});

test('expired results explain the limitation and preserve the original preview', async () => {
  await withPage(step, { available: false, reason: '完整结果已过期。' }, async page => {
    await page.getByRole('button', { name: '查看完整结果' }).click();
    await page.getByText('完整结果已过期。', { exact: true }).waitFor();
    assert.ok((await page.locator('.step-result-view').innerText()).includes(step.valuePreview));
  });
});
