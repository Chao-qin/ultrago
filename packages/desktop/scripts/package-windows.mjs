import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL('../', import.meta.url));
const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const builder = require.resolve('electron-builder/cli.js');
const image = 'electronuserland/builder@sha256:f3a8d451994c881d0972e7b1846ee4d4fdc15eb41fc6b1f350b38cbf99ca90fe';
function run(command, args) {
  const result = spawnSync(command, args, { cwd: desktop, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 构建失败（${result.status ?? result.signal}）`);
}

try {
  if (process.platform === 'win32') {
    run(process.execPath, [builder, '--win', 'nsis', '--x64', '--publish', 'never']);
  } else if (process.platform === 'linux') {
    run(process.execPath, [builder, '--win', '--x64', '--dir', '--publish', 'never']);
    run(process.execPath, [join(desktop, 'scripts/audit-package.mjs')]);
    run(process.execPath, [join(desktop, 'scripts/audit-runtime.mjs')]);
    const inspection = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
    if (inspection.error) throw new Error(`生成安装器需要 Docker：${inspection.error.message}`);
    if (inspection.status !== 0) run('docker', ['pull', image]);
    const cache = process.env.ELECTRON_BUILDER_CACHE || join(homedir(), '.cache/electron-builder');
    mkdirSync(cache, { recursive: true });
    run('docker', [
      'run', '--rm', '--network', 'none',
      '--mount', `type=bind,source=${workspace},target=${workspace},readonly`,
      '--mount', `type=bind,source=${join(desktop, 'release')},target=${join(desktop, 'release')}`,
      '--mount', `type=bind,source=${cache},target=/root/.cache/electron-builder`,
      '--workdir', desktop, '--entrypoint', 'node', image, builder,
      '--win', 'nsis', '--x64', '--publish', 'never', '--prepackaged', 'release/win-unpacked',
    ]);
  } else throw new Error('此内测构建入口支持 Windows 或 Linux 维护机。');
  run(process.execPath, [join(desktop, 'scripts/audit-package.mjs')]);
  if (process.platform === 'win32') run(process.execPath, [join(desktop, 'scripts/audit-runtime.mjs')]);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
