import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });
});
after(async () => browser?.close());

const schema = {
  type: 'object', title: '长契约预览',
  properties: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`field_${i}`, { type: 'string', description: '用于测试超长契约的字段说明'.repeat(5) }])),
};
const graph = {
  nodes: [{
    id: 'script', type: 'script', label: '测试节点', position: { x: 0, y: 0 },
    config: {
      language: 'javascript', source: 'return input;',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number' } }, required: ['query'] },
      outputSchema: schema,
    },
  }], edges: [],
};
const flow = {
  id: 'overlay-fixture', name: '弹层回归', description: null, graphJson: JSON.stringify(graph),
  inputSchema: '[]', outputSchema: null, enabled: true, deletedAt: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};
const registry = [{
  id: 'schema-fixture', name: 'long-registry-name', version: 1, title: '很长的数据契约名称'.repeat(20),
  description: null, kind: 'data', entity: null, active: true, deletedAt: null,
  jsonSchema: JSON.stringify(schema), createdAt: flow.createdAt, updatedAt: flow.updatedAt,
}];

async function withPage(viewport, mode, exercise, fixtureGraph = graph, fixtureRun) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(5000);
  await page.addInitScript(value => localStorage.setItem('bcp-console-mode', value), mode);
  await page.route('**/api/**', async route => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 403, json: { message: 'Read-only UI test' } });
    const path = new URL(route.request().url()).pathname;
    const fixtures = { '/api/flows/overlay-fixture': { ...flow, graphJson: JSON.stringify(fixtureGraph) }, '/api/flows': [flow], '/api/books': [], '/api/schemas': registry, '/api/flow-runs': fixtureRun ? [fixtureRun] : [], '/api/flow-runs/fixture-run': fixtureRun };
    if (path in fixtures) return route.fulfill({ json: fixtures[path] });
    return route.continue();
  });
  try {
    await page.goto(`${process.env.CONSOLE_URL ?? 'http://localhost:8790'}/#/flows/overlay-fixture`);
    await page.locator('.react-flow__node').first().waitFor();
    await exercise(page);
  } finally {
    await page.close();
  }
}

test('registry dropdown respects the viewport despite its inline preferred width', async () => {
  await withPage({ width: 400, height: 360 }, 'light', async page => {
    await page.locator('.react-flow__node').click();
    const panel = page.getByRole('complementary', { name: '节点配置面板' });
    await panel.getByRole('tab', { name: '接口', exact: true }).click();
    await panel.getByRole('combobox').first().click();
    const popup = page.locator('.ant-select-dropdown:visible');
    await popup.waitFor();
    await page.waitForTimeout(300);
    const rect = await popup.boundingBox();
    assert.ok(rect.width <= 376, JSON.stringify(rect));
    assert.ok(rect.x >= 0 && rect.x + rect.width <= 400, JSON.stringify(rect));
    assert.ok(rect.y >= 0 && rect.y + rect.height <= 360, JSON.stringify(rect));
    const lastOption = popup.getByText('＋ 注册新 Schema…', { exact: true });
    await lastOption.scrollIntoViewIfNeeded();
    assert.ok(await lastOption.evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }), 'last dropdown option must be reachable and unobscured');
  });
});

test('workbench chrome is compact and unselected inspector gives space back to canvas', async () => {
  await withPage({ width: 1440, height: 900 }, 'light', async page => {
    assert.ok((await page.locator('.flow-workbench-header').boundingBox()).height <= 52);
    assert.equal(await page.locator('.flow-inspector-empty').count(), 0);
    assert.equal(await page.locator('.flow-library-footer').count(), 0);
    assert.ok((await page.locator('.flow-node-library').boundingBox()).width <= 208);
    const initialWidth = (await page.locator('.flow-canvas').boundingBox()).width;
    await page.locator('.react-flow__node').click();
    const panel = page.getByRole('complementary', { name: '节点配置面板' });
    await panel.waitFor();
    assert.ok((await page.locator('.flow-canvas').boundingBox()).width < initialWidth);
    await panel.getByRole('button', { name: '收起', exact: true }).click();
    assert.equal(await panel.count(), 0);
    assert.equal((await page.locator('.flow-canvas').boundingBox()).width, initialWidth);
  });
});

test('collapsed navigation uses a narrow rail with visible icon targets', async () => {
  await withPage({ width: 1440, height: 900 }, 'light', async page => {
    await page.waitForTimeout(350);
    const rail = page.locator('.ant-layout-sider-collapsed');
    assert.ok((await rail.boundingBox()).width <= 56);
    const item = rail.locator('.ant-menu-item').first();
    const box = await item.boundingBox();
    assert.ok(box.width >= 32 && box.height >= 32);
    assert.ok(await rail.evaluate(el => el.scrollWidth <= el.clientWidth));
  });
});

test('execution monitor starts compact and keeps empty-state details accessible', async () => {
  await withPage({ width: 1440, height: 900 }, 'light', async page => {
    const panel = page.getByRole('region', { name: '最近执行' });
    const toggle = panel.getByRole('button', { name: /执行监控/ });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.ok((await panel.boundingBox()).height <= 32);
    await toggle.click();
    await panel.getByText(/暂无执行记录/).waitFor();
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  });
});

test('editor navigation collapse is temporary and restores either previous preference', async () => {
  await withPage({ width: 1440, height: 900 }, 'light', async page => {
    const collapsed = page.locator('.ant-layout-sider-collapsed');
    const expanded = page.locator('.ant-layout-sider:not(.ant-layout-sider-collapsed)');
    await collapsed.waitFor();
    await page.evaluate(() => { location.hash = '#/flows'; });
    await expanded.waitFor();
    await page.evaluate(() => { location.hash = '#/flows/overlay-fixture'; });
    await collapsed.waitFor();
    await page.locator('.ant-layout-sider-trigger').click();
    await expanded.waitFor();
    await page.evaluate(() => { location.hash = '#/flows'; });
    await expanded.waitFor();
    await page.locator('.ant-layout-sider-trigger').click();
    await collapsed.waitFor();
    await page.evaluate(() => { location.hash = '#/flows/overlay-fixture'; });
    await page.locator('.react-flow__node').waitFor();
    await collapsed.waitFor();
    await page.locator('.ant-layout-sider-trigger').click();
    await expanded.waitFor();
    await page.evaluate(() => { location.hash = '#/flows'; });
    await collapsed.waitFor();
  });
});

test('canvas counts float inside the canvas and help stays accessible', async () => {
  await withPage({ width: 1000, height: 700 }, 'light', async page => {
    assert.equal(await page.locator('.flow-canvas-caption').count(), 0);
    const minibar = page.getByRole('region', { name: '画布信息' });
    await minibar.waitFor();
    assert.match(await minibar.innerText(), /1 节点.*0 连线/);
    const bounds = await minibar.boundingBox();
    const canvas = await page.locator('.flow-canvas').boundingBox();
    assert.ok(bounds.y >= canvas.y && bounds.x >= canvas.x && bounds.width < canvas.width);
    await minibar.getByRole('button', { name: '画布操作提示' }).hover();
    await page.getByRole('tooltip').getByText(/右键画布添加节点/).waitFor();
  });
});

test('floating bars and a populated monitor fit narrow screens without overlapping', async () => {
  const fixtureGraph = { nodes: [
    { id: 'input', type: 'flowInput', position: { x: 0, y: 0 }, config: { params: [] } },
    { id: 'output', type: 'flowOutput', position: { x: 300, y: 0 }, config: {} },
  ], edges: [{ id: 'edge', source: 'input', target: 'output', kind: 'control' }] };
  const run = { id: 'fixture-run', flowId: flow.id, status: 'running', queuedAt: flow.createdAt, durationMs: null, errorMessage: null, nodes: [] };
  await withPage({ width: 400, height: 600 }, 'light', async page => {
    const minibar = page.getByRole('region', { name: '画布信息' });
    const legend = page.locator('.flow-canvas-legend');
    const a = await minibar.boundingBox();
    const b = await legend.boundingBox();
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, JSON.stringify({ a, b }));
    const monitor = page.getByRole('region', { name: '最近执行' });
    await monitor.getByRole('button', { name: '运行详情' }).waitFor();
    assert.ok((await monitor.boundingBox()).height <= 32);
    assert.ok(await monitor.evaluate(el => el.scrollWidth <= el.clientWidth));
    await monitor.getByRole('button', { name: /执行监控/ }).click();
    await monitor.locator('.flow-execution-meta').waitFor();
  }, fixtureGraph, run);
});

test('canvas node picker keeps viewport coordinates after adding container queries', async () => {
  await withPage({ width: 1280, height: 720 }, 'light', async page => {
    const canvas = await page.locator('.flow-canvas').boundingBox();
    const point = { x: canvas.x + 60, y: canvas.y + 90 };
    await page.mouse.click(point.x, point.y, { button: 'right' });
    const search = page.getByPlaceholder('搜节点，或直接从下面挑');
    await search.waitFor();
    const rect = await search.evaluate(el => {
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (getComputedStyle(parent).position === 'fixed') {
          const box = parent.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        }
      }
      return null;
    });
    assert.ok(rect);
    assert.ok(Math.abs(rect.x - point.x) <= 2 && Math.abs(rect.y - point.y) <= 2, JSON.stringify({ rect, point }));
    assert.ok(rect.x + rect.width <= 1280 && rect.y + rect.height <= 720);
    await search.press('Escape');
    assert.equal(await search.count(), 0);
  });
});

test('branch paths show their distinguishing field names without horizontal scrolling', async () => {
  const paths = ['$.projectionVerdict.publication.canPublish', '$.projectionVerdict.publication.canDraft'];
  await withPage({ width: 1280, height: 720 }, 'light', async page => {
    await page.locator('.react-flow__node').click();
    const panel = page.getByRole('complementary', { name: '节点配置面板' });
    await panel.getByRole('tab', { name: '接口', exact: true }).click();
    for (const [index, path] of paths.entries()) {
      const field = panel.getByRole('textbox', { name: `条件 ${index + 1} 路径` });
      assert.equal(await field.inputValue(), path);
      assert.ok(await field.evaluate(el => el.tagName === 'TEXTAREA' && el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight));
    }
  }, { nodes: [{ id: 'branch', type: 'branch', position: { x: 0, y: 0 }, config: { cases: paths.map((left, index) => ({ id: `case-${index}`, left, op: 'isTrue' })), otherwise: true } }], edges: [] });
});

for (const [mode, viewport] of [['dark', { width: 1280, height: 720 }], ['light', { width: 600, height: 480 }]]) {
  test(`long schema preview stays inside viewport and scrolls without being covered (${mode})`, async () => {
    await withPage(viewport, mode, async page => {
      await page.locator('.react-flow__node').getByText('·长契约预览', { exact: false }).hover();
      const preview = page.locator('.ant-tooltip:visible, .ant-popover:visible').filter({ has: page.locator('pre') });
      await preview.waitFor();
      await page.waitForTimeout(300);
      const rect = await preview.boundingBox();
      assert.ok(rect.y >= 0 && rect.y + rect.height <= viewport.height, JSON.stringify(rect));
      assert.ok(rect.x >= 0 && rect.x + rect.width <= viewport.width, JSON.stringify(rect));
      const scrollable = await preview.evaluate(root => {
        const element = [root, ...root.querySelectorAll('*')].find(el => /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight);
        if (!element) return false;
        element.scrollTop = element.scrollHeight;
        const r = element.getBoundingClientRect();
        return element.scrollTop > 0 && root.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      });
      assert.ok(scrollable, 'schema must have an accessible scrolling surface');
    });
  });

  test(`inspector separates inputs and outputs with usable constant fields (${mode})`, async () => {
    await withPage(viewport, mode, async page => {
      await page.locator('.react-flow__node').click();
      const panel = page.getByRole('complementary', { name: '节点配置面板' });
      await panel.getByRole('tab', { name: '接口', exact: true }).click();
      const nameField = panel.getByPlaceholder('参数名').first();
      assert.ok((await nameField.boundingBox()).width >= 120, 'field names need readable space in narrow inspectors');
      const inputs = panel.getByRole('region', { name: '输入端口' });
      const outputs = panel.getByRole('region', { name: '输出端口' });
      await inputs.waitFor();
      assert.match(await inputs.innerText(), /必填/);
      assert.match(await inputs.innerText(), /未连接/);
      assert.match(await outputs.innerText(), /长契约预览/);
      await inputs.getByPlaceholder('填个常量值（可留空）').fill('hello');
      assert.equal(await inputs.getByPlaceholder('填个常量值（可留空）').inputValue(), 'hello');
      assert.ok(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), 'inspector must not overflow horizontally');
    });
  });
}
