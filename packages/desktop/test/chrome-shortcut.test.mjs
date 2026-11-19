import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromeExecutable, chromeShortcutSpec, SHORTCUT_NAME } from '../src/chrome-shortcut.mjs';

const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files' };
const machineWide = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

test('找到已安装的 Chrome，快捷方式带上两个渲染参数', () => {
  const spec = chromeShortcutSpec({ env, desktopDir: 'C:\\Users\\u\\Desktop', exists: (p) => p === machineWide });
  assert.equal(spec.path, `C:\\Users\\u\\Desktop\\${SHORTCUT_NAME}`);
  assert.equal(spec.options.target, machineWide);
  assert.equal(spec.options.args, '--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows');
});

test('按用户级安装优先；没装 Chrome 时返回 null', () => {
  const perUser = 'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
  assert.equal(chromeExecutable(env, () => true), perUser);
  assert.equal(chromeShortcutSpec({ env, desktopDir: 'D', exists: () => false }), null);
});

test('macOS 生成一个桌面启动器：带渲染参数打开已安装的 Chrome，重复生成会覆盖', async () => {
  const { mkdtemp, mkdir, readFile, stat, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { MAC_LAUNCHER_NAME, macChromeLauncher, writeMacChromeLauncher } = await import('../src/chrome-shortcut.mjs');
  const home = await mkdtemp(join(tmpdir(), 'bcp-chrome-'));
  const chrome = join(home, 'Applications', 'Google Chrome.app');
  assert.equal(macChromeLauncher({ home, desktopDir: join(home, 'Desktop'), exists: () => false }), null);
  const spec = macChromeLauncher({ home, desktopDir: join(home, 'Desktop'), exists: (p) => p === chrome });
  assert.equal(spec.path, join(home, 'Desktop', MAC_LAUNCHER_NAME));
  await writeMacChromeLauncher(spec);
  const launcher = join(spec.path, 'Contents', 'MacOS', 'launcher');
  assert.equal(await readFile(launcher, 'utf8'), `#!/bin/sh\nexec /usr/bin/open -a '${chrome}' --args --disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows\n`);
  assert.equal((await stat(launcher)).mode & 0o777, 0o755);
  assert.match(await readFile(join(spec.path, 'Contents', 'Info.plist'), 'utf8'), /<key>CFBundleExecutable<\/key><string>launcher<\/string>/);
  await assert.rejects(stat(spec.icon.to), '没有 Chrome 图标时仍生成启动器');
  await mkdir(join(chrome, 'Contents', 'Resources'), { recursive: true });
  await writeFile(join(chrome, 'Contents', 'Resources', 'app.icns'), 'icon');
  await writeFile(launcher, 'stale', { mode: 0o600 });
  await writeMacChromeLauncher(spec);
  assert.equal((await stat(launcher)).mode & 0o777, 0o755, '覆盖已有文件时也恢复可执行权限');
  assert.equal(await readFile(spec.icon.to, 'utf8'), 'icon');
});

test('macOS 启动脚本对带单引号的 Chrome 路径正确转义', async () => {
  const { macChromeLauncher } = await import('../src/chrome-shortcut.mjs');
  const home = "/Users/o'neil";
  const spec = macChromeLauncher({ home, desktopDir: '/d', exists: (p) => p === "/Users/o'neil/Applications/Google Chrome.app" });
  assert.match(spec.files[1].content, /open -a '\/Users\/o'\\''neil\/Applications\/Google Chrome\.app' --args/);
});
