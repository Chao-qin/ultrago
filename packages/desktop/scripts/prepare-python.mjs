import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const staging = fileURLToPath(new URL('../native/bin/', import.meta.url));
const version = (await readFile(join(workspace, '.python-version'), 'utf8')).trim();
if (version !== '3.11.15') throw new Error('Python 版本已变化，请先更新经过校验的发行源。');
const release = 'https://releases.astral.sh/github/python-build-standalone/releases/download/20260325';
// Digests from that release's SHA256SUMS. `node prepare-python.mjs` stages Windows x64; `mac` stages both Mac builds.
const builds = process.argv[2] === 'mac' ? [
  { label: 'macos-arm64', triple: 'aarch64-apple-darwin', folder: 'darwin-arm64/python', site: 'lib/python3.11/site-packages', digest: '9d50cd14269d1ea8601ab279ae0175bdaad7cb151700f53f201a1ea7d0dc53b7' },
  { label: 'macos-x64', triple: 'x86_64-apple-darwin', folder: 'darwin-x64/python', site: 'lib/python3.11/site-packages', digest: '0982c85799ccb8c0dd455b8812d75e9cc530bcb618ff66bcd74940c527ccda81' },
] : [
  { label: 'windows-x64', triple: 'x86_64-pc-windows-msvc', folder: 'python', site: 'Lib/site-packages', digest: 'ec6d6439f700863e2ea740c4e7b80d70cbc3a605a8d3d8b9b817626317ef2621' },
];
function run(command, args) {
  const result = spawnSync(command, args, { cwd: workspace, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 准备失败：${result.status}`);
}
const requirements = join(staging, 'python-requirements.txt');
await mkdir(staging, { recursive: true });
run('uv', ['export', '--frozen', '--no-dev', '--no-emit-project', '--output-file', requirements, '--quiet']);
for (const { label, triple, folder, site, digest } of builds) {
  const url = `${release}/cpython-3.11.15%2B20260325-${triple}-install_only_stripped.tar.gz`;
  const output = join(staging, folder);
  const archive = join(staging, `cpython-${label}.tar.gz`);
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
  run('tar', ['-xzf', archive, '-C', output, '--strip-components=1']);
  run('uv', ['pip', 'install', '--python-version', '3.11', '--python-platform', triple, '--target', join(output, site), '--only-binary', ':all:', '--require-hashes', '--no-deps', '-r', requirements]);
  await writeFile(join(output, 'runtime-manifest.json'), JSON.stringify({ version, platform: label, url, sha256: digest, dependencies: await readFile(requirements, 'utf8') }, null, 2));
  process.stdout.write(`${label} Python ${version} 与锁定依赖已准备。\n`);
}
