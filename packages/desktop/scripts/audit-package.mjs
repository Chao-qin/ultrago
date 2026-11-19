import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { access, constants, readdir, stat, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const { listPackage, extractFile } = builderRequire('@electron/asar');
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const { NtExecutable, NtExecutableResource, Resource, Data } = libraryRequire('resedit');
/** Compared by digest: assert.deepEqual on a multi-megabyte Buffer diffs it byte by byte, so one wrong file buries
 *  the message and can exhaust memory before it prints anything. */
const sameBytes = (actual, expected, message) =>
  assert.equal(createHash('sha256').update(actual).digest('hex'), createHash('sha256').update(expected).digest('hex'), message);
/** 64-bit little-endian Mach-O (both Mac builds): where the load commands end and where the signature begins. */
function machBounds(buffer) {
  if (buffer.length < 32 || buffer.readUInt32LE(0) !== 0xfeedfacf) return null;
  const start = 32 + buffer.readUInt32LE(20);
  for (let offset = 32; offset + 8 <= start;) {
    const command = buffer.readUInt32LE(offset);
    const size = buffer.readUInt32LE(offset + 4);
    if (size < 8) return null;
    if (command === 0x1d) return { code: start, signature: buffer.readUInt32LE(offset + 8) };
    offset += size;
  }
  return { code: start, signature: buffer.length };
}
// A Windows unpacked folder (default) or a Mac UltraGo.app followed by its architecture (arm64 | x64).
const root = resolve(process.argv[2] || 'release/win-unpacked');
const mac = root.endsWith('.app');
const arch = process.argv[3] || 'x64';
const engine = arch === 'arm64' ? 'darwin-arm64' : 'darwin';
const resources = mac ? join(root, 'Contents/Resources') : join(root, 'resources');
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
const shared = [
  'extension/manifest.json', 'mcp-entry.cjs', 'prisma/schema.prisma', 'console-web/index.html', 'templates/desktop-readonly-demo.json',
  'branding/app-icon.png', 'templates/baidu-hot-search.json', 'templates/1688-offer-snatch.json', 'contracts/raw-1688-offer@2.json',
  'runtime/python/runtime-manifest.json',
];
const own = mac ? [
  'native/bcp-native-host', `prisma-engines/libquery_engine-${engine}.dylib.node`, `prisma-engines/schema-engine-${engine}`,
  'runtime/python/bin/python3', 'runtime/python/lib/python3.11/site-packages/PIL/__init__.py',
  'runtime/python/lib/python3.11/site-packages/openpyxl/__init__.py',
] : [
  'native/bcp-native-host.exe', 'prisma-engines/query_engine-windows.dll.node', 'prisma-engines/schema-engine-windows.exe',
  'runtime/python/python.exe', 'runtime/python/python311.dll', 'runtime/python/vcruntime140.dll',
  'runtime/python/Lib/site-packages/PIL/__init__.py', 'runtime/python/Lib/site-packages/openpyxl/__init__.py',
];
// stat follows symlinks, so the Mac Python's bin/python3 → python3.11 link counts as the file it points to.
for (const file of [...shared, ...own]) assert.ok((await stat(join(resources, file))).isFile(), `安装包缺少资源 ${file}`);
if (mac) {
  // Chrome and the assistants start these directly, so they must stay executable inside the bundle.
  for (const file of ['../MacOS/UltraGo', 'native/bcp-native-host', 'runtime/python/bin/python3', `prisma-engines/schema-engine-${engine}`]) {
    await access(join(resources, file), constants.X_OK).catch(() => assert.fail(`安装包内不可执行：${file}`));
  }
  const plist = await readFile(join(root, 'Contents/Info.plist'), 'utf8');
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>com\.ultrago\.desktop<\/string>/, '应用标识不是 com.ultrago.desktop');
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>UltraGo<\/string>/, '连接宿主按 Contents/MacOS/UltraGo 启动客户端');
  const manifest = JSON.parse(await readFile(join(resources, 'runtime/python/runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.platform, `macos-${arch}`, `随包 Python 不是 ${arch} 版本`);
} else {
  const executables = (await readdir(root)).filter((name) => name.endsWith('.exe'));
  // The native host's MCP launcher starts the client by this name (native/mcp.go).
  assert.deepEqual(executables, ['UltraGo.exe']);
  const executable = NtExecutable.from(await readFile(join(root, executables[0])));
  const entries = NtExecutableResource.from(executable).entries;
  const group = Resource.IconGroupEntry.fromEntries(entries).find((item) => item.id === 1);
  assert.ok(group, '主程序缺少应用图标');
  const expected = Data.IconFile.from(await readFile(join(dirname(root), '.icon-ico/icon.ico')));
  const iconHash = (item) => createHash('sha256').update(Buffer.from(item.isIcon() ? item.generate() : item.bin)).digest('hex');
  assert.deepEqual(group.getIconItemsFromEntries(entries).map(iconHash), expected.icons.map((item) => iconHash(item.data)), '主程序中的图标与品牌 ICO 不一致');
  const version = Resource.VersionInfo.fromEntries(entries)[0];
  assert.ok(version);
  assert.equal(version.getStringValues(version.getAllLanguagesForStringValues()[0]).ProductName, 'UltraGo');
}
const iconSource = await readFile(new URL('../ui/app-icon.png', import.meta.url));
sameBytes(await readFile(new URL('../build/app-icon.png', import.meta.url)), iconSource, '安装器与页面图标源不一致');
sameBytes(await readFile(join(resources, 'branding/app-icon.png')), iconSource, '窗口图标未更新');
for (const file of ['src/main.mjs', 'src/shell-controls.mjs', 'src/shell-preload.cjs', 'src/agent-setup.mjs', 'src/coordinator.mjs', 'src/supervisor.mjs', 'src/log-redaction.mjs', 'src/paths.mjs', 'ui/index.html', 'ui/setup.mjs', 'ui/setup.css', 'ui/shell.html', 'ui/shell.mjs', 'ui/shell.css', 'ui/app-icon.png']) {
  sameBytes(extractFile(join(resources, 'app.asar'), file), await readFile(new URL(`../${file}`, import.meta.url)), `包内文件不是当前版本：${file}`);
}
sameBytes(await readFile(join(resources, 'templates/desktop-readonly-demo.json')), await readFile(new URL('../templates/desktop-readonly-demo.json', import.meta.url)), '包内示例模板未更新');
sameBytes(await readFile(join(resources, 'console-web/index.html')), await readFile(new URL('../../console/dist-web/index.html', import.meta.url)), '包内工作台页面未更新');
for (const name of ['baidu-hot-search', '1688-offer-snatch']) sameBytes(await readFile(join(resources, 'templates', `${name}.json`)), await readFile(new URL(`../../../resource/playbooks/${name}.json`, import.meta.url)), `包内模板未更新：${name}`);
sameBytes(await readFile(join(resources, 'contracts/raw-1688-offer@2.json')), await readFile(new URL('../../../.claude/skills/product-preprocess/raw-1688-offer.schema.json', import.meta.url)), '包内1688出参契约未更新');
for (const name of ['manifest.json', 'background.js', 'sidepanel.html']) sameBytes(await readFile(join(resources, 'extension', name)), await readFile(new URL(`../../extension/.output/chrome-mv3/${name}`, import.meta.url)), `包内扩展未更新：${name}`);
for (const folder of ['chunks', 'assets']) for (const name of await readdir(new URL(`../../extension/.output/chrome-mv3/${folder}`, import.meta.url))) sameBytes(await readFile(join(resources, 'extension', folder, name)), await readFile(new URL(`../../extension/.output/chrome-mv3/${folder}/${name}`, import.meta.url)), `包内扩展资源未更新：${name}`);
for (const name of ['desktop-books', 'local-actions', 'delivery-executor', 'browser-read-dump', 'browser-mcp-tools-capture']) sameBytes(extractFile(join(resources, 'app.asar'), `node_modules/@bcp/backend/dist/${name}.js`), await readFile(new URL(`../../backend/dist/${name}.js`, import.meta.url)), `包内后端模块未更新：${name}`);
sameBytes(extractFile(join(resources, 'app.asar'), 'src/floating-position.mjs'), await readFile(new URL('../src/floating-position.mjs', import.meta.url)), '包内浮动按钮定位逻辑未更新');
sameBytes(extractFile(join(resources, 'app.asar'), 'src/native-registration.mjs'), await readFile(new URL('../src/native-registration.mjs', import.meta.url)), '包内自动连接注册逻辑未更新');
for (const name of ['mcp-bridge.mjs', 'agent-connections.mjs']) sameBytes(extractFile(join(resources, 'app.asar'), `src/${name}`), await readFile(new URL(`../src/${name}`, import.meta.url)), `包内 MCP 连接逻辑未更新：${name}`);
sameBytes(await readFile(join(resources, 'mcp-entry.cjs')), await readFile(new URL('../src/mcp-entry.cjs', import.meta.url)), '包外 Node 连接入口未更新');
const host = mac ? ['native/bcp-native-host', `../native/bin/darwin-${arch}/bcp-native-host`] : ['native/bcp-native-host.exe', '../native/bin/bcp-native-host.exe'];
const packagedHost = await readFile(join(resources, host[0]));
if (mac) {
  // electron-builder signs every nested Mach-O it packs (ad-hoc when there is no Developer ID), and codesign rewrites
  // the load commands and appends its own signature, so the packaged host is never byte-identical to the build
  // output. What still has to hold: the program itself is the one that was built, and its signature verifies.
  const source = await readFile(new URL(host[1], import.meta.url));
  const bounds = machBounds(packagedHost);
  assert.ok(bounds && bounds.signature > bounds.code && bounds.signature <= packagedHost.length, '包内原生宿主不是可识别的 Mach-O 程序');
  sameBytes(packagedHost.subarray(bounds.code, bounds.signature), source.subarray(bounds.code, bounds.signature), '包内原生宿主与构建产物不是同一份程序');
  const verify = spawnSync('codesign', ['--verify', '--strict', join(resources, host[0])], { encoding: 'utf8' });
  assert.equal(verify.status, 0, `包内原生宿主签名校验失败：${(verify.stderr || verify.stdout || verify.error?.message || '').trim()}`);
} else sameBytes(packagedHost, await readFile(new URL(host[1], import.meta.url)), '包内原生宿主与 MCP 启动器未更新');
for (const name of ['delivery-executor', 'delivery-ingest.service']) sameBytes(extractFile(join(resources, 'app.asar'), `node_modules/@bcp/console/dist/runs/${name}.js`), await readFile(new URL(`../../console/dist/runs/${name}.js`, import.meta.url)), `包内工作台模块未更新：${name}`);
sameBytes(extractFile(join(resources, 'app.asar'), 'node_modules/@bcp/console/dist/flows/flow-runner.service.js'), await readFile(new URL('../../console/dist/flows/flow-runner.service.js', import.meta.url)), '包内脚本执行器不是当前编译版本');
process.stdout.write(mac
  ? `macOS ${arch} 包内容检查通过：${files.length} 个归档路径，运行资源齐全且可执行，应用标识正确。\n`
  : `Windows x64 包内容检查通过：${files.length} 个归档路径，运行资源齐全，主程序品牌图标和产品信息正确。\n`);
