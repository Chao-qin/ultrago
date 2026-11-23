import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const require = createRequire(new URL('../packages/extension/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const screenshots = process.env.DESKTOP_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
try {
  for (const width of [1140, 780]) for (const colorScheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 820 }, colorScheme, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('https://desktop.test/**', async (route) => {
      const name = new URL(route.request().url()).pathname.slice(1) || 'index.html';
      if (!['index.html', 'setup.css', 'setup.mjs', 'app-icon.png'].includes(name)) return route.fulfill({ status: 404, body: '' });
      await route.fulfill({ contentType: { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.png': 'image/png' }[extname(name)], body: await readFile(new URL(`../packages/desktop/ui/${name}`, import.meta.url)) });
    });
    await page.addInitScript(() => {
      let state = { phase: 'waiting', detail: '点击准备工作台，开始检查本地环境。', services: [], browsers: [], modelMode: 'skip', dataDirectory: 'C:\\Users\\卖家\\AppData\\Roaming\\UltraGoDesktop' };
      let listener;
      window.desktop = {
        subscribe: (fn) => { listener = fn; },
        action: async (name, input) => {
          (window.__bridgeCalls ??= []).push([name, input ?? null]);
          if (name === 'agentGuide') return { config: JSON.stringify(input === 'opencode' ? { mcp: { servers: { 'ultrago': { type: 'local', command: ['C:\\Program Files\\UltraGo Internal.exe', '--mcp-stdio'] } } } } : { mcpServers: { 'ultrago': { command: 'C:\\Program Files\\UltraGo Internal.exe', args: ['--mcp-stdio'] } } }), executable: 'C:\\Program Files\\UltraGo Internal.exe', args: ['--mcp-stdio'], steps: ['打开助手设置。', '合并配置。', '重新连接。'], download: input === 'generic' ? undefined : 'https://example.test/download' };
          if (name === 'detectAgents') return [
            { client: 'claude', name: 'Claude Desktop', via: 'config', detected: true, where: '', blocked: 'fixture: 检测到应用商店（MSIX）版 Claude Desktop，请复制配置' },
            { client: 'claude-code', name: 'Claude Code', via: 'cli', detected: true, where: 'C:\\Users\\卖家\\.local\\bin\\claude.exe' },
            { client: 'cursor', name: 'Cursor', via: 'link', detected: !window.cursorGoneFixture, where: window.cursorGoneFixture ? '' : 'Cursor' },
            { client: 'vscode', name: 'VS Code', via: 'link', detected: false, where: '' },
          ];
          if (name === 'connectAgents' && window.holdConnectFixture) await new Promise((resolve) => { window.releaseConnectFixture = resolve; });
          if (name === 'connectAgents') return input.map((client) => client === 'cursor'
            ? { client, ok: false, message: 'fixture: Cursor 没有响应安装链接' }
            : { client, ok: true, message: '已加入 Claude Code 的用户配置，重新打开 Claude Code 后可用。' });
          if (name === 'autostartState') return false;
          if (name === 'policy') state = { ...state, ...(input.allowEval !== undefined ? { allowEval: input.allowEval } : {}), ...(input.allowLocalEval !== undefined ? { allowLocalEval: input.allowLocalEval } : {}), ...(input.screenshotDir !== undefined ? { screenshotDir: input.screenshotDir || '' } : {}) };
          if (name === 'chooseScreenshotDir') state = { ...state, screenshotDir: 'C:\\Users\\卖家\\Desktop\\agent工作区' };
          if (name === 'autostart') {
            if (window.autostartFixture === 'throw') throw new Error('fixture: 开机启动写入失败');
            return window.autostartFixture === 'deny' ? false : input === true;
          }
          if (name === 'checkMcp') {
            if (window.holdMcpFixture) return new Promise((resolve) => { window.resolveMcpFixture = () => resolve({ toolCount: 99 }); });
            return { toolCount: 12 };
          }
          if (['copyAgentConfig', 'agentDocs', 'agentDownload'].includes(name)) return;
          if (name === 'prepare') state = { ...state, phase: 'ready', busy: false, bridgeReady: true, bridgeError: '', detail: '工作台已启动，请确认要使用的浏览器。', services: ['backend', 'console'], browsers: [{ kind: 'chrome', instanceId: 'profile-one', ready: true }] };
          if (name === 'repairBridge') state = { ...state, bridgeReady: true, bridgeError: '' };
          if (name === 'selectBrowser') state = { ...state, browserId: input, browserReady: true };
          if (name === 'demo') state = { ...state, demo: { status: 'success', ranSteps: 2, totalSteps: 2, content: { raw: JSON.stringify({ text: '云朵收纳袋 ¥29.90 库存120' }) } } };
          if (name === 'saveModel') state = { ...state, phase: 'waiting', modelMode: input.mode, browserReady: false, services: [], detail: '模型方式已保存，点击准备工作台使配置生效。' };
          listener?.(state); return state;
        },
      };
      window.setDesktopFixture = (next) => { state = { ...state, ...next }; listener?.(state); };
    });
    await page.goto('https://desktop.test/');
    await page.locator('#prepare-next').filter({ hasText: '点击准备工作台' }).waitFor();
    await page.locator('#agent-config').filter({ hasText: 'mcpServers' }).waitFor({ state: 'attached' });
    assert.equal(await page.locator('.wizard-panel:visible').count(), 1);
    assert.equal(await page.locator('.checklist [data-step-target]').count(), 6, '五个步骤加权限与偏好，按固定顺序排列');
    assert.equal(await page.locator('[data-step-target="5"]').isDisabled(), false, '权限与偏好不必等服务启动');
    assert.match(await page.locator('[data-step-target="0"]').getAttribute('class'), /attention/, '还没做的必需项要突出');
    assert.equal(await page.locator('#next-step').isDisabled(), true);
    assert.equal(await page.locator('[data-step-target="1"]').isDisabled(), true);
    assert.equal(await page.locator('#preparation-log').evaluate((node) => node.open), false);
    assert.equal(await page.locator('.brand-icon').evaluate((node) => node.complete && node.naturalWidth > 0), true);
    await page.evaluate(() => window.setDesktopFixture({ phase: 'initializing', busy: true, phaseStartedAt: Date.now() - 16000, logs: [{ service: 'migrate', text: '正在检查已有记录…' }] }));
    assert.equal(await page.locator('#preparation-log').evaluate((node) => node.open), false, '正常准备不应自动展开日志');
    await page.locator('#prepare-elapsed').filter({ hasText: '120 秒' }).waitFor();
    await page.locator('#preparation-log summary').click();
    await page.evaluate(() => window.setDesktopFixture({ phase: 'starting' }));
    assert.equal(await page.locator('#preparation-log').evaluate((node) => node.open), true, '保留用户手动展开');
    await page.locator('#preparation-log summary').click();
    await page.evaluate(() => window.setDesktopFixture({ phase: 'failed', busy: false, detail: '测试准备失败' }));
    assert.equal(await page.locator('#preparation-log').evaluate((node) => node.open), true);
    await page.locator('[data-action="copyDiagnostics"]:visible').click();
    await page.locator('[data-step-target="2"]').click();
    assert.equal(await page.locator('#model').isVisible(), true, '失败后仍可修正模型配置');
    assert.equal(await page.locator('#model-save').isVisible(), false, '没改选择时不显示保存');
    await page.locator('input[value="cloud"]').check();
    await page.locator('input[value="skip"]').check();
    await page.locator('#model-save').click();
    await page.locator('#environment').waitFor();
    await page.locator('#prepare').click();
    assert.equal(await page.locator('#preparation-log').evaluate((node) => node.open), false, '恢复后收起失败日志');
    if (screenshots) await page.screenshot({ path: join(screenshots, `${width}-${colorScheme}-workspace.png`), fullPage: true, animations: 'disabled' });
    await page.locator('#next-step').click();
    assert.equal(await page.locator('#browser').isVisible(), true);
    assert.equal(await page.locator('#bridge-repair').isVisible(), false, '自动注册成功时不应显示额外注册入口');
    assert.equal(await page.locator('[data-step-target="1"] .step-status').textContent(), '等待确认 Chrome');
    assert.match(await page.locator('[data-step-target="1"]').getAttribute('class'), /attention/, '服务就绪后待办转到连接 Chrome');
    await page.evaluate(() => window.setDesktopFixture({ bridgeReady: false, bridgeError: 'fixture: 当前用户注册失败' }));
    assert.equal(await page.locator('#bridge-repair').isVisible(), true);
    await page.locator('#repair-bridge').click();
    await page.locator('#bridge-repair').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#next-step').isDisabled(), true);
    assert.equal(await page.locator('#browser-select option').first().textContent(), 'Chrome（已连接）', '唯一浏览器不显示内部 ID');
    assert.equal(await page.locator('#header-workbench').isVisible(), true, '服务就绪后每一步都能进入工作台');
    await page.locator('#select-browser').click();
    await page.locator('#model').waitFor();
    assert.match(await page.locator('#next-step').textContent(), /跳过，下一步：接入 AI 助手/, '确认浏览器后进入下一步，模型可跳过');
    await page.locator('[data-step-target="2"]').click();
    assert.equal(await page.locator('input[value="skip"]').isChecked(), true);
    assert.equal(await page.locator('#cloud-fields').isVisible(), false);
    assert.equal(await page.locator('#api-key').isDisabled(), true);
    await page.locator('input[value="cloud"]').check();
    await page.locator('#api-url').fill('https://fixture.example/v1');
    assert.equal(await page.locator('#cloud-fields').isVisible(), true);
    assert.match(await page.locator('#model-status').textContent(), /未保存/);
    await page.evaluate(() => window.setDesktopFixture({}));
    assert.equal(await page.locator('input[value="cloud"]').isChecked(), true);
    assert.equal(await page.locator('#api-key').isEnabled(), true);
    await page.locator('#previous-step').click();
    await page.locator('[data-step-target="2"]').click();
    assert.equal(await page.locator('#api-url').inputValue(), 'https://fixture.example/v1', '步骤切换保留草稿');
    await page.locator('input[value="skip"]').check();
    await page.locator('#model-save').click();
    await page.locator('#environment').waitFor();
    assert.equal(await page.locator('#api-key').inputValue(), '');
    await page.locator('#prepare').click();
    assert.equal(await page.locator('#prepare-progress').evaluate((node) => node.value), 4);
    assert.match(await page.locator('#prepare-next').textContent(), /下一步.*Chrome/);
    await page.locator('#next-step').click();
    await page.locator('#select-browser').click();
    await page.locator('#model').waitFor();
    await page.locator('#next-step').click();
    await page.locator('#agents').waitFor();
    // The assistant step names the assistants found on this computer.
    await page.locator('#agent-summary').filter({ hasText: '检测到 Claude Code、Cursor' }).waitFor();
    assert.equal(await page.locator('#agent-list input[value="vscode"]').isDisabled(), true, '未检测到的助手不能勾选');
    assert.equal(await page.locator('#agent-list input[value="claude"]').isDisabled(), true, '应用商店版 Claude 写配置不生效，不能勾选');
    assert.match(await page.locator('#agent-list li', { has: page.locator('input[value="claude"]') }).textContent(), /MSIX/);
    assert.equal(await page.locator('#agent-connect').isDisabled(), true, '没勾选时不能接入');
    // A tick on an assistant that a re-detection no longer finds must not survive into the connect call.
    await page.locator('#agent-list input[value="cursor"]').check();
    await page.evaluate(() => { window.cursorGoneFixture = true; });
    await page.locator('#agent-redetect').click();
    await page.waitForFunction(() => document.querySelector('#agent-list input[value="cursor"]')?.disabled);
    assert.equal(await page.locator('#agent-connect').isDisabled(), true, '重新检测后丢掉已不存在助手的勾选');
    await page.evaluate(() => { window.cursorGoneFixture = false; window.holdConnectFixture = true; });
    await page.locator('#agent-redetect').click();
    await page.waitForFunction(() => document.querySelector('#agent-list input[value="cursor"]')?.disabled === false);
    await page.locator('#agent-list input[value="claude-code"]').check();
    await page.locator('#agent-list input[value="cursor"]').check();
    await page.locator('#agent-connect').click();
    await page.waitForFunction(() => typeof window.releaseConnectFixture === 'function');
    assert.equal(await page.locator('#agent-connect').isDisabled(), true, '接入进行中不能重复点击');
    assert.equal(await page.locator('#agent-list input[value="claude-code"]').isDisabled(), true, '接入进行中不能改勾选');
    await page.evaluate(() => { window.holdConnectFixture = false; window.releaseConnectFixture(); });
    await page.locator('#agent-list .agent-outcome.failed').filter({ hasText: 'Cursor 没有响应' }).waitFor();
    assert.match(await page.locator('#agent-list li', { has: page.locator('input[value="claude-code"]') }).textContent(), /重新打开 Claude Code 后可用/, '每个助手显示自己的结果');
    const connectCalls = await page.evaluate(() => (window.__bridgeCalls ?? []).filter(([name]) => name === 'connectAgents').map(([, input]) => input));
    assert.deepEqual(connectCalls, [['claude-code', 'cursor']], '只接入勾选的助手');
    assert.match(await page.locator('#agent-connect-result').textContent(), /1 个助手没有接入成功/);
    assert.equal(await page.locator('#agent-connect').isDisabled(), true, '接入后清空勾选');
    await page.locator('#agent-select').selectOption('opencode');
    await page.locator('#agent-config').filter({ hasText: 'servers' }).waitFor({ state: 'attached' });
    assert.equal(await page.locator('#agent-download').isVisible(), true);
    await page.locator('#agent-copy').click();
    await page.locator('#agent-check-result').filter({ hasText: '配置已复制' }).waitFor();
    await page.locator('[data-step-target="5"]').click();
    assert.equal(await page.locator('#preferences').isVisible(), true);
    assert.equal(await page.locator('#next-step').isVisible(), false, '权限与偏好不在线性步骤里');
    assert.equal(await page.locator('#allow-eval').isChecked(), true, '页面脚本默认开启');
    assert.equal(await page.locator('#allow-local-eval').isChecked(), true, '本机脚本默认开启');
    const policyCalls = () => page.evaluate(() => (window.__bridgeCalls ?? []).filter(([name]) => name === 'policy').map(([, input]) => JSON.stringify(input)));
    await page.locator('#allow-local-eval').uncheck();
    await page.locator('#allow-eval').uncheck();
    await page.waitForFunction(() => (window.__bridgeCalls ?? []).filter(([name]) => name === 'policy').length >= 2);
    assert.deepEqual(await policyCalls(), ['{"allowLocalEval":false}', '{"allowEval":false}'], '取消勾选真的把关闭发给客户端');
    await page.evaluate(() => window.setDesktopFixture({}));
    assert.equal(await page.locator('#allow-eval').isChecked(), false, '重新渲染后仍是客户端保存的状态');
    assert.equal(await page.locator('[data-step-target="5"] .step-status').textContent(), '页面脚本关 · 本机脚本关', '清单上能看到开关的当前状态');
    await page.locator('#allow-local-eval').check();
    await page.locator('#allow-eval').check();
    await page.locator('#screenshot-dir').click();
    await page.locator('#screenshot-dir-value').filter({ hasText: 'agent工作区' }).waitFor();
    assert.equal(await page.locator('#screenshot-dir-clear').isVisible(), true);
    await page.locator('#screenshot-dir-clear').click();
    await page.locator('#screenshot-dir-value').filter({ hasText: '截图保存位置：系统临时目录' }).waitFor();
    assert.equal(await page.locator('#autostart').isChecked(), false);
    await page.locator('#autostart').check();
    assert.equal(await page.locator('#autostart').isChecked(), true);
    await page.locator('#autostart').uncheck();
    await page.evaluate(() => { window.autostartFixture = 'deny'; });
    await page.locator('#autostart').click();
    await page.waitForFunction(() => !document.getElementById('autostart').checked);
    await page.evaluate(() => { window.autostartFixture = 'throw'; });
    await page.locator('#autostart').click();
    await page.locator('#error').filter({ hasText: '开机启动写入失败' }).waitFor();
    assert.equal(await page.locator('#autostart').isChecked(), false, '写入失败时开关回到实际状态');
    await page.evaluate(() => { window.autostartFixture = undefined; document.getElementById('error').hidden = true; });
    await page.locator('[data-step-target="3"]').click();
    await page.locator('#agent-check').click();
    await page.locator('#agent-check-result').filter({ hasText: '12 个工具' }).waitFor();
    await page.evaluate(() => window.setDesktopFixture({ connections: { serviceReady: true, mcpReady: true, assistants: [{ id: 'workbuddy', name: 'Workbuddy', state: 'connected', toolCount: 12 }], lastError: '' } }));
    await page.locator('#connection-summary').filter({ hasText: 'Workbuddy · 12 工具' }).waitFor();
    await page.evaluate(() => window.setDesktopFixture({ connections: { serviceReady: true, mcpReady: true, assistants: [], lastError: 'fixture: stdio 启动失败' } }));
    assert.equal(await page.locator('#connection-error').isVisible(), true);
    await page.evaluate(() => window.setDesktopFixture({ connections: { serviceReady: true, mcpReady: true, assistants: [], lastError: '' } }));
    assert.equal(await page.locator('#connection-error').isVisible(), false);
    await page.evaluate(() => { window.holdMcpFixture = true; });
    await page.locator('#agent-check').click();
    await page.evaluate(() => window.setDesktopFixture({}));
    assert.equal(await page.locator('#agent-check').isDisabled(), true);
    await page.evaluate(() => { window.setDesktopFixture({ generation: 'new-launch' }); window.resolveMcpFixture(); window.holdMcpFixture = false; });
    assert.doesNotMatch(await page.locator('#agent-check-result').textContent(), /99 个工具/);
    assert.equal(await page.locator('#demo').isEnabled(), true);
    await page.locator('[data-step-target="4"]').click();
    await page.locator('#demo').click();
    await page.locator('#result').filter({ hasText: '云朵收纳袋' }).waitFor();
    if (screenshots) await page.screenshot({ path: join(screenshots, `${width}-${colorScheme}-experience.png`), fullPage: true, animations: 'disabled' });
    assert.equal(await page.locator('#workbench').isVisible(), true);
    assert.equal(await page.locator('#workbench').isEnabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width} ${colorScheme} viewport overflow`);
    assert.deepEqual(errors, []);
    await page.locator('[data-step-target="5"]').click();
    await page.evaluate(() => window.setDesktopFixture({ phase: 'waiting', setupCompleted: true, browserReady: false }));
    await page.evaluate(() => window.setDesktopFixture({ phase: 'ready' }));
    assert.equal(await page.locator('#browser').isVisible(), true, '已使用用户仅需恢复浏览器连接');
    await page.evaluate(() => window.setDesktopFixture({ browserReady: true }));
    await page.locator('[data-step-target="4"]').click();
    await page.evaluate(() => scrollTo(0, 0));
    if (screenshots) await page.screenshot({ path: join(screenshots, `${width}-${colorScheme}.png`), fullPage: true, animations: 'disabled' });
    process.stdout.write(`PASS setup interaction / ${width}px / ${colorScheme} (fixture bridge, no backend)\n`);
    await page.close();
  }
} finally { await browser.close(); }
