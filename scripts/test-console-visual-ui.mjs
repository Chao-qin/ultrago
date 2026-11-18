import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';
import { after, before, test } from 'node:test';

const require = createRequire(new URL('../packages/extension/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const buildDir = process.env.CONSOLE_BUILD_DIR;
const TEST_ORIGIN = 'https://console.test';
const date = '2026-09-30T08:30:00Z';
const book = { id: 'book', name: '商品信息采集与整理', goal: '从商品详情页采集信息', goalDetail: '保留来源并生成结构化数据', description: null, paramSchema: '[]', outputSchema: null, deliveriesJson: '[]', stepsCount: 4, enabled: true, tags: '商品,采集', filePath: 'books/product-capture.json', fileMtime: date, fileHash: 'abcdefgh12345678', updatedAt: date, deletedAt: null, lastRun: null, runs: [], schedules: [] };
const schema = { id: 'schema', name: 'product', version: 1, title: '商品数据契约', kind: 'canonical', entity: 'product', active: true, deletedAt: null, source: 'console', contentHash: '1234567890abcdef1234567890abcdef', derivesFrom: null, description: '用于自动化采集的商品信息', jsonSchema: JSON.stringify({ type: 'object', properties: { name: { type: 'string', title: '商品名称' } }, required: ['name'] }), createdAt: date, updatedAt: date };
const script = { id: 'script', name: '商品标题标准化', description: '整理商品标题', language: 'javascript', source: 'return input;', inputSchema: '[]', outputSchema: null, deletedAt: null, createdAt: date, updatedAt: date, runs: [] };
const flow = { id: 'flow', name: '商品采集与处理流程', description: '从采集到结构化输出', graphJson: JSON.stringify({ nodes: [], edges: [] }), inputSchema: '[]', outputSchema: null, enabled: true, deletedAt: null, createdAt: date, updatedAt: date, runs: [] };
const run = { id: 'run', key: 'book:run', source: 'book', targetType: 'book', bookId: 'book', book, status: 'success', trigger: 'manual', mode: 'auto', planId: null, paramsJson: '{}', durationMs: 1200, queuedAt: date, startedAt: date, finishedAt: date, attempt: 1, steps: [], deliveries: [], deletedAt: null };
const schedule = { id: 'schedule', name: '每日商品采集', description: null, targetType: 'book', bookId: 'book', book, flow: null, script: null, cronExpr: '0 9 * * *', timezone: 'Asia/Shanghai', mode: 'auto', paramsJson: '{}', deliveryOverridesJson: null, enabled: true, timeoutMs: 60000, deletedAt: null, nextFires: ['2026-10-01T01:00:00Z'], totalFired: 25, totalSuccess: 24, lastFiredAt: date, lastFiredStatus: 'success', lastFiredRunId: 'run', createdAt: date, updatedAt: date };
const event = { id: 'event', kind: 'captcha_appeared', summary: '商品页面需要验证码', detail: '{}', tabId: 1, browser: 'fixture-browser', occurredAt: date, seq: 1, receivedAt: date, acknowledgedAt: null, deletedAt: null, screenshotUrl: null };
const record = { id: 'record', schemaName: 'product', schemaVersion: 1, source: 'run:run', data: '{"name":"测试商品"}', dataPreview: { head: '{"name":"测试商品"}', truncated: false, chars: 15 }, fileName: null, bytes: null, mime: null, url: null, deletedAt: null, createdAt: date, updatedAt: date };
const stats = { total: 10, errors: 1, totalTokens: 13000, promptTokens: 9000, completionTokens: 4000, avgLatencyMs: 1200, byChannel: [], perDay: [] };
const fixtures = {
  '/api/books': [book], '/api/books/book': book,
  '/api/flows': [flow], '/api/flows/flow': flow, '/api/flow-runs': [],
  '/api/schemas': [schema], '/api/schema-records': [record], '/api/schema-records/record': record,
  '/api/scripts': [script], '/api/scripts/script': script,
  '/api/schedules': [schedule], '/api/runs': [], '/api/runs/run': run,
  '/api/runs/history': { items: [run], total: 1, page: 1, pageSize: 25 },
  '/api/browser-events': { items: [event], total: 1, page: 1, pageSize: 25 },
  '/api/browser-events/stats': { total: 1, unacknowledged: 1, byKind: [{ kind: event.kind, count: 1 }] },
  '/api/health': { ok: true, db: true, backend: { ok: true, plans: 1 } },
  '/api/stats/overview': { days: 7, bookCount: 1, runsToday: 3, runsThisWeek: 25, successRate: .96, runningNow: 0, recent: [run], perDay: [{ date: '2026-09-30', count: 25, success: 24, failed: 1 }], recentFailures: [], topBooks: [{ bookId: 'book', name: book.name, runs: 25, successRate: .96 }] },
  '/api/llm-calls/stats': stats, '/api/llm-calls': { items: [], total: 0, page: 1, pageSize: 25 }, '/api/llm/channels': [],
  '/api/settings/scripts': { entries: [], warnings: [] }, '/api/settings/scripts/runs': [],
  '/api/settings/env': { file: '.env', entries: [], groups: [], notes: [] },
};
let browser;
before(async () => {
  assert.ok(buildDir || process.env.CONSOLE_URL, 'Provide CONSOLE_BUILD_DIR or a read-only CONSOLE_URL');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
});
after(async () => browser?.close());

async function withPage(path, exercise, { width = 1440, height = 960, mode = 'light', motion = 'reduce', failed = [], denied = [], empty = [], overrides = {}, desktop = null } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: motion });
  const errors = [];
  const writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  await page.addInitScript(value => {
    if (!localStorage.getItem('bcp-console-mode')) localStorage.setItem('bcp-console-mode', value);
  }, mode);
  if (buildDir) await page.route(`${TEST_ORIGIN}/**`, async route => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = resolve(buildDir, pathname === '/' ? 'index.html' : `.${pathname}`);
    if (!file.startsWith(`${resolve(buildDir)}${sep}`)) return route.fulfill({ status: 403, body: '' });
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    try { return await route.fulfill({ contentType: mime[extname(file)] ?? 'application/octet-stream', body: await readFile(file) }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      if (pathname !== '/api/studio') writes.push(`${request.method()} ${pathname}`);
      return route.fulfill({ status: 403, json: { message: 'Read-only visual verification' } });
    }
    if (failed.includes(pathname)) return route.fulfill({ status: 503, json: { message: 'Fixture service unavailable' } });
    if (denied.includes(pathname)) return route.fulfill({ status: 403, json: { message: '403 Forbidden' } });
    if (empty.includes(pathname)) return route.fulfill({ json: [] });
    if (pathname in overrides) return route.fulfill({ json: overrides[pathname] });
    if (pathname in fixtures) return route.fulfill({ json: fixtures[pathname] });
    return route.fulfill({ status: 404, json: { message: `Missing fixture: ${pathname}` } });
  });
  await page.route('**/__desktop/**', async route => {
    if (desktop === 'html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>SPA fallback</body></html>' });
    if (new URL(route.request().url()).pathname === '/__desktop/status' && desktop) return route.fulfill({ json: desktop });
    return route.fulfill({ status: 404, body: '' });
  });
  try {
    await page.goto(`${buildDir ? TEST_ORIGIN : process.env.CONSOLE_URL}/#${path}`);
    await page.locator('.console-toolbar').waitFor();
    await exercise(page);
    assert.deepEqual(errors, [], `Runtime errors on ${path}`);
    assert.deepEqual(writes, [], `Unexpected write attempts on ${path}`);
  } catch (error) {
    await screenshot(page, `failure-${path.replaceAll('/', '-')}`);
    error.message += `\nPage errors: ${JSON.stringify(errors)}`;
    throw error;
  } finally { await page.close(); }
}

async function bounded(page, selector) {
  const result = await page.locator(selector).first().evaluate(el => {
    const box = el.getBoundingClientRect();
    return { x: box.x, right: box.right, width: box.width, viewport: innerWidth, client: el.clientWidth, scroll: el.scrollWidth };
  });
  assert.ok(result.x >= -1 && result.right <= result.viewport + 1, JSON.stringify(result));
  assert.ok(result.scroll <= result.client + 1, JSON.stringify(result));
}

async function screenshot(page, name) {
  if (!process.env.CONSOLE_SCREENSHOT_DIR) return;
  await mkdir(process.env.CONSOLE_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(process.env.CONSOLE_SCREENSHOT_DIR, `${name}.png`), fullPage: true, animations: 'disabled' });
}

for (const [path, selector] of [
  ['/', '.mc-hud-name'], ['/books', '.ant-table-row'], ['/runs', '.ant-table-row'], ['/browser-events', '.ant-table-row'],
  ['/flows', '.ant-table-row'], ['/schedules', '.ant-table-row'], ['/scripts', '.ant-table-row'], ['/schemas', '.ant-table-row'],
  ['/schema-records', '.ant-table-row'], ['/database', '.console-studio-frame'], ['/llm', '.llm-heading'], ['/settings', '.ant-tabs'],
]) test(`navigation page ${path} renders in light and dark without viewport overflow`, async () => {
  for (const mode of ['light', 'dark']) await withPage(path, async page => {
    await page.locator(selector).first().waitFor();
    await bounded(page, '.console-layout');
    await bounded(page, '.console-content');
    assert.equal(await page.locator('.console-sidebar-context').count(), 0);
    if (await page.locator('.console-list-workspace > .page-table-host').count()) {
      const geometry = await page.evaluate(() => {
        const intro = document.querySelector('.console-workspace-intro').getBoundingClientRect();
        const table = document.querySelector('.console-list-workspace > .page-table-host').getBoundingClientRect();
        const header = document.querySelector('.ant-table-header').getBoundingClientRect();
        return { introBottom: intro.bottom, tableTop: table.top, headerTop: header.top, introLeft: intro.left, tableLeft: table.left, introRight: intro.right, tableRight: table.right };
      });
      assert.ok(Math.abs(geometry.introBottom - geometry.tableTop) <= 1, JSON.stringify(geometry));
      assert.ok(geometry.headerTop >= geometry.introBottom - 1, JSON.stringify(geometry));
      assert.ok(Math.abs(geometry.introLeft - geometry.tableLeft) <= 1 && Math.abs(geometry.introRight - geometry.tableRight) <= 1, JSON.stringify(geometry));
    }
    assert.equal(await page.locator('html').getAttribute('data-theme'), mode);
    await screenshot(page, `${path.replaceAll('/', '') || 'dashboard'}-${mode}`);
  }, { mode });
});

test('mobile navigation can switch pages and restores focus to its trigger', async () => {
  await withPage('/books', async page => {
    await page.locator('.ant-table-row').waitFor();
    const trigger = page.getByRole('button', { name: '打开导航', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const drawer = page.locator('.console-navigation-drawer');
    await drawer.getByRole('menuitem', { name: 'Schema 契约' }).click();
    await page.getByRole('heading', { name: 'Schema 契约', exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '打开导航');
    assert.ok(await trigger.evaluate(el => document.activeElement === el));
    await bounded(page, '.console-content');
    await screenshot(page, 'mobile-schema');
  }, { width: 390 });
});

test('detail pages keep metadata and read-only drawers usable on narrow screens', async () => {
  for (const path of ['/books/book', '/runs/run']) await withPage(path, async page => {
    await page.locator('.console-detail-header').waitFor();
    await bounded(page, '.console-detail-page');
    if (path.startsWith('/runs')) await page.locator('.run-context-rail > summary').click();
    await bounded(page, '.ant-descriptions');
    if (path.startsWith('/books')) {
      await page.getByRole('button', { name: '触发', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await bounded(page, '.ant-modal-container');
      assert.ok(await page.locator('.console-form-section').count() >= 2);
      await screenshot(page, 'mobile-book-trigger');
    }
  }, { width: 390 });
});

for (const [path, button, sections] of [
  ['/flows', '新建流程', 1], ['/schedules', '新建定时任务', 3], ['/schemas', '注册 Schema', 2],
]) test(`${button} form fits small windows and its footer stays reachable`, async () => {
  for (const mode of ['light', 'dark']) await withPage(path, async page => {
    await page.getByRole('button', { name: button, exact: true }).first().click();
    await page.getByRole('dialog').waitFor();
    await bounded(page, '.ant-modal-container');
    assert.ok(await page.locator('.console-form-section').count() >= sections);
    const footer = page.locator('.ant-modal-footer');
    await footer.scrollIntoViewIfNeeded();
    const box = await footer.boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= 640, JSON.stringify(box));
    await screenshot(page, `${path.slice(1)}-form-${mode}`);
  }, { width: 390, height: 640, mode });
});

test('record editor and script workbench fit mobile widths without submitting data', async () => {
  await withPage('/schema-records', async page => {
    await page.getByRole('button', { name: '新增记录', exact: true }).click();
    await page.locator('.record-editor').waitFor();
    await bounded(page, '.record-editor');
    await screenshot(page, 'mobile-record-editor');
  }, { width: 390 });
  await withPage('/scripts/new', async page => {
    await page.locator('.script-workbench').waitFor();
    await bounded(page, '.script-workbench');
    await screenshot(page, 'mobile-script-workbench');
  }, { width: 390 });
});

test('empty and failed details preserve the correct state and expose retry', async () => {
  await withPage('/books/book', async page => {
    await page.getByRole('heading', { name: '数据暂时不可用', exact: true }).waitFor();
    assert.ok(await page.getByRole('button', { name: '重新加载数据', exact: true }).isVisible());
  }, { failed: ['/api/books/book'] });
  await withPage('/runs/run', async page => {
    await page.locator('.console-detail-header').waitFor();
    await page.getByRole('heading', { name: '数据暂时不可用', exact: true }).waitFor();
    assert.ok(await page.getByRole('button', { name: '重新加载数据', exact: true }).isVisible());
  }, { failed: ['/api/schema-records'] });
  await withPage('/flow-runs', async page => {
    await page.getByText('还没有运行记录', { exact: true }).waitFor();
    await bounded(page, '.page-fill');
  });
});

test('appearance changes persist locally and reduced motion shows final statistics', async () => {
  await withPage('/settings', async page => {
    await page.getByRole('tab', { name: '外观', exact: true }).click();
    await page.getByText('你的自动化工作空间', { exact: true }).waitFor();
    await page.getByText('夜间', { exact: true }).click();
    await page.locator('html[data-theme="dark"]').waitFor();
    const semantic = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--c-ok'));
    await page.getByRole('button', { name: '靛蓝', exact: true }).click();
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--c-accent')), '#818CF8');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--c-ok')), semantic);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.reload();
    await page.locator('html[data-theme="dark"]').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--c-accent')), '#818CF8');
  });
  await withPage('/', async page => {
    const value = page.locator('.number-ticker-accessible').filter({ hasText: '96.0%' });
    await value.waitFor({ state: 'attached' });
    assert.equal(await value.locator('..').locator('[aria-hidden="true"]').textContent(), '96.0%');
    assert.match(await page.locator('.mc-hero').ariaSnapshot(), /96\.0%/);
    assert.equal(await page.locator('.border-beam').count(), 0);
  });
});

test('schema, event and history drawers keep their data readable on mobile', async () => {
  for (const [path, action] of [['/schemas', '查看'], ['/browser-events', '详情'], ['/flows', '运行记录']]) await withPage(path, async page => {
    await page.getByRole('button', { name: action, exact: true }).first().click();
    await page.locator('.ant-drawer-section').waitFor();
    await bounded(page, '.ant-drawer-section');
    await screenshot(page, `${path.slice(1)}-drawer-mobile`);
  }, { width: 390 });
});

test('lazy navigation preserves an unsaved script when leaving is cancelled', async () => {
  await withPage('/scripts/script', async page => {
    await page.locator('.script-workbench .cm-editor').waitFor();
    await page.getByRole('tab', { name: '设置', exact: true }).click();
    await page.getByPlaceholder('例如：商品数据预处理').fill('仍需保留的脚本草稿');
    let confirmations = 0;
    page.on('dialog', async dialog => { confirmations++; await dialog.dismiss(); });
    await page.locator('.console-sidebar').getByRole('menuitem', { name: 'Books', exact: true }).click();
    assert.equal(confirmations, 1);
    assert.ok(page.url().endsWith('#/scripts/script'));
    assert.equal(await page.getByPlaceholder('例如：商品数据预处理').inputValue(), '仍需保留的脚本草稿');
  });
});

test('normal motion decorations let links work and page headings become visible', async () => {
  await withPage('/', async page => {
    await page.locator('.mc-hero').waitFor();
    assert.ok(await page.locator('.border-beam').count() >= 2);
    assert.equal(await page.locator('.magic-card-glow').first().evaluate(el => getComputedStyle(el).pointerEvents), 'none');
    await page.locator('.mc-hero a').first().click();
    await page.getByRole('heading', { name: '运行记录', exact: true }).waitFor();
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.page-header')).opacity) === 1);
  }, { motion: 'no-preference' });
});

test('the embedded database theme follows the console without sending queries to a backend', async () => {
  await withPage('/database', async page => {
    const studio = page.frameLocator('.console-studio-frame').locator('.ps').first();
    await studio.waitFor();
    const background = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--c-bg').trim());
    assert.equal(await studio.evaluate(el => getComputedStyle(el).getPropertyValue('--background').trim()), background);
    await page.locator('.console-toolbar').getByRole('button', { name: '切换到夜间模式', exact: true }).click();
    await page.locator('html[data-theme="dark"]').waitFor();
    const darkBackground = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--c-bg').trim());
    await page.waitForFunction(expected => {
      const frame = document.querySelector('.console-studio-frame');
      const element = frame.contentDocument.querySelector('.ps');
      return element && frame.contentWindow.getComputedStyle(element).getPropertyValue('--background').trim() === expected;
    }, darkBackground);
    assert.notEqual(background, darkBackground);
  });
});

test('command search supports keyboard navigation and reports empty results', async () => {
  for (const width of [1440, 390]) await withPage('/books', async page => {
    assert.ok(await page.locator('.console-command-trigger .anticon').isVisible());
    await page.keyboard.press('Control+k');
    const search = page.getByRole('combobox', { name: '搜索工作区', exact: true });
    await search.waitFor();
    await bounded(page, '.ant-modal-container');
    await search.fill('脚本');
    await page.getByRole('option', { name: /脚本库/ }).waitFor();
    await search.press('Enter');
    await page.getByRole('heading', { name: '脚本库', exact: true }).waitFor();
    await page.getByRole('button', { name: '搜索工作区', exact: true }).click();
    await search.fill('no matching workspace');
    await page.getByText(/没有找到对应工作区/).waitFor();
    await search.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
  }, { width });
});

test('403 recovery keeps technical details folded and restores a failed list on retry', async () => {
  for (const mode of ['light', 'dark']) await withPage('/books', async page => {
    const panel = page.locator('.service-recovery');
    await panel.getByText('HTTP 403', { exact: true }).waitFor();
    await bounded(page, '.service-recovery');
    assert.ok(await panel.getByText(/服务器拒绝了访问/).isVisible());
    assert.equal(await panel.locator('details').getAttribute('open'), null);
    await panel.locator('summary').click();
    assert.equal(await panel.locator('pre').innerText(), '403 Forbidden');
    await screenshot(page, `access-recovery-${mode}`);
    await page.route('**/api/books', async route => route.fulfill({ json: [book] }));
    await panel.getByRole('button', { name: '重新加载数据', exact: true }).click();
    await page.locator('.ant-table-row').waitFor();
    assert.equal(await page.locator('.service-recovery').count(), 0);
  }, { width: 390, mode, denied: ['/api/books'] });
});

test('retry shows loading feedback and prevents a second action until the detail request finishes', async () => {
  await withPage('/books/book', async page => {
    await page.getByRole('heading', { name: '数据暂时不可用', exact: true }).waitFor();
    let release;
    const gate = new Promise(resolveGate => { release = resolveGate; });
    await page.route('**/api/books/book', async route => { await gate; await route.fulfill({ json: book }); });
    const button = page.locator('.recovery-retry');
    try {
      await button.click();
      await page.locator('.console-content .ant-spin').waitFor();
      assert.equal(await button.count(), 0);
    } finally { release(); }
    await page.locator('.console-detail-header').waitFor();
  }, { denied: ['/api/books/book'] });
});

test('gateway and statistics failures share one compact panel and recover independently', async () => {
  for (const width of [1440, 390]) await withPage('/llm', async page => {
    await page.getByText('网关连接异常', { exact: true }).waitFor();
    await page.getByText('统计数据加载失败', { exact: true }).waitFor();
    assert.equal(await page.locator('.service-recovery').count(), 1);
    assert.equal(await page.locator('.service-recovery .recovery-issue').count(), 2);
    await bounded(page, '.service-recovery');
    if (width === 1440) assert.ok((await page.locator('.service-recovery').boundingBox()).height < 250);
    await screenshot(page, `llm-service-recovery-${width}`);
    const retryButton = page.getByRole('button', { name: '重新连接', exact: true });
    await page.route('**/api/llm-calls/stats', async route => route.fulfill({ json: stats }));
    await retryButton.click();
    await page.waitForFunction(() => document.querySelector('.llm-metric-value .number-ticker-accessible')?.textContent === '10');
    assert.equal(await page.getByText('统计数据加载失败', { exact: true }).count(), 0);
    await page.getByText('网关连接异常', { exact: true }).waitFor();
  }, { width, failed: ['/api/llm/channels', '/api/llm-calls/stats'] });
});

test('run workspace exposes accurate states, long step evidence and mobile context', async () => {
  for (const [status, width, mode] of [['success', 1440, 'light'], ['failed', 1254, 'dark'], ['running', 390, 'light'], ['cancelled', 390, 'dark'], ['needsConfirm', 1254, 'light'], ['needsJudge', 390, 'dark'], ['noAction', 390, 'light']]) {
    const detail = { ...run, status, errorMessage: status === 'failed' ? '执行失败：'.repeat(90) : null, paramsJson: JSON.stringify({ product: { name: '商品名称'.repeat(35), variants: [{ sku: 'SKU-001' }] } }), steps: [{ id: 'step', runId: 'run', goal: '采集商品详情并整理数据', status: status === 'failed' ? 'failed' : status === 'running' ? 'running' : 'success', actionMethod: 'browser.eval', durationMs: 1200, valuePreview: JSON.stringify({ summary: '执行结果'.repeat(120) }), resultAvailable: false }] };
    await withPage('/runs/run', async page => {
      await page.getByRole('heading', { name: `运行 ${run.id}`, exact: true }).waitFor();
      await page.getByText('采集商品详情并整理数据', { exact: true }).waitFor();
      await bounded(page, '.run-state-hero');
      await bounded(page, '.run-execution-body');
      await bounded(page, '.run-context-rail');
      await bounded(page, '.step-result-view');
      assert.equal(await page.locator('.run-state-main').getAttribute('data-status-group'), ['needsConfirm', 'needsJudge', 'noAction'].includes(status) ? 'attention' : status === 'running' ? 'active' : status);
      if (['needsConfirm', 'needsJudge', 'noAction'].includes(status)) assert.match(await page.locator('.run-state-main').innerText(), /执行已暂停/);
      if (status === 'failed') {
        await page.getByText('执行遇到问题', { exact: true }).waitFor();
        await page.getByText('查看完整错误', { exact: true }).click();
        await bounded(page, '.run-failure-card');
      }
      await screenshot(page, `run-workspace-${status}-${width}`);
    }, { width, mode, overrides: { '/api/runs/run': detail, '/api/schema-records': [] } });
  }
});

test('empty-step runs give parameters the full workspace and keep empty states compact', async () => {
  const params = { query: '商品自动化采集', sourceUrl: 'https://example.test/product/123456', limit: 50, category: 'electronics', tags: ['新品', '热卖'], instructions: '采集商品名称、价格和来源信息。'.repeat(40), includeImages: true, locale: 'zh-CN', attributes: { colour: '黑色', size: 'M' }, delivery: { enabled: false } };
  for (const [width, mode] of [[1920, 'light'], [1440, 'dark'], [1254, 'light'], [390, 'dark']]) await withPage('/runs/run', async page => {
    const inputs = page.getByRole('tab', { name: '输入参数', exact: true });
    await inputs.waitFor();
    assert.equal(await inputs.getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByRole('tabpanel').count(), 1);
    assert.equal(await page.locator('.run-context-rail').getAttribute('open'), null);
    const body = await page.locator('.run-execution-body').boundingBox();
    const content = await page.locator('#run-panel-inputs .content-view').boundingBox();
    assert.ok(content.width > body.width * .8, JSON.stringify({ body, content }));
    if (width === 1920) assert.ok(content.width > 1400);
    const longField = page.locator('#run-panel-inputs .content-view-body > .content-json-branch > dl > div[data-long-text="true"]').first();
    const longBox = await longField.boundingBox();
    assert.ok(longBox.width > content.width * .8, JSON.stringify({ content, longBox }));
    if (width >= 1440) {
      const shortBox = await page.locator('#run-panel-inputs .content-view-body > .content-json-branch > dl > div').first().boundingBox();
      assert.ok(shortBox.height < 120, JSON.stringify(shortBox));
    }
    await bounded(page, '#run-panel-inputs');
    await screenshot(page, `run-inputs-${width}-${mode}`);
    await inputs.focus();
    await page.keyboard.press('ArrowRight');
    const outputs = page.getByRole('tab', { name: /运行产物/ });
    assert.equal(await outputs.getAttribute('aria-selected'), 'true');
    const emptyBox = await page.locator('#run-panel-outputs .run-evidence-empty').boundingBox();
    assert.ok(emptyBox.height < 140, JSON.stringify(emptyBox));
    await page.keyboard.press('Home');
    assert.equal(await page.getByRole('tab', { name: /执行轨迹/ }).getAttribute('aria-selected'), 'true');
    assert.ok((await page.locator('#run-panel-execution .run-evidence-empty').boundingBox()).height < 170);
    await page.locator('.run-context-rail > summary').click();
    await bounded(page, '.run-context-expanded');
    await bounded(page, '.ant-descriptions');
  }, { width, mode, overrides: { '/api/runs/run': { ...run, paramsJson: JSON.stringify(params) }, '/api/schema-records': [] } });
});

test('polling preserves the input tab and focus when the first step arrives', async () => {
  await withPage('/runs/run', async page => {
    const inputs = page.getByRole('tab', { name: '输入参数', exact: true });
    await inputs.waitFor();
    await inputs.focus();
    await page.route('**/api/runs/run', async route => route.fulfill({ json: { ...run, status: 'running', steps: [{ id: 'first-step', goal: '第一步已开始', status: 'running' }] } }));
    await page.waitForFunction(() => document.querySelector('#run-tab-execution small')?.textContent === '1');
    assert.equal(await inputs.getAttribute('aria-selected'), 'true');
    assert.ok(await inputs.evaluate(el => document.activeElement === el));
    assert.ok(await page.locator('#run-panel-inputs').isVisible());
    await page.getByRole('tab', { name: /执行轨迹/ }).click();
    await page.getByText('第一步已开始', { exact: true }).waitFor();
    await page.keyboard.press('Tab');
    assert.ok(await page.locator('#run-panel-execution').evaluate(el => document.activeElement === el));
  }, { overrides: { '/api/runs/run': { ...run, status: 'running' } } });
});

test('run launch uses mode cards and keeps complex inputs and the footer reachable', async () => {
  const launchBook = { ...book, paramSchema: JSON.stringify([{ name: 'name', required: true, schema: { type: 'string' } }, { name: 'product', required: false, schema: { type: 'object', properties: { title: { type: 'string' }, enabled: { type: 'boolean', default: true } } } }]) };
  for (const [width, mode] of [[1440, 'light'], [1254, 'dark'], [390, 'dark']]) await withPage('/books/book', async page => {
    await page.locator('.console-detail-header').getByRole('button', { name: '触发', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('radio', { name: /辅助执行/ }).check();
    assert.ok(await page.getByRole('radio', { name: /辅助执行/ }).isChecked());
    await page.getByRole('textbox', { name: /Name/ }).fill('测试输入');
    assert.ok(await page.getByRole('complementary', { name: '本次运行摘要' }).isVisible());
    await bounded(page, '.ant-modal-container');
    await bounded(page, '.run-launch-layout');
    await bounded(page, '.run-mode-picker');
    const footer = await page.locator('.ant-modal-footer').boundingBox();
    assert.ok(footer && footer.y >= 0 && footer.y + footer.height <= 640);
    await screenshot(page, `run-launch-${width}-${mode}`);
    await page.locator('.ant-modal-footer').getByRole('button', { name: /取\s*消/ }).click();
  }, { width, height: 640, mode, overrides: { '/api/books/book': launchBook } });
});

test('dashboard metrics stay inside their cards at desktop breakpoints', async () => {
  for (const width of [1440, 1254, 1200, 1000, 390]) await withPage('/', async page => {
    await page.locator('.mc-kpi-row').first().waitFor();
    const clipped = await page.locator('.mc-kpi-row').evaluateAll(rows => rows.flatMap(row => {
      const box = row.getBoundingClientRect();
      return [...row.querySelectorAll('.mc-kpi-value, svg')].filter(child => child.getBoundingClientRect().right > box.right + 1)
        .map(child => ({ label: row.closest('.mc-kpi').textContent, right: child.getBoundingClientRect().right, available: box.right }));
    }));
    assert.deepEqual(clipped, []);
    await screenshot(page, `dashboard-${width}`);
  }, { width });
});
test('desktop dashboard distinguishes browser readiness, assistant handshake and launch errors in a compact header', async () => {
  const common = { serviceReady: true, browserReady: true, browserId: 'fixture-browser', mcpReady: true, modelMode: 'skip', assistants: [], lastError: '' };
  for (const [label, desktop] of [
    ['等待助手连接', common],
    ['Workbuddy', { ...common, assistants: [{ id: 'workbuddy', name: 'Workbuddy', state: 'connected', toolCount: 12 }] }],
    ['连接失败', { ...common, lastError: 'fixture: stdio process exited' }],
  ]) await withPage('/', async page => {
    await page.locator('.mc-strip').filter({ hasText: label }).waitFor();
    assert.match(await page.locator('.mc-strip').textContent(), /Chrome.*已确认/);
    assert.ok((await page.locator('.mc-command-deck').boundingBox()).height < 190, '状态栏应紧凑展示真实信息');
    if (desktop.lastError) await page.locator('.mc-connection-error').filter({ hasText: desktop.lastError }).waitFor();
    let opened = false;
    await page.route('**/__desktop/open-connections', async route => { opened = true; await route.fulfill({ status: 204, body: '' }); });
    await page.locator('.mc-connection-help').click();
    await page.waitForTimeout(50);
    assert.equal(opened, true, '诊断入口调用客户端专用导航');
    await screenshot(page, `dashboard-connections-${label}`);
  }, { width: 1140, desktop });
});

test('ordinary Console HTML fallback does not appear as a failed desktop connection', async () => {
  await withPage('/', async page => {
    await page.locator('.mc-hud-name').waitFor();
    await page.locator('.mc-strip').filter({ hasText: '调用记录' }).waitFor();
    assert.equal(await page.locator('.mc-connection-error').count(), 0);
    assert.equal(await page.locator('.mc-connection-help').count(), 0);
  }, { desktop: 'html' });
});
