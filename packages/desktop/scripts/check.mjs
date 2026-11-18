import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
let failed = false;
for (const folder of ['src', 'ui', 'scripts']) {
  for (const name of readdirSync(join(root, folder))) {
    if (!/\.(mjs|cjs)$/.test(name)) continue;
    const result = spawnSync(process.execPath, ['--check', join(root, folder, name)], { stdio: 'inherit' });
    if (result.status !== 0) failed = true;
  }
}
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const resource of manifest.build.extraResources) {
  if (!existsSync(join(root, resource.from))) {
    process.stderr.write(`未准备打包资源：${resource.from}\n`);
    if (!process.argv.includes('--source')) failed = true;
  }
}
// An installed unpacked extension reloads itself after an upgrade only when its version moves with the client's.
// Source-only checks can run before the extension is rebuilt, so there it only warns.
const extensionManifest = join(root, '../extension/.output/chrome-mv3/manifest.json');
if (existsSync(extensionManifest)) {
  let extensionVersion;
  try { extensionVersion = JSON.parse(readFileSync(extensionManifest, 'utf8')).version; }
  catch (error) { extensionVersion = `无法读取（${error.message}）`; }
  if (extensionVersion !== manifest.version) {
    process.stderr.write(`随包扩展版本 ${extensionVersion} 与客户端版本 ${manifest.version} 不一致：请同步 packages/extension/wxt.config.ts 并重新构建扩展，否则升级后扩展不会自动重新加载。\n`);
    if (!process.argv.includes('--source')) failed = true;
  }
}
const template = JSON.parse(readFileSync(join(root, 'templates/desktop-readonly-demo.json'), 'utf8'));
if (!template.steps.every((step) => ['browser.newWindow', 'browser.readContent'].includes(step.action.method))) failed = true;
process.stdout.write(failed ? '桌面预检未通过。\n' : '桌面预检通过。\n');
process.exitCode = failed ? 1 : 0;
