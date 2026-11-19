import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
const ui = await readFile(new URL('../ui/setup.mjs', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
const start = main.indexOf('actions = {');
// The preload bridge forwards these names as they are; a button naming one the client does not implement just
// does nothing, which is exactly the kind of mistake the page cannot show.
const actions = new Set([...main.slice(start, main.indexOf('\n      };', start)).matchAll(/^ {8}(\w+):/gm)].map((match) => match[1]));

test('every action the setup page asks for exists in the client', () => {
  const used = new Set([...page.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1]));
  assert.ok(used.size > 10, '页面按钮没有被读到');
  for (const name of used) assert.ok(actions.has(name), `准备页调用了客户端没有的 action：${name}`);
});

test('the extension folder can be copied as well as opened', () => {
  // Chrome's “加载已解压的扩展程序” dialog asks for a folder path the user cannot paste from an opened Finder window.
  assert.match(page, /<button id="extension-copy">复制扩展目录<\/button>/, '复制按钮应是实心主按钮');
  assert.match(page, /<button id="extension-copy">[^<]*<\/button>[^<]*<button data-action="extensionFolder" class="secondary">/, '复制与打开并排');
  assert.match(page, /<small id="extension-copy-status" role="status"><\/small>/, '复制结果需要回显');
  assert.match(ui, /\$\('extension-copy'\)\.addEventListener\('click'/, '复制按钮没有接线');
  assert.ok(actions.has('copyExtensionFolder'), '客户端没有实现 copyExtensionFolder');
  assert.match(main, /clipboard\.writeText\(paths\.extension\)/, '没有把扩展目录写进剪贴板');
});
