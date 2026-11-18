import { createRequire } from 'node:module';
import { readdir, stat, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const { listPackage, extractFile } = builderRequire('@electron/asar');
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const { NtExecutable, NtExecutableResource, Resource, Data } = libraryRequire('resedit');
const root = resolve(process.argv[2] || 'release/win-unpacked');
const resources = join(root, 'resources');
const files = listPackage(join(resources, 'app.asar'));
const required = [
  '/src/main.mjs', '/src/shell-controls.mjs', '/src/shell-preload.cjs', '/ui/index.html', '/ui/app-icon.png', '/ui/shell.html',
  '/node_modules/@bcp/backend/dist/index.js',
  '/node_modules/@bcp/console/dist/main.js',
  '/node_modules/@bcp/llm/dist/gateway.js',
  '/node_modules/.prisma/client/index.js',
  '/node_modules/.prisma/client/schema.prisma',
  '/node_modules/dotenv/package.json',
  '/node_modules/react/package.json', '/node_modules/react-dom/package.json',
  '/node_modules/scheduler/package.json',
];
for (const file of required) assert.ok(files.includes(file), `安装包缺少 ${file}`);
const forbidden = /(^|\/)\.env[^/]*$|\/(\.opencode-home|\.cache|\.venv|\.git)\/|\/(channels|keys)\.json$|\/resource\/|\/reports\/|\.db(?:-|\.|$)|\/node_modules\/@bcp\/weclaw\/config\//;
assert.deepEqual(files.filter((file) => forbidden.test(file)), [], '安装包包含开发数据或敏感配置');
for (const file of [
  'extension/manifest.json', 'native/bcp-native-host.exe', 'mcp-entry.cjs',
  'prisma-engines/query_engine-windows.dll.node', 'prisma-engines/schema-engine-windows.exe',
  'prisma/schema.prisma', 'console-web/index.html', 'templates/desktop-readonly-demo.json',
  'branding/app-icon.png',
  'templates/baidu-hot-search.json', 'templates/1688-offer-snatch.json', 'contracts/raw-1688-offer@2.json',
  'runtime/python/python.exe', 'runtime/python/python311.dll',
  'runtime/python/vcruntime140.dll', 'runtime/python/runtime-manifest.json',
  'runtime/python/Lib/site-packages/PIL/__init__.py',
  'runtime/python/Lib/site-packages/openpyxl/__init__.py',
]) assert.ok((await stat(join(resources, file))).isFile(), `安装包缺少资源 ${file}`);
const executables = (await readdir(root)).filter((name) => name.endsWith('.exe'));
assert.deepEqual(executables, ['UltraGo Internal.exe']);
const executable = NtExecutable.from(await readFile(join(root, executables[0])));
const entries = NtExecutableResource.from(executable).entries;
const group = Resource.IconGroupEntry.fromEntries(entries).find((item) => item.id === 1);
assert.ok(group, '主程序缺少应用图标');
const expected = Data.IconFile.from(await readFile(join(dirname(root), '.icon-ico/icon.ico')));
const iconHash = (item) => createHash('sha256').update(Buffer.from(item.isIcon() ? item.generate() : item.bin)).digest('hex');
assert.deepEqual(group.getIconItemsFromEntries(entries).map(iconHash), expected.icons.map((item) => iconHash(item.data)), '主程序中的图标与品牌 ICO 不一致');
const version = Resource.VersionInfo.fromEntries(entries)[0];
assert.ok(version);
assert.equal(version.getStringValues(version.getAllLanguagesForStringValues()[0]).ProductName, 'UltraGo Internal');
const iconSource = await readFile(new URL('../ui/app-icon.png', import.meta.url));
assert.deepEqual(await readFile(new URL('../build/app-icon.png', import.meta.url)), iconSource, '安装器与页面图标源不一致');
assert.deepEqual(await readFile(join(resources, 'branding/app-icon.png')), iconSource, '窗口图标未更新');
for (const file of ['src/main.mjs', 'src/shell-controls.mjs', 'src/shell-preload.cjs', 'src/agent-setup.mjs', 'src/coordinator.mjs', 'src/supervisor.mjs', 'src/log-redaction.mjs', 'src/paths.mjs', 'ui/index.html', 'ui/setup.mjs', 'ui/setup.css', 'ui/shell.html', 'ui/shell.mjs', 'ui/shell.css', 'ui/app-icon.png']) {
  assert.deepEqual(extractFile(join(resources, 'app.asar'), file), await readFile(new URL(`../${file}`, import.meta.url)), `包内文件不是当前版本：${file}`);
}
assert.deepEqual(await readFile(join(resources, 'templates/desktop-readonly-demo.json')), await readFile(new URL('../templates/desktop-readonly-demo.json', import.meta.url)), '包内示例模板未更新');
assert.deepEqual(await readFile(join(resources, 'console-web/index.html')), await readFile(new URL('../../console/dist-web/index.html', import.meta.url)), '包内工作台页面未更新');
for (const name of ['baidu-hot-search', '1688-offer-snatch']) assert.deepEqual(await readFile(join(resources, 'templates', `${name}.json`)), await readFile(new URL(`../../../resource/playbooks/${name}.json`, import.meta.url)), `包内模板未更新：${name}`);
assert.deepEqual(await readFile(join(resources, 'contracts/raw-1688-offer@2.json')), await readFile(new URL('../../../.claude/skills/product-preprocess/raw-1688-offer.schema.json', import.meta.url)), '包内1688出参契约未更新');
for (const name of ['manifest.json', 'background.js', 'sidepanel.html']) assert.deepEqual(await readFile(join(resources, 'extension', name)), await readFile(new URL(`../../extension/.output/chrome-mv3/${name}`, import.meta.url)), `包内扩展未更新：${name}`);
for (const folder of ['chunks', 'assets']) for (const name of await readdir(new URL(`../../extension/.output/chrome-mv3/${folder}`, import.meta.url))) assert.deepEqual(await readFile(join(resources, 'extension', folder, name)), await readFile(new URL(`../../extension/.output/chrome-mv3/${folder}/${name}`, import.meta.url)), `包内扩展资源未更新：${name}`);
for (const name of ['desktop-books', 'local-actions', 'delivery-executor', 'browser-read-dump', 'browser-mcp-tools-capture']) assert.deepEqual(extractFile(join(resources, 'app.asar'), `node_modules/@bcp/backend/dist/${name}.js`), await readFile(new URL(`../../backend/dist/${name}.js`, import.meta.url)), `包内后端模块未更新：${name}`);
assert.deepEqual(extractFile(join(resources, 'app.asar'), 'src/floating-position.mjs'), await readFile(new URL('../src/floating-position.mjs', import.meta.url)), '包内浮动按钮定位逻辑未更新');
assert.deepEqual(extractFile(join(resources, 'app.asar'), 'src/native-registration.mjs'), await readFile(new URL('../src/native-registration.mjs', import.meta.url)), '包内自动连接注册逻辑未更新');
for (const name of ['mcp-bridge.mjs', 'agent-connections.mjs']) assert.deepEqual(extractFile(join(resources, 'app.asar'), `src/${name}`), await readFile(new URL(`../src/${name}`, import.meta.url)), `包内 MCP 连接逻辑未更新：${name}`);
assert.deepEqual(await readFile(join(resources, 'mcp-entry.cjs')), await readFile(new URL('../src/mcp-entry.cjs', import.meta.url)), '包外 Node 连接入口未更新');
assert.deepEqual(await readFile(join(resources, 'native/bcp-native-host.exe')), await readFile(new URL('../native/bin/bcp-native-host.exe', import.meta.url)), '包内原生宿主与 MCP 启动器未更新');
for (const name of ['delivery-executor', 'delivery-ingest.service']) assert.deepEqual(extractFile(join(resources, 'app.asar'), `node_modules/@bcp/console/dist/runs/${name}.js`), await readFile(new URL(`../../console/dist/runs/${name}.js`, import.meta.url)), `包内工作台模块未更新：${name}`);
assert.deepEqual(extractFile(join(resources, 'app.asar'), 'node_modules/@bcp/console/dist/flows/flow-runner.service.js'), await readFile(new URL('../../console/dist/flows/flow-runner.service.js', import.meta.url)), '包内脚本执行器不是当前编译版本');
process.stdout.write(`Windows x64 包内容检查通过：${files.length} 个归档路径，运行资源齐全，主程序品牌图标和产品信息正确。\n`);
