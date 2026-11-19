import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { extractAll } = createRequire(require.resolve('electron-builder'))('@electron/asar');
const webRequire = createRequire(new URL('../../console/web/package.json', import.meta.url));
const { build } = createRequire(webRequire.resolve('vite'))('esbuild');
const root = resolve(process.argv[2] || 'release/win-unpacked');
const mac = root.endsWith('.app');
const archive = join(root, mac ? 'Contents/Resources/app.asar' : 'resources/app.asar');
const temporary = await mkdtemp(join(tmpdir(), 'bcp-packaged-runtime-'));
try {
  extractAll(archive, temporary);
  await cp(`${archive}.unpacked`, temporary, { recursive: true });
  const result = await build({
    entryPoints: ['@bcp/console/dist/main.js', '@bcp/backend/dist/index.js', '@bcp/llm/dist/gateway.js'].map((entry) => join(temporary, 'node_modules', entry)),
    absWorkingDir: temporary, outdir: join(temporary, 'audit'), bundle: true, write: false, platform: 'node', format: 'esm', metafile: true,
    logLevel: 'silent', external: ['electron', '*.node'],
    plugins: [{ name: 'unused-nest-integrations', setup(builder) {
      // Nest declares these integrations optional and loads them only through feature-specific factories.
      builder.onResolve({ filter: /^(class-validator|class-transformer|@nestjs\/(microservices|websockets)(\/.*)?)$/ }, (args) => {
        if (args.importer.startsWith(join(temporary, 'node_modules/@nestjs/'))) return { path: args.path, external: true };
      });
    } }],
  });
  for (const input of Object.keys(result.metafile.inputs)) assert.ok(resolve(temporary, input).startsWith(temporary + sep), `模块借用了安装包外的文件：${input}`);
  const runtime = mac && process.platform === 'darwin' ? join(root, 'Contents/MacOS/UltraGo')
    : process.platform === 'win32' ? join(root, 'UltraGo.exe') : require('electron');
  const moduleUrl = (relative) => pathToFileURL(join(archive, 'node_modules', relative)).href;
  const probe = `
    import assert from 'node:assert/strict';
    const sqlite = await import('node:sqlite');
    assert.equal(typeof sqlite.DatabaseSync, 'function');
    for (const url of ${JSON.stringify(['node-sqlite', 'sqlite-core', 'bff'].map((name) => moduleUrl(`@prisma/studio-core/dist/data/${name}/index.js`)))}) await import(url);
    const { runScriptProcess } = await import(${JSON.stringify(moduleUrl('@bcp/console/dist/flows/flow-runner.service.js'))});
    const result = await runScriptProcess({ source: 'return { ready: true };', language: 'ts', timeoutMs: 10000 }, {}, { input: null, output: null });
    assert.equal(result.ok, true, result.stderr || result.error);
    assert.equal(result.output.ready, true);
    process.stdout.write('PASS packaged Studio imports, built-in SQLite module and embedded TypeScript runtime; no database opened\\n');
  `;
  const child = spawnSync(runtime, ['--input-type=module', '--eval', probe], {
    cwd: temporary, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BCP_DESKTOP: '1', BCP_DATA_ROOT: temporary },
  });
  assert.equal(child.status, 0, `${child.error || ''}\n${child.stderr}\n${child.stdout}`);
  process.stdout.write(child.stdout);
  process.stdout.write(`实际安装包静态依赖检查通过：${Object.keys(result.metafile.inputs).length} 个模块；未执行服务入口。\n`);
} finally { await rm(temporary, { recursive: true, force: true }); }
