import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { BUSINESS_OUTCOME_SCHEMA } from '../packages/shared/dist/flow-business-outcome.js';

/**
 * 这个仓库装的是 `playwright-core`（不带浏览器），而不是完整的 `playwright`，
 * 而且它是 @bcp/extension 的依赖、没提升到仓库根 —— 所以从 scripts/ 按包名
 * import 会直接 ERR_MODULE_NOT_FOUND。旧写法硬依赖 `playwright` 的具名导出，
 * 结果是 `chromium` 为 undefined，八条用例一起挂在 `launch` 上：看起来像 UI
 * 全坏了，其实浏览器一行都没跑起来。
 *
 * 三档依次尝试：显式 PLAYWRIGHT_MODULE → 完整 playwright → 从声明它的
 * package.json 解析 playwright-core。core 不会替你找浏览器，所以下面给
 * CHROME_PATH 一个 macOS 默认值。
 */
async function loadPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return import(process.env.PLAYWRIGHT_MODULE);
  try {
    return await import('playwright');
  } catch { /* 没装完整包，退回 core */ }
  const requireFromExtension = createRequire(new URL('../packages/extension/package.json', import.meta.url));
  const mod = await import(pathToFileURL(requireFromExtension.resolve('playwright-core')).href);
  // CJS 的具名导出在深层路径下不一定被识别，兜到 default 上。
  return mod.chromium ? mod : mod.default;
}

const CHROME_PATH = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const { chromium } = await loadPlaywright();
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH, args: ['--no-sandbox'] });
});
after(async () => browser?.close());

const graph = { nodes: [
  { id: 'script-preprocess', type: 'script', label: '商品预处理', position: { x: 0, y: 0 }, config: { command: ['python', 'product-preprocess/scripts/preprocess_wrapper.py'] } },
  { id: 'branch-ready', type: 'branch', label: '历史发布判断', position: { x: 240, y: 0 }, config: { cases: [{ id: 'ready', left: '$.projectionVerdict.publication.canPublish', op: 'isTrue' }, { id: 'draftable', left: '$.projectionVerdict.publication.canDraft', op: 'isTrue' }], otherwise: true } },
  { id: 'book-publish', type: 'book', position: { x: 480, y: 0 }, config: { bookId: 'book', constants: { mode: 'publish' }, resumePolicy: 'verify-before-retry' } },
  { id: 'result', type: 'flowOutput', position: { x: 720, y: 0 }, config: { portId: 'value', schema: BUSINESS_OUTCOME_SCHEMA } },
], edges: [
  { source: 'script-preprocess', sourceHandle: 'output', srcPath: '$.outcome', target: 'result', targetHandle: 'value' },
  { source: 'book-publish', sourceHandle: 'outputs', srcPath: '$.outcome', target: 'result', targetHandle: 'value' },
] };
const now = '2026-09-11T00:00:00Z';
function row(nodeId, output, extra = {}) {
  return { id: `${nodeId}-row`, nodeId, nodeType: graph.nodes.find(node => node.id === nodeId).type, status: 'success', iteration: null, slot: null, runId: null, inputJson: '{}', outputJson: JSON.stringify(output), errorMessage: null, startedAt: now, finishedAt: now, durationMs: 200, ...extra };
}
function fixture(state = 'needs_input') {
  const preprocess = { status: state === 'blocked' ? 'blocked' : 'ready', reason: '分类未匹配', projectionVerdict: { publication: { canPublish: false, canDraft: true, missingRequired: state === 'needs_input' ? ['商品资质'] : [] } }, phaseTimings: { totalMs: 1800, stages: [{ name: 'data_preparation', durationMs: 500, status: 'completed' }, { name: 'projection_validation', durationMs: 300, status: 'completed' }] } };
  const nodes = [row('script-preprocess', { output: preprocess }), row('branch-ready', { otherwise: {} }, { inputJson: JSON.stringify({ input: { projectionVerdict: { publication: { canPublish: false } }, access_token: 'diagnostic-secret' } }) })];
  const labels = { needs_input: '待补资料', blocked: '已阻断', published: '已提交发布', draft_saved: '草稿已保存' };
  const outcome = { status: state, label: labels[state], level: state === 'blocked' ? 'error' : 'warning', reason: '已记录业务结果', missingRequired: state === 'needs_input' ? ['商品资质'] : [] };
  if (['needs_input', 'blocked'].includes(state)) {
    nodes[0].outputJson = JSON.stringify({ output: { ...preprocess, outcome } });
  }
  if (['published', 'draft_saved', 'needs_verification'].includes(state)) nodes.push(row('book-publish', state === 'needs_verification' ? {} : { outputs: { outcome: { ...outcome, level: 'success', resourceId: '123', resourceUrl: 'https://example.com/product/123?access_token=diagnostic-secret' } } }, { runId: 'book-run' }));
  return { id: 'fixture-run', flowId: 'diagnostic-fixture', flow: { name: '诊断测试' }, graphSnapshot: JSON.stringify(graph), paramsJson: '{"password":"diagnostic-secret"}', trigger: 'manual', mode: 'auto', status: state === 'failed' ? 'failed' : state === 'active' ? 'running' : 'success', queuedAt: now, startedAt: now, finishedAt: now, durationMs: 2000, errorMessage: null, failedNodeId: null, resumeBlockReason: null, nodes };
}

async function withPage(run, exercise, { width = 1440, height = 900, mode = 'light', editor = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, acceptDownloads: true });
  page.setDefaultTimeout(5000);
  await page.addInitScript(value => localStorage.setItem('bcp-console-mode', value), mode);
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    window.diagnosticBlobUrls = { created: [], revoked: [] };
    URL.createObjectURL = blob => {
      const url = create(blob);
      window.diagnosticBlobUrls.created.push(url);
      return url;
    };
    URL.revokeObjectURL = url => {
      window.diagnosticBlobUrls.revoked.push(url);
      revoke(url);
    };
  });
  const flow = { id: run.flowId, name: '诊断测试', graphJson: JSON.stringify({ ...graph, nodes: graph.nodes.map(node => ({ ...node, label: '当前编辑过的判断' })) }), inputSchema: '[]', outputSchema: null, enabled: true, deletedAt: null, createdAt: now, updatedAt: now };
  await page.route('**/api/**', async route => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 403, json: { message: 'Read-only synthetic test' } });
    const path = new URL(route.request().url()).pathname;
    const fixtures = { '/api/flow-runs/fixture-run': run, '/api/flow-runs': [run], '/api/flows/diagnostic-fixture': flow, '/api/flows': [flow], '/api/books': [], '/api/schemas': [], '/api/schema-records': [] };
    return route.fulfill(path in fixtures ? { json: fixtures[path] } : { status: 404, json: { message: 'No synthetic fixture' } });
  });
  try {
    await page.goto(`${process.env.CONSOLE_URL ?? 'http://localhost:8790'}/#/${editor ? 'flows/diagnostic-fixture' : 'flow-runs/fixture-run'}`);
    if (editor) await page.getByRole('button', { name: /执行监控/ }).click();
    await exercise(page);
  } finally { await page.close(); }
}

test('detail shows separate business state and snapshot branch evidence', async () => {
  await withPage(fixture(), async page => {
    // 详情页的「运行结果与诊断」区域只讲业务结论；分支条件与阶段耗时的证据在
    // 左侧执行时间线的节点卡片里，所以那几条断言落在整页上而不是区域上。
    const summary = page.getByRole('region', { name: '运行结果与诊断' });
    await summary.waitFor();
    assert.ok(await summary.getByText('待补资料', { exact: true }).count());
    assert.ok(await summary.getByText('商品资质', { exact: true }).count());
    assert.ok(await page.getByText('历史发布判断', { exact: true }).count());
    assert.ok(await page.getByText('false', { exact: true }).count());
    assert.ok(await page.getByText('字段缺失', { exact: true }).count());
    assert.ok(await page.getByText(/1800 ms/).count());
    assert.equal(await page.getByText('当前编辑过的判断', { exact: true }).count(), 0);
    assert.equal(await summary.locator('a[href="#/runs/fixture-run"]').count(), 0);
  });
});

test('business states use receipts and preserve unknown active states', async () => {
  const labels = { published: '已提交发布', draft_saved: '草稿已保存', blocked: '已阻断', failed: '业务失败', needs_verification: '待核验', active: '业务结果尚未确定' };
  for (const [state, label] of Object.entries(labels)) await withPage(fixture(state), async page => {
    const summary = page.getByRole('region', { name: '运行结果与诊断' });
    await summary.getByText(label, { exact: true }).waitFor();
    if (state === 'published' || state === 'draft_saved') {
      assert.equal(await summary.locator('a[href="#/runs/book-run"]').count(), 1);
      const link = summary.getByRole('link', { name: '资源页面' });
      assert.equal((await link.getAttribute('href')).includes('diagnostic-secret'), false);
    }
  });
});

test('preview and downloaded archive use the same redacted diagnostic snapshot', async () => {
  // 诊断预览与归档下载只存在于编辑器侧栏的摘要面板（详情页那份是业务结论面板，
  // 不带原始快照预览），所以这条跑在编辑器模式下。
  await withPage(fixture(), async page => {
    const summary = page.getByRole('region', { name: '运行结果与诊断' });
    await summary.getByText('诊断预览（已脱敏）', { exact: true }).click();
    assert.equal((await summary.innerText()).includes('diagnostic-secret'), false);
    await summary.getByText('原文', { exact: true }).click();
    const preview = await summary.locator('.content-view pre').innerText();
    const downloaded = page.waitForEvent('download');
    await summary.getByRole('button', { name: '下载诊断归档' }).click();
    const download = await downloaded;
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    assert.equal(text.includes('diagnostic-secret'), false);
    assert.equal(JSON.parse(text).redacted, true);
    assert.equal(JSON.parse(JSON.parse(text).run.graphSnapshot).nodes[1].label, '历史发布判断');
    assert.equal(text, preview);
    assert.ok(await page.evaluate(() => window.diagnosticBlobUrls.created.every(url => window.diagnosticBlobUrls.revoked.includes(url))));
  }, { editor: true });
});

test('expanded monitor stays readable in light, dark and narrow layouts', async () => {
  for (const mode of ['light', 'dark']) await withPage(fixture(), async page => {
    const summary = page.getByRole('region', { name: '运行结果与诊断' });
    await summary.getByText('待补资料', { exact: true }).waitFor();
    assert.ok(await summary.getByText('历史发布判断', { exact: true }).count());
    const box = await summary.boundingBox();
    assert.ok(box.width > 0 && box.x >= 0 && box.x + box.width <= 420, JSON.stringify(box));
    assert.ok(await summary.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  }, { width: 420, height: 800, mode, editor: true });
});

test('old missing input, offloaded evidence and redacted comparison have explicit notices', async () => {
  const run = fixture();
  delete run.resumeBlockReason;
  run.nodes[1].inputJson = null;
  run.nodes[0].outputJson = '{"$ref":"offloaded"}';
  await withPage(run, async page => {
    const summary = page.getByRole('region', { name: '运行结果与诊断' });
    await summary.getByText('待核验', { exact: true }).waitFor();
    assert.ok(await page.getByText(/输入证据不可用/).count());
    assert.ok(await summary.getByText(/旧版服务/).count());
  });
  run.nodes[1].inputJson = JSON.stringify({ input: { projectionVerdict: { publication: { canPublish: '[REDACTED]' } } } });
  await withPage(run, async page => {
    const summary = page.getByRole('region', { name: '运行结果与诊断' });
    await page.getByText('已脱敏，无法比较', { exact: true }).waitFor();
    assert.ok(await page.getByText(/已记录端口：otherwise/).count());
    assert.ok(await summary.getByText('待核验', { exact: true }).count());
  });
});

test('URL redaction and malformed credentials stay safe in historical diagnostics', async () => {
  const run = fixture();
  const snapshot = JSON.parse(run.graphSnapshot);
  snapshot.nodes[1].config.cases = [{ id: 'equal', left: '$.left', op: 'eq', right: '$.right' }];
  run.graphSnapshot = JSON.stringify(snapshot);
  run.nodes[1].inputJson = JSON.stringify({ input: { left: 'https://user:first-secret@example.com/product', right: 'https://user:second-secret@example.com/product' } });
  run.nodes[1].errorMessage = JSON.stringify(JSON.stringify({ access_token: 'malformed-secret' })).slice(0, -3);
  await withPage(run, async page => {
    const summary = page.getByRole('region', { name: '运行结果与诊断' });
    await summary.getByText('已脱敏，无法比较', { exact: true }).waitFor();
    assert.ok(await summary.getByText(/已记录端口：otherwise/).count());
    assert.equal(await summary.getByText('条件成立', { exact: true }).count(), 0);
    await summary.getByText('诊断预览（已脱敏）', { exact: true }).click();
    await summary.getByText('原文', { exact: true }).click();
    const body = await page.locator('body').innerText();
    for (const secret of ['first-secret', 'second-secret', 'malformed-secret']) assert.equal(body.includes(secret), false);
    assert.ok((await summary.locator('.content-view pre').innerText()).includes('__diagnostic_redacted'));
  }, { editor: true });
});

test('wrapped true input agrees with the historical ready output port', async () => {
  const run = fixture();
  const input = { projectionVerdict: { publication: { canPublish: true, canDraft: true } } };
  run.nodes[1].inputJson = JSON.stringify({ input });
  run.nodes[1].outputJson = JSON.stringify({ ready: input });
  await withPage(run, async page => {
    const branch = page.locator('.frd-branch');
    await branch.getByText('已记录端口：ready', { exact: true }).waitFor();
    assert.equal(await branch.getByText('条件成立', { exact: true }).count(), 2);
    assert.equal(await branch.getByText('字段缺失', { exact: true }).count(), 0);
  });
});

test('large branch operands are bounded and folded on narrow screens while safe archives retain them', async () => {
  const run = fixture();
  const payload = { description: 'fixture-body-'.repeat(1500), items: Array.from({ length: 100 }, (_, id) => ({ id })) };
  const snapshot = JSON.parse(run.graphSnapshot);
  snapshot.nodes[1].config.cases = [{ id: 'equal', left: '$.payload', op: 'eq', right: '$.expected' }];
  run.graphSnapshot = JSON.stringify(snapshot);
  run.nodes[1].inputJson = JSON.stringify({ input: { payload, expected: payload.description } });
  await withPage(run, async page => {
    const branch = page.locator('.frd-branch');
    await branch.waitFor();
    assert.ok((await branch.innerText()).length < 600);
    const operands = branch.locator('details.frd-operand');
    assert.equal(await operands.count(), 2);
    assert.equal(await operands.locator('.content-view').count(), 0);
    assert.ok(await branch.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await operands.first().locator(':scope > summary').click();
    await operands.first().locator('.content-view').waitFor();
    assert.ok(await branch.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载诊断归档' }).click();
    const stream = await (await downloadPromise).createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const archive = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.deepEqual(JSON.parse(archive.run.nodes[1].inputJson).input.payload, payload);
    assert.equal(JSON.parse(archive.run.nodes[1].inputJson).input.expected, payload.description);
    await operands.first().locator(':scope > summary').click();
    assert.equal(await operands.locator('.content-view').count(), 0);
  }, { width: 420, height: 800, editor: true });
});
