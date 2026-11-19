import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL('../', import.meta.url));
const builder = require.resolve('electron-builder/cli.js');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: desktop, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 构建失败（${result.status ?? result.signal}）`);
}

try {
  // dmg and code signing need macOS tools; electron-builder cannot produce them elsewhere.
  if (process.platform !== 'darwin') throw new Error('macOS 安装包只能在 Mac 上构建。');
  // A Developer ID named by CSC_NAME (keychain) or CSC_LINK (certificate file) signs normally. Without one the app
  // is signed ad hoc: Apple silicon refuses to run an unsigned app, and ad-hoc signing cannot use the hardened
  // runtime without extra entitlements. Downloaded copies then need right-click → Open the first time.
  const adHoc = !process.env.CSC_LINK && !process.env.CSC_NAME;
  run(process.execPath, [builder, '--mac', 'dmg', 'zip', '--arm64', '--x64', '--publish', 'never',
    ...(adHoc ? ['-c.mac.identity=-', '-c.mac.hardenedRuntime=false'] : [])]);
  for (const [folder, arch] of [['mac-arm64', 'arm64'], ['mac', 'x64']]) {
    run(process.execPath, [join(desktop, 'scripts/audit-package.mjs'), join(desktop, 'release', folder, 'UltraGo.app'), arch]);
  }
  run(process.execPath, [join(desktop, 'scripts/audit-runtime.mjs'), join(desktop, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'UltraGo.app')]);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
