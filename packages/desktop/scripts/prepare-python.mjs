import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const staging = fileURLToPath(new URL('../native/bin/', import.meta.url));
const output = join(staging, 'python');
const version = (await readFile(join(workspace, '.python-version'), 'utf8')).trim();
if (version !== '3.11.15') throw new Error('Python 版本已变化，请先更新经过校验的 Windows 发行源。');
const url = 'https://releases.astral.sh/github/python-build-standalone/releases/download/20260325/cpython-3.11.15%2B20260325-x86_64-pc-windows-msvc-install_only_stripped.tar.gz';
const digest = 'ec6d6439f700863e2ea740c4e7b80d70cbc3a605a8d3d8b9b817626317ef2621';
const archive = join(staging, 'cpython-windows.tar.gz');
await mkdir(output, { recursive: true });
let bytes;
try { bytes = await readFile(archive); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== digest) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Python 下载失败：${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
}
if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Python 发行文件校验失败。');
await writeFile(archive, bytes);
function run(command, args) {
  const result = spawnSync(command, args, { cwd: workspace, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 准备失败：${result.status}`);
}
run('tar', ['-xzf', archive, '-C', output, '--strip-components=1']);
const requirements = join(staging, 'python-requirements.txt');
run('uv', ['export', '--frozen', '--no-dev', '--no-emit-project', '--output-file', requirements, '--quiet']);
run('uv', ['pip', 'install', '--python-version', '3.11', '--python-platform', 'x86_64-pc-windows-msvc', '--target', join(output, 'Lib/site-packages'), '--only-binary', ':all:', '--require-hashes', '--no-deps', '-r', requirements]);
await writeFile(join(output, 'runtime-manifest.json'), JSON.stringify({ version, platform: 'windows-x64', url, sha256: digest, dependencies: await readFile(requirements, 'utf8') }, null, 2));
process.stdout.write(`Windows Python ${version} 与锁定依赖已准备。\n`);
