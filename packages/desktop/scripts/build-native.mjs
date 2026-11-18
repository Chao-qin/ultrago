import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../native/bin/', import.meta.url));
mkdirSync(output, { recursive: true });
const executable = process.platform !== 'win32' && existsSync('/usr/local/go/bin/go') ? '/usr/local/go/bin/go' : 'go';
const result = spawnSync(executable, ['build', '-trimpath', '-o', `${output}bcp-native-host.exe`, ...['host.go', 'mcp.go'].map((name) => fileURLToPath(new URL(`../native/${name}`, import.meta.url)))], {
  stdio: 'inherit', env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
});
if (result.error) process.stderr.write('构建连接宿主需要维护者安装 Go；最终用户不需要 Go。\n');
process.exitCode = result.status ?? 1;
