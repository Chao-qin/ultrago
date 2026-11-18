import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../packages/extension/package.json', import.meta.url));
const { _electron } = require('playwright-core');
const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));
if (process.platform !== 'linux') throw new Error('此壳验证依赖 Linux 独立配置目录；Windows 请执行实机验收。');
const profile = await mkdtemp(join(tmpdir(), 'bcp-electron-acceptance-'));
let xvfb;
let application;
let exited = false;
try {
  let display = process.env.DISPLAY;
  if (process.platform === 'linux') {
    xvfb = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1140x820x24', '-ac', '-nolisten', 'tcp']);
    display = await new Promise((done, fail) => {
      const timeout = setTimeout(() => fail(new Error('独立 Xvfb 启动超时')), 10_000);
      xvfb.once('error', (error) => { clearTimeout(timeout); fail(error); });
      xvfb.stdout.once('data', (chunk) => { clearTimeout(timeout); done(`:${String(chunk).trim()}`); });
    });
  }
  application = await _electron.launch({
    executablePath: desktopRequire('electron'), args: ['--no-sandbox', resolve('packages/desktop')],
    env: { ...process.env, ...(display ? { DISPLAY: display } : {}), XDG_CONFIG_HOME: profile }, timeout: 30_000,
  });
  await application.firstWindow();
  let page;
  const pageDeadline = Date.now() + 10000;
  while (!page && Date.now() < pageDeadline) {
    page = application.context().pages().find((candidate) => candidate.url().endsWith('/ui/index.html'));
    if (!page) await new Promise((done) => setTimeout(done, 50));
  }
  assert.ok(page, '应找到主引导页面，不能把浮动视图当成主窗口');
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await page.locator('#prepare-next').filter({ hasText: '点击准备工作台' }).waitFor();
    await page.locator('#agent-config').filter({ hasText: 'mcpServers' }).waitFor({ state: 'attached' });
    assert.equal(await page.locator('#error').isVisible(), false, '首次 IPC 请求不应早于处理器注册');
    assert.equal(await page.locator('.brand-icon').evaluate((node) => node.complete && node.naturalWidth > 0), true);
    assert.equal(await page.locator('#agent-check').isDisabled(), true);
  }
  await page.evaluate(() => window.desktop.action('copyAgentConfig', 'opencode'));
  const config = await application.evaluate(async ({ clipboard }) => JSON.parse(await clipboard.readText()));
  assert.equal(config.mcp.servers['ultrago'].type, 'local');
  assert.ok(config.mcp.servers['ultrago'].command.includes('--mcp-stdio'));
  const state = await page.evaluate(() => window.desktop.action('state'));
  assert.deepEqual(state.services, []);
  const userData = await application.evaluate(({ app }) => app.getPath('userData'));
  const descriptor = JSON.parse(await readFile(join(userData, 'runtime.json'), 'utf8'));
  const originalWindow = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  const sample = `${descriptor.origin}/__desktop/sample`;
  assert.equal((await fetch(sample)).status, 200);
  assert.equal(await application.evaluate(({ Menu }) => Menu.getApplicationMenu()), null, '原生菜单已移除');
  const shellPage = application.context().pages().find((candidate) => candidate.url().endsWith('/ui/shell.html'));
  assert.ok(shellPage, '浮动控制层必须存在');
  await shellPage.locator('#shell-trigger').waitFor();
  await shellPage.locator('#shell-trigger').click();
  assert.equal(await shellPage.locator('#shell-menu').isVisible(), true);
  assert.equal(await shellPage.locator('[data-shell-action="workbench"]').isDisabled(), true);
  assert.equal(await shellPage.locator('[data-shell-action="tray"]').isEnabled(), true);
  await shellPage.locator('[data-shell-action="zoomIn"]').click();
  assert.ok(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()) > 1);
  await shellPage.locator('[data-shell-action="zoomReset"]').click();
  await shellPage.keyboard.press('Escape');
  assert.equal(await shellPage.locator('#shell-menu').isVisible(), false);
  const isolated = await application.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];
    const view = main.contentView.children.find((child) => child.webContents?.getURL().endsWith('/ui/shell.html'));
    const handler = ipcMain._invokeHandlers.get('desktop:shell');
    const attempts = [{ sender: main.webContents, senderFrame: main.webContents.mainFrame }, { sender: view.webContents, senderFrame: main.webContents.mainFrame }];
    const rejected = [];
    for (const event of attempts) {
      try { await handler(event, 'state'); rejected.push(false); }
      catch (error) { rejected.push(error.message === '操作来源无效'); }
    }
    return rejected;
  });
  assert.deepEqual(isolated, [true, true], '生产浮动通道须拒绝主页面与错误Frame');
  await shellPage.evaluate(() => { window.shellEvents = []; for (const type of ['pointerenter', 'pointerleave', 'focusin', 'blur']) window.addEventListener(type, () => window.shellEvents.push(type), true); });
  await page.locator('h2:visible').click();
  try { await shellPage.waitForFunction(() => document.body.classList.contains('idle'), undefined, { timeout: 11000 }); }
  catch (error) { throw new Error('idle observation: ' + JSON.stringify(await shellPage.evaluate(() => ({ events: window.shellEvents, focus: document.hasFocus(), active: document.activeElement?.id, classes: document.body.className, hover: document.querySelector('#shell-trigger').matches(':hover') }))), { cause: error }); }
  await shellPage.waitForFunction(() => Number(getComputedStyle(document.querySelector('#shell-trigger')).opacity) < .4, undefined, { timeout: 2000 });
  assert.ok(await shellPage.locator('#shell-trigger').evaluate((node) => new DOMMatrix(getComputedStyle(node).transform).m41 < -20));
  await shellPage.locator('#shell-trigger').hover();
  await shellPage.waitForFunction(() => !document.body.classList.contains('idle'));
  const initialDock = await shellPage.evaluate(() => window.desktopShell.action('state'));
  const triggerBounds = await shellPage.locator('#shell-trigger').boundingBox();
  await shellPage.mouse.move(triggerBounds.x + 24, triggerBounds.y + 24);
  await shellPage.mouse.down();
  await shellPage.mouse.move(1000, 300, { steps: 12 });
  await shellPage.mouse.up();
  await shellPage.waitForFunction(() => document.body.dataset.edge === 'right', undefined, { timeout: 5000 });
  const movedDock = await shellPage.evaluate(() => window.desktopShell.action('state'));
  assert.notEqual(movedDock.placement.bounds.x, initialDock.placement.bounds.x, '拖动必须改变真实浮动视图的位置');
  assert.equal(await shellPage.locator('#shell-menu').isVisible(), false, '拖动松手不能触发菜单点击');
  const savedDock = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8'));
  assert.equal(savedDock.shellPosition.edge, 'right', '拖动后保存吸附位置');
  await shellPage.locator('#shell-trigger').click();
  assert.equal(await shellPage.locator('#shell-menu').isVisible(), true);
  const dockedMenu = await shellPage.evaluate(() => ({ trigger: document.querySelector('#shell-trigger').getBoundingClientRect().toJSON(), menu: document.querySelector('#shell-menu').getBoundingClientRect().toJSON(), width: innerWidth, height: innerHeight }));
  assert.ok(dockedMenu.menu.left >= 0 && dockedMenu.menu.right <= dockedMenu.width && dockedMenu.menu.bottom <= dockedMenu.height, '贴边后的菜单不应被裁切');
  await shellPage.keyboard.press('Escape');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  assert.equal((await fetch(sample)).status, 200, '关闭窗口后本地入口仍须存活');
  await application.evaluate(({ app }) => app.emit('second-instance'));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  await shellPage.locator('#shell-trigger').click();
  await shellPage.locator('[data-shell-action="tray"]').click();
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await application.evaluate(({ app }) => app.emit('second-instance'));
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('minimize'));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false, '最小化事件须收起窗口');
  assert.equal((await fetch(sample)).status, 200);
  await application.evaluate(({ app }) => app.emit('activate'));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id), originalWindow);
  assert.equal((await page.evaluate(() => window.desktop.action('state'))).generation, state.generation);
  await assert.rejects(access(join(userData, 'resource/db/console.db')));
  await page.screenshot({ path: join(profile, 'setup.png') });
  const exit = new Promise((done) => application.process().once('exit', done));
  await application.evaluate(({ app }) => { setTimeout(() => { app.quit(); app.quit(); }, 0); });
  await Promise.race([exit, new Promise((_done, fail) => { const timer = setTimeout(() => fail(new Error('退出清理超时')), 12000); timer.unref(); })]);
  exited = true;
  await assert.rejects(fetch(sample, { signal: AbortSignal.timeout(1000) }));
  process.stdout.write(`PASS actual Electron initial load/reload, icon, clipboard, drag/dock/persistence/menu bounds, tray close/hide/restore, minimize handler and explicit quit; ingress survives hiding and closes on quit; no business services or database. Screenshot: ${join(profile, 'setup.png')}\n`);
} finally {
  if (application && !exited) {
    const ownedProcess = application.process();
    const fallback = setTimeout(() => ownedProcess.kill('SIGKILL'), 5000);
    try { await application.close(); } finally { clearTimeout(fallback); }
  }
  xvfb?.kill('SIGTERM');
}
