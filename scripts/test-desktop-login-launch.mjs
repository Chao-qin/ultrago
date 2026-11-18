import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Launches the real Electron shell with --launch-at-login. Neither case reaches a database step:
// a first run never prepares, and the completed profile fails while checking its model settings.
const require = createRequire(new URL('../packages/extension/package.json', import.meta.url));
const { _electron } = require('playwright-core');
const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));
if (process.platform !== 'linux') throw new Error('此壳验证依赖 Linux 独立配置目录；Windows 请执行实机验收。');
const xvfb = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1140x820x24', '-ac', '-nolisten', 'tcp']);
try {
  const display = await new Promise((done, fail) => {
    const timeout = setTimeout(() => fail(new Error('独立 Xvfb 启动超时')), 10_000);
    xvfb.once('error', (error) => { clearTimeout(timeout); fail(error); });
    xvfb.stdout.once('data', (chunk) => { clearTimeout(timeout); done(`:${String(chunk).trim()}`); });
  });
  const launch = async (settings) => {
    const profile = await mkdtemp(join(tmpdir(), 'bcp-login-launch-'));
    if (settings) {
      await mkdir(join(profile, 'UltraGoDesktop'), { recursive: true });
      await writeFile(join(profile, 'UltraGoDesktop', 'settings.json'), JSON.stringify(settings));
    }
    const application = await _electron.launch({
      executablePath: desktopRequire('electron'), args: ['--no-sandbox', resolve('packages/desktop'), '--launch-at-login'],
      env: { ...process.env, DISPLAY: display, XDG_CONFIG_HOME: profile }, timeout: 30_000,
    });
    const samples = [];
    try {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        samples.push(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible())));
        await new Promise((done) => setTimeout(done, 100));
      }
    } finally {
      await application.evaluate(({ app }) => app.quit()).catch(() => {});
      await application.close().catch(() => {});
    }
    return samples;
  };
  const fresh = await launch();
  assert.equal(fresh.at(-1), true, '尚未完成准备的用户开机启动时必须看到窗口');
  const failed = await launch({ setupCompleted: true, browserId: 'fixture', modelMode: 'cloud' });
  assert.equal(failed.at(-1), true, '开机后恢复失败要弹出窗口');
  // Staying hidden while a restore succeeds needs real services and a database, so that rule is pinned in test/window-lifecycle.test.mjs.
  process.stdout.write('PASS login launch: first run shows the window; a completed profile shows the window when its restore fails (no database step).\n');
} finally { xvfb.kill(); }
