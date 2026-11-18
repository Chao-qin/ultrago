import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';
import { after, before, test } from 'node:test';

const require = createRequire(new URL('../packages/extension/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const channels = [
  { id: 'alpha', adapter: 'openai', model: 'alpha-upstream', baseUrl: 'https://alpha.example', health: 'ok', healthDetail: 'HTTP 200', capabilities: ['json', 'tools'] },
  { id: 'beta', adapter: 'openai', model: 'beta', baseUrl: 'https://beta.example', health: 'ok', healthDetail: 'HTTP 200', capabilities: [] },
  { id: 'gamma', adapter: 'ollama', model: 'gamma', baseUrl: 'https://gamma.example', health: 'down', healthDetail: 'Connection refused', capabilities: ['vision'] },
  { id: 'idle', adapter: 'openai', model: 'idle', baseUrl: 'https://idle.example', health: 'unknown', healthDetail: null, capabilities: [] },
  { id: 'extraordinarily-long-channel-name-for-layout-verification', adapter: 'openai', model: 'long-name', baseUrl: 'https://very-long-upstream-hostname-for-layout-verification.example', health: 'ok', healthDetail: 'HTTP 200', capabilities: [] },
];
const longChannel = 'extraordinarily-long-channel-name-for-layout-verification@very-long-upstream-hostname-for-layout-verification.example';
const callRow = {
  id: 'call-alpha',
  startedAt: '2026-09-24T04:30:19.682Z',
  channel: 'alpha@alpha.example',
  adapter: 'openai',
  model: 'alpha-upstream',
  caller: null,
  status: 'error',
  httpStatus: 500,
  errorMessage: 'Fixture upstream error',
  latencyMs: 40,
  ttfbMs: null,
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
  costMicros: null,
  costCurrency: null,
  requestPreview: '只回两个字：收到',
  stream: false,
  attempt: null,
  deletedAt: null,
};
const groups = [
  { channel: 'alpha@alpha.example', adapter: 'openai', count: 8, errors: 2, totalTokens: 800 },
  { channel: 'beta@beta.example', adapter: 'openai', count: 1, errors: 0, totalTokens: 200 },
  { channel: 'gamma@gamma.example', adapter: 'ollama', count: 1, errors: 1, totalTokens: null },
];
const admin = {
  channels: [
    { id: 'alpha', adapter: 'openai', model: 'alpha-upstream', baseUrl: 'https://alpha.example', apiKey: 'env.ALPHA_API_KEY' },
  ],
  effectiveIds: ['alpha'],
  managedChannels: [],
  adapters: [{ name: 'openai', kind: 'http', needsBaseUrl: true, canListModels: true, options: [] }],
  secretEnvNames: ['ALPHA_API_KEY'],
  gatewayBaseUrl: 'http://127.0.0.1:11435',
};
let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
});
after(async () => browser?.close());

async function withPage(exercise, { mode = 'light', width = 1440, height = 960, empty = false, failStats = false, callsTotal } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  await page.addInitScript(value => localStorage.setItem('bcp-console-mode', value), mode);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST' && url.pathname === '/api/llm/admin/channels/alpha/test') {
      return route.fulfill({ json: { ok: false, latencyMs: 12, error: 'Fixture failure' } });
    }
    if (route.request().method() !== 'GET') return route.fulfill({ status: 403, json: { message: 'Read-only UI test' } });
    if (url.pathname === '/api/llm/channels') return route.fulfill({ json: channels });
    if (url.pathname === '/api/llm/admin') return route.fulfill({ json: admin });
    let rows = empty ? [] : groups;
    if (url.searchParams.has('since')) rows = rows.slice(1);
    if (url.searchParams.has('channel')) rows = rows.filter(row => row.channel === url.searchParams.get('channel'));
    if (url.searchParams.has('search')) rows = [];
    if (url.searchParams.get('status') === 'error') rows = rows.filter(row => row.errors > 0);
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    if (url.pathname === '/api/llm-calls/stats') return route.fulfill(failStats ? { status: 500, json: { message: 'Stats unavailable' } } : {
      json: { total, errors: rows.reduce((sum, row) => sum + row.errors, 0), totalTokens: rows.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0), p95LatencyMs: total ? 1200 : null, byChannel: rows },
    });
    if (url.pathname === '/api/llm-calls') return route.fulfill({ json: {
      items: rows.length ? [callRow] : [],
      total: callsTotal != null && rows.length ? callsTotal : total,
      page: Number(url.searchParams.get('page') ?? 1),
      pageSize: Number(url.searchParams.get('pageSize') ?? 50),
    } });
    return route.fulfill({ json: {} });
  });
  const buildDir = process.env.CONSOLE_BUILD_DIR;
  if (buildDir) {
    const root = `${resolve(buildDir)}${sep}`;
    await page.route('http://console.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) return route.fallback();
      const file = resolve(buildDir, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
      if (!file.startsWith(root)) return route.fulfill({ status: 403 });
      const contentTypes = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript' };
      try {
        return route.fulfill({ body: await readFile(file), contentType: contentTypes[extname(file)] ?? 'application/octet-stream' });
      } catch {
        return route.fulfill({ status: 404 });
      }
    });
  }
  try {
    const consoleUrl = buildDir ? 'http://console.test' : process.env.CONSOLE_URL ?? 'http://127.0.0.1:5173';
    await page.goto(`${consoleUrl}/#/llm`);
    await page.locator('.llm-channel-card').first().waitFor();
    if (!failStats) await page.waitForFunction(() => document.querySelector('.llm-metric-value')?.textContent !== '—');
    await exercise(page);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

test('selecting a channel filters records without zeroing peer usage or collapsing the overview', async () => {
  await withPage(async page => {
    const values = await page.locator('.llm-channel-usage').allInnerTexts();
    const metrics = await page.locator('.llm-metrics').innerText();
    const request = page.waitForResponse(response => response.url().includes('/api/llm-calls?') && response.url().includes('channel=alpha'));
    await page.locator('.llm-channel-card').first().click();
    await request;
    await page.waitForFunction(() => document.querySelector('.llm-table-panel .llm-count')?.textContent === '8');
    assert.deepEqual(await page.locator('.llm-channel-usage').allInnerTexts(), values);
    assert.equal(await page.locator('.llm-metrics').innerText(), metrics);
    assert.equal(await page.locator('.llm-distribution-row').count(), 3);
    await page.locator('.llm-channel-card').first().click();
    await page.waitForFunction(() => document.querySelector('.llm-table-panel .llm-count')?.textContent === '10');
    assert.equal(await page.locator('.llm-channel-card').first().getAttribute('aria-pressed'), 'false');
  });
});

test('selected channel scope stays compact inside the records heading', async () => {
  for (const width of [1440, 420]) {
    await withPage(async page => {
      await page.locator('.llm-channel-card').last().click();
      await page.waitForFunction(() => document.querySelector('.llm-table-panel .llm-count')?.textContent === '0');
      const heading = page.locator('.llm-table-panel .llm-panel-heading');
      const scope = heading.locator('.llm-record-scope');
      const label = scope.locator('> span');
      await scope.waitFor();

      assert.match(await scope.innerText(), /^已筛选 .*\n取消$/);
      assert.equal(await label.getAttribute('title'), longChannel);
      assert.equal(await page.locator('.llm-table-panel > .llm-record-scope').count(), 0);

      const [headingBox, scopeBox, labelSize, scopeSize] = await Promise.all([
        heading.boundingBox(),
        scope.boundingBox(),
        label.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })),
        scope.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })),
      ]);
      assert.ok(headingBox && scopeBox);
      assert.ok(scopeBox.y >= headingBox.y && scopeBox.y + scopeBox.height <= headingBox.y + headingBox.height + 1);
      assert.ok(scopeBox.x >= 0 && scopeBox.x + scopeBox.width <= width + 1, `${width}px scope leaves viewport`);
      assert.ok(labelSize.scrollWidth > labelSize.clientWidth, `${width}px channel label is not truncated`);
      assert.ok(scopeSize.scrollWidth <= scopeSize.clientWidth + 1, `${width}px scope overflows`);

      await page.getByRole('button', { name: '取消渠道筛选' }).click();
      await page.waitForFunction(() => document.querySelector('.llm-table-panel .llm-count')?.textContent === '10');
      assert.equal(await heading.locator('.llm-record-scope').count(), 0);
    }, { width });
  }
});

test('record search stays local while the time range updates both overview and records', async () => {
  await withPage(async page => {
    await page.getByPlaceholder('搜索提示词 / 回答 / 报错…').fill('no matching request');
    await page.waitForFunction(() => document.querySelector('.llm-table-panel .llm-count')?.textContent === '0');
    const totalValue = page.locator('.llm-metric-value').first().locator('.number-ticker > [aria-hidden="true"]');
    assert.equal(await totalValue.innerText(), '10');
    assert.equal(await page.locator('.llm-distribution-row').count(), 3);
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await page.locator('.llm-time-range').click();
    await page.getByText('近 24 小时', { exact: true }).last().click();
    await page.waitForFunction(() => document.querySelector('.llm-metric-value .number-ticker > [aria-hidden="true"]')?.textContent === '2');
    await page.waitForFunction(() => document.querySelector('.llm-table-panel .llm-count')?.textContent === '2');
    assert.equal(await page.locator('.llm-channel-usage').first().innerText(), '0\nToken');
  });
});

test('donut and ranking expose the same call shares and keyboard selection filters records', async () => {
  await withPage(async page => {
    const chart = page.getByRole('img', { name: /调用占比分布/ });
    assert.match(await chart.getAttribute('aria-label'), /alpha.*80\.0%/);
    assert.match(await chart.getAttribute('aria-label'), /beta.*10\.0%/);
    const row = page.locator('.llm-distribution-row').nth(1);
    assert.match(await row.innerText(), /10\.0%/);
    await row.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.llm-table-panel .llm-count')?.textContent === '1');
    assert.equal(await row.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.llm-distribution-row').count(), 3);
  });
});

test('channel summaries distinguish reported tokens, unknown usage, idle channels and failed calls', async () => {
  await withPage(async page => {
    const cards = await page.locator('.llm-channel-card').allInnerTexts();
    assert.match(cards[0], /服务可达/);
    assert.match(cards[0], /2 次失败/);
    assert.match(cards[2], /未上报/);
    assert.match(cards[3], /暂无调用/);
    assert.match(cards[3], /0/);
  });
});

test('empty and unavailable statistics never show a fabricated distribution', async () => {
  await withPage(async page => {
    assert.equal(await page.getByRole('img', { name: /调用占比分布/ }).count(), 0);
    assert.ok(await page.getByText('该时间范围内暂无调用', { exact: true }).count());
  }, { empty: true });
  await withPage(async page => {
    await page.getByText('统计数据加载失败', { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(await page.getByRole('img', { name: /调用占比分布/ }).count(), 0);
    assert.match(await page.locator('.llm-channel-usage').first().innerText(), /—/);
  }, { failStats: true });
});

test('light, dark and narrow layouts keep both panels within the viewport', async () => {
  for (const mode of ['light', 'dark']) for (const width of [1440, 1100, 420]) {
    await withPage(async page => {
      for (const selector of ['.llm-distribution-panel', '.llm-health-panel', '.llm-distribution-row']) {
        const box = await page.locator(selector).first().boundingBox();
        assert.ok(box && box.width > 0 && box.x >= 0 && box.x + box.width <= width + 1, `${mode} ${width} ${selector}: ${JSON.stringify(box)}`);
        assert.ok(await page.locator(selector).first().evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${mode} ${width} ${selector} overflows`);
      }
    }, { mode, width });
  }
});

test('dashboard scrolls vertically without horizontal overflow and keeps record controls usable', async () => {
  await withPage(async page => {
    const pageLayout = await page.locator('.llm-page').evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    assert.ok(pageLayout.scrollHeight > pageLayout.clientHeight, `Dashboard does not scroll vertically: ${JSON.stringify(pageLayout)}`);
    assert.ok(pageLayout.scrollWidth <= pageLayout.clientWidth + 1, `Dashboard overflows horizontally: ${JSON.stringify(pageLayout)}`);
    assert.equal(await page.locator('.llm-page').evaluate(element => getComputedStyle(element).scrollBehavior), 'auto');

    await page.locator('.llm-page').evaluate(element => element.scrollTo({ top: element.scrollHeight }));
    await page.getByPlaceholder('搜索提示词 / 回答 / 报错…').fill('no matching request');
    await page.waitForFunction(() => document.querySelector('.llm-table-panel .llm-count')?.textContent === '0');
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.llm-table-panel .llm-count')?.textContent === '120');

    const secondPageRequest = page.waitForResponse(response => response.url().includes('/api/llm-calls?') && response.url().includes('page=2'));
    await page.locator('.ant-pagination-item-2').click();
    await secondPageRequest;
    assert.equal(await page.locator('.ant-pagination-item-active').innerText(), '2');
  }, { width: 1440, height: 900, callsTotal: 120 });
});

test('wide call records keep both row actions visible without a redundant horizontal scrollbar', async () => {
  await withPage(async page => {
    const body = page.locator('.llm-table-panel .ant-table-body');
    const actionCell = body.locator('tbody tr:not(.ant-table-measure-row) td').last();
    const buttons = actionCell.locator('button');
    await buttons.last().waitFor();
    const [bodySize, cellSize, buttonBoxes] = await Promise.all([
      body.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })),
      actionCell.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })),
      buttons.evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      })),
    ]);
    const cellBox = await actionCell.boundingBox();

    assert.ok(cellBox);
    assert.ok(bodySize.scrollWidth <= bodySize.clientWidth + 1, `Wide table still scrolls horizontally: ${JSON.stringify(bodySize)}`);
    assert.ok(cellSize.scrollWidth <= cellSize.clientWidth + 1, `Action cell clips its controls: ${JSON.stringify(cellSize)}`);
    for (const button of buttonBoxes) {
      assert.ok(button.left >= cellBox.x - 1 && button.right <= cellBox.x + cellBox.width + 1, `Action leaves its cell: ${JSON.stringify({ cellBox, button })}`);
    }
  }, { width: 1920, height: 900 });
});

test('management drawers stay inside the viewport with non-overlapping headers and reachable tables', async () => {
  const drawerCases = [
    { button: '渠道管理', selector: '.llm-channel-editor-drawer', expectedWidth: width => Math.min(1560, width - 24) },
    { button: '访问与限流', selector: '.llm-access-drawer', expectedWidth: width => Math.min(1080, width - 24) },
  ];

  for (const width of [420, 1280, 1920]) {
    for (const drawerCase of drawerCases) {
      await withPage(async page => {
        await page.getByRole('button', { name: drawerCase.button, exact: true }).click();
        const drawer = page.locator(drawerCase.selector);
        const wrapper = page.locator(`.ant-drawer-content-wrapper:has(${drawerCase.selector})`);
        await drawer.waitFor();
        await wrapper.waitFor();
        await page.waitForFunction(selector => {
          const element = document.querySelector(selector);
          return element && getComputedStyle(element).transform === 'none';
        }, `.ant-drawer-content-wrapper:has(${drawerCase.selector})`);

        const box = await wrapper.boundingBox();
        assert.ok(box);
        assert.ok(Math.abs(box.width - drawerCase.expectedWidth(width)) <= 1, `${width}px ${drawerCase.selector} width: ${JSON.stringify(box)}`);
        assert.ok(box.x >= -1 && box.x + box.width <= width + 1, `${width}px ${drawerCase.selector} leaves viewport`);

        const headerParts = drawer.locator('.ant-drawer-close, .ant-drawer-title, .ant-drawer-extra');
        const boxes = (await headerParts.evaluateAll(elements => elements.map(element => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }))).filter(part => part.width > 0 && part.height > 0);
        for (let left = 0; left < boxes.length; left += 1) {
          for (let right = left + 1; right < boxes.length; right += 1) {
            const a = boxes[left];
            const b = boxes[right];
            const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
            assert.equal(overlaps, false, `${width}px ${drawerCase.selector} header parts overlap: ${JSON.stringify([a, b])}`);
          }
        }

        if (width === 420) {
          const table = drawer.locator('.ant-table-content').first();
          await table.waitFor();
          const tableLayout = await table.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
          assert.ok(tableLayout.scrollWidth > tableLayout.clientWidth, `${drawerCase.selector} table has no reachable horizontal scroll: ${JSON.stringify(tableLayout)}`);
        }
      }, { width, height: 900 });
    }
  }
});

test('wide short windows keep the donut caption above the panel footer', async () => {
  for (const mode of ['light', 'dark']) for (const [width, height] of [[1920, 800], [1920, 600], [1600, 700], [1440, 900]]) {
    await withPage(async page => {
      const verify = async () => {
        const donut = await page.locator('.llm-donut').boundingBox();
        const caption = await page.locator('.llm-donut-caption').boundingBox();
        const footer = await page.locator('.llm-distribution-panel .llm-panel-footnote').boundingBox();
        const heading = await page.locator('.llm-distribution-panel .llm-panel-heading').boundingBox();
        assert.ok(donut && caption && footer && heading);
        assert.ok(caption.y + caption.height <= footer.y - 8, `${mode} ${width}×${height}: caption overlaps footer`);
        assert.ok(donut.y >= heading.y + heading.height, 'Donut overlaps heading');
        assert.ok(donut.y + donut.height <= caption.y + 1, 'Donut overlaps caption');
        assert.ok(Math.abs(donut.width - donut.height) <= 1, 'Donut must stay circular');
      };
      await verify();
      await page.locator('.llm-distribution-row').first().hover();
      await verify();
    }, { mode, width, height });
  }
});

test('channel test result stays inside the fixed action column', async () => {
  await withPage(async page => {
    await page.getByRole('button', { name: '渠道管理', exact: true }).click();
    const row = page.locator('.llm-channel-editor-table .ant-table-tbody > tr.ant-table-row').first();
    await row.getByText('测试', { exact: true }).click();
    await row.getByText('失败', { exact: true }).waitFor();

    const actionCell = row.locator('td').last();
    const result = row.getByText('失败', { exact: true });
    const [cellBox, resultBox, dimensions] = await Promise.all([
      actionCell.boundingBox(),
      result.boundingBox(),
      actionCell.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })),
    ]);

    assert.ok(cellBox && resultBox);
    assert.ok(resultBox.x + resultBox.width <= cellBox.x + cellBox.width + 1, 'Test result overflows the action cell');
    assert.ok(dimensions.scrollWidth <= dimensions.clientWidth + 1, `Action cell overflows: ${JSON.stringify(dimensions)}`);
  }, { width: 1280, height: 720 });
});

test('model and API key controls share one table column', async () => {
  await withPage(async page => {
    await page.getByRole('button', { name: '渠道管理', exact: true }).click();
    const row = page.locator('.llm-channel-editor-table .ant-table-tbody > tr.ant-table-row').first();
    await row.getByText('alpha-upstream', { exact: true }).waitFor();
    const cells = row.locator('td');
    const [modelCellIndex, apiKeyCellIndex] = await Promise.all([
      cells.evaluateAll(items => items.findIndex(cell => cell.textContent?.includes('alpha-upstream'))),
      cells.evaluateAll(items => items.findIndex(cell =>
        Array.from(cell.querySelectorAll('input')).some(input => input.value === 'env.ALPHA_API_KEY'),
      )),
    ]);

    assert.notEqual(modelCellIndex, -1);
    assert.notEqual(apiKeyCellIndex, -1);
    assert.equal(modelCellIndex, apiKeyCellIndex);
  }, { width: 1280, height: 720 });
});
