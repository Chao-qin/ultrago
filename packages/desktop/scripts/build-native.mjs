import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `node build-native.mjs` builds the Windows host; `mac` builds one per Mac architecture, named the way
// electron-builder's ${arch} macro picks them up (native/bin/darwin-arm64, native/bin/darwin-x64).
const builds = process.argv[2] === 'mac'
  ? [['darwin', 'arm64', 'darwin-arm64/bcp-native-host'], ['darwin', 'amd64', 'darwin-x64/bcp-native-host']]
  : [['windows', 'amd64', 'bcp-native-host.exe']];
const output = fileURLToPath(new URL('../native/bin/', import.meta.url));
const executable = process.platform !== 'win32' && existsSync('/usr/local/go/bin/go') ? '/usr/local/go/bin/go' : 'go';
for (const [goos, goarch, file] of builds) {
  mkdirSync(new URL(`../native/bin/${file}/..`, import.meta.url), { recursive: true });
  const result = spawnSync(executable, ['build', '-trimpath', '-o', `${output}${file}`, ...['host.go', 'mcp.go'].map((name) => fileURLToPath(new URL(`../native/${name}`, import.meta.url)))], {
    stdio: 'inherit', env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
  });
  if (result.error) process.stderr.write('构建连接宿主需要维护者安装 Go；最终用户不需要 Go。\n');
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
