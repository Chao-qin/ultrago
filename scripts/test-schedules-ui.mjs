import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
let browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH,
    args: ['--no-sandbox'],
  });
});
after(async () => browser?.close());

const script = { id: 'script-fixture', name: 'Fixture script', language: 'javascript', inputSchema: '{}', deletedAt: null };
const flow = { id: 'flow-fixture', name: 'Fixture flow', enabled: true, inputSchema: '[]', deletedAt: null };
const schedule = {
  id: 'schedule-fixture', name: 'Fixture schedule', description: null,
  targetType: 'script', script, book: null, flow: null, bookId: null,
  cronExpr: '15 9 * * *', timezone: 'Asia/Shanghai', mode: 'auto',
  paramsJson: '{"test":true}', deliveryOverridesJson: null, enabled: true,
  timeoutMs: 60000, deletedAt: null, nextFires: [], totalFired: 0, totalSuccess: 0,
  lastFiredAt: null, lastFiredStatus: null, lastFiredRunId: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

async function withPage(rows, exercise) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const writes = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      writes.push({ pathname, body: request.postDataJSON() });
      await route.fulfill({ json: pathname.endsWith('/run') ? { id: 'flow-run-fixture' } : schedule });
      return;
    }
    const fixtures = { '/api/schedules': rows, '/api/books': [], '/api/flows': [flow], '/api/scripts': [script] };
    if (pathname in fixtures) await route.fulfill({ json: fixtures[pathname] });
    else await route.continue();
  });
  try {
    await page.goto(`${process.env.CONSOLE_URL ?? 'http://localhost:8790'}/#/schedules`);
    await page.getByRole('button', { name: '新建定时任务' }).first().waitFor();
    await exercise(page, writes);
  } finally {
    await page.close();
  }
}

async function editCron(page) {
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#cronExpr').click();
  return page.getByRole('dialog', { name: '定时任务配置' });
}

test('empty-state creation initializes enabled, timezone and target kind', async () => {
  await withPage([], async (page) => {
    await page.getByRole('button', { name: '新建定时任务' }).last().click();
    const dialog = page.getByRole('dialog');
    assert.equal(await dialog.getByRole('switch').getAttribute('aria-checked'), 'true');
    assert.match(await dialog.innerText(), /Asia\/Shanghai/);
    assert.match(await dialog.innerText(), /Book · 浏览器录制回放/);
  });
});

test('cron custom editor opens with the persisted expression', async () => {
  await withPage([schedule], async (page) => {
    const dialog = await editCron(page);
    await dialog.getByText('自定义', { exact: true }).click();
    assert.equal(await dialog.getByRole('textbox').inputValue(), '15 9 * * *');
  });
});

test('cron preset requires confirmation and cancel keeps the saved expression', async () => {
  await withPage([schedule], async (page) => {
    const dialog = await editCron(page);
    await dialog.getByRole('button', { name: '每 5 分钟' }).click();
    assert.equal(await dialog.isVisible(), true);
    await dialog.getByRole('button', { name: /取\s*消/ }).click();
    assert.equal(await page.locator('#cronExpr').inputValue(), '15 9 * * *');
  });
});

test('cron rejects invalid ranges before saving', async () => {
  await withPage([schedule], async (page) => {
    const dialog = await editCron(page);
    await dialog.getByText('自定义', { exact: true }).click();
    await dialog.getByRole('textbox').fill('99 99 * * *');
    assert.equal(await dialog.getByRole('button', { name: /保\s*存/ }).isDisabled(), true);
  });
});

test('script timeout is submitted as a number', async () => {
  await withPage([schedule], async (page, writes) => {
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.locator('#timeoutMs').fill('120000');
    const submitted = page.waitForResponse(response => response.request().method() === 'PATCH');
    await page.getByRole('dialog').getByRole('button', { name: /保\s*存/ }).click();
    await submitted;
    assert.equal(writes[0].body.timeoutMs, 120000);
  });
});

test('flow trigger navigates to the flow run detail', async () => {
  await withPage([{ ...schedule, targetType: 'flow', flow, script: null }], async (page) => {
    await page.getByRole('button', { name: '触发', exact: true }).click();
    await page.waitForURL('**/#/flow-runs/flow-run-fixture', { timeout: 3000 });
  });
});

test('fire times use the schedule timezone rather than browser timezone', async () => {
  await withPage([{ ...schedule, nextFires: ['2026-09-12T01:00:00Z'] }], async (page) => {
    await page.getByText('Fixture schedule', { exact: true }).waitFor();
    assert.match(await page.locator('main').innerText(), /09-12 09:00:00/);
  });
});

test('editing a simple cron in the builder preserves its minute and hour', async () => {
  await withPage([schedule], async (page) => {
    const dialog = await editCron(page);
    await dialog.getByText('可视化配置', { exact: true }).click();
    await dialog.getByRole('button', { name: /保\s*存/ }).click();
    assert.equal(await page.locator('#cronExpr').inputValue(), '15 9 * * *');
  });
});

test('reopening cron discards cancelled custom input', async () => {
  await withPage([schedule], async (page) => {
    let dialog = await editCron(page);
    await dialog.getByText('自定义', { exact: true }).click();
    await dialog.getByRole('textbox').fill('0 12 * * *');
    await dialog.getByRole('button', { name: /取\s*消/ }).click();
    await page.locator('#cronExpr').click();
    dialog = page.getByRole('dialog', { name: '定时任务配置' });
    await dialog.getByText('自定义', { exact: true }).click();
    assert.equal(await dialog.getByRole('textbox').inputValue(), '15 9 * * *');
  });
});

test('nested cron dialog keeps content and actions inside a short viewport', async () => {
  await withPage([schedule], async page => {
    await page.setViewportSize({ width: 600, height: 360 });
    const dialog = await editCron(page);
    const box = await dialog.boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= 360, JSON.stringify(box));
    const save = dialog.getByRole('button', { name: /保\s*存/ });
    assert.ok(await save.evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }), 'nested dialog actions must not be covered');
  });
});
