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
