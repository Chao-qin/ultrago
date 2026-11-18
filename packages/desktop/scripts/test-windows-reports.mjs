import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';

if (process.platform !== 'win32') throw new Error('请通过 Windows 安装包自带的 Electron Node 运行时执行此检查。');
const previous = process.cwd();
const directory = await mkdtemp(join(tmpdir(), 'bcp-windows-report-'));
try {
  process.chdir(directory);
  const root = new URL('../release/win-unpacked/resources/app.asar/node_modules/@bcp/backend/dist/', import.meta.url);
  const { writeLocalFile } = await import(new URL('local-actions.js', root));
  const { extractArtifacts } = await import(new URL('delivery-executor.js', root));
  const report = await writeLocalFile('baidu-hot-search-2026-11-09-15-40-15-fd60c8a6.md', '# 三榜报告');
  const product = await writeLocalFile('商品\\1688.json', '{"商品":"示例"}');
  assert.equal(await readFile(report, 'utf8'), '# 三榜报告');
  assert.equal(await readFile(product, 'utf8'), '{"商品":"示例"}');
  await assert.rejects(writeLocalFile('商品\\1688.json', 'changed', { overwrite: 'error' }), /already exists/);
  const renamed = await writeLocalFile('商品\\1688.json', 'renamed', { overwrite: 'rename' });
  assert.notEqual(renamed, product);
  assert.equal(await readFile(product, 'utf8'), '{"商品":"示例"}');
  const differentDrive = parse(directory).root.toUpperCase().startsWith('D:') ? 'C:' : 'D:';
  for (const file of ['..\\outside.md', '../reports-other/outside.md', `${differentDrive}\\outside.md`, '\\\\server\\share\\outside.md'])
    await assert.rejects(writeLocalFile(file, 'blocked'), /escapes the reports/);
  const artifacts = extractArtifacts([report, product, `${differentDrive}\\outside.md`].map((path, index) => ({ index, goal: 'fixture', method: 'local.writeFile', value: { path } })));
  assert.deepEqual(artifacts.map((item) => item.path), ['baidu-hot-search-2026-11-09-15-40-15-fd60c8a6.md', '商品/1688.json']);
  process.stdout.write('PASS actual Windows packaged runtime: Markdown/JSON writes, Chinese backslash paths, overwrite modes, traversal/drive/UNC rejection and artifact ownership; no database or browser task\n');
} finally {
  process.chdir(previous);
  await rm(directory, { recursive: true, force: true });
}
