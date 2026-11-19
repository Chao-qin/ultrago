import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('workspace build regenerates the Prisma client before compiling the console', async () => {
  const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const { scripts: consoleScripts } = JSON.parse(await readFile(new URL('../../console/package.json', import.meta.url), 'utf8'));
  assert.match(scripts['workspace:build'], /--filter @bcp\/console build$/);
  assert.match(consoleScripts.build, /^pnpm run prisma:generate && /);
});

test('each system packs only its own native pieces; a Mac package picks them by architecture', async () => {
  const { build } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const native = /native\/bin\/(bcp-native-host|prisma$|python$|darwin-)/;
  assert.deepEqual(build.extraResources.filter((resource) => native.test(resource.from)), [], '共享资源里不放某个系统专用的文件');
  assert.deepEqual(build.win.extraResources.map((resource) => resource.from), ['native/bin/bcp-native-host.exe', 'native/bin/prisma', 'native/bin/python']);
  assert.deepEqual(build.mac.extraResources.map((resource) => [resource.from, resource.to]), [
    ['native/bin/darwin-${arch}/bcp-native-host', 'native/bcp-native-host'],
    ['native/bin/darwin-${arch}/prisma', 'prisma-engines'],
    ['native/bin/darwin-${arch}/python', 'runtime/python'],
  ]);
  assert.deepEqual(build.mac.target, [{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }]);
});

test('the preflight checks the chosen system\'s resources, expanding the Mac architecture folders', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const check = (flag) => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check.mjs', import.meta.url)), '--source', ...flag], { encoding: 'utf8' }).stderr;
  const mac = check(['--mac']);
  for (const arch of ['arm64', 'x64']) for (const piece of ['bcp-native-host', 'prisma', 'python']) {
    if (!mac.includes(`未准备打包资源：native/bin/darwin-${arch}/${piece}`)) {
      // Staged already on this machine: the check passing for it is the same outcome.
      const { existsSync } = await import('node:fs');
      assert.ok(existsSync(new URL(`../native/bin/darwin-${arch}/${piece}`, import.meta.url)), `${arch} ${piece} 未被检查`);
    }
  }
  assert.doesNotMatch(mac, /bcp-native-host\.exe/);
  assert.doesNotMatch(check([]), /darwin-/);
});
