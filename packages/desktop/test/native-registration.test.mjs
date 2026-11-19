import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_HOST, extensionId, macHostDirectory, registerNativeHost } from '../src/native-registration.mjs';

const key = Buffer.from('fixture public key').toString('base64');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bcp-native-'));
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ key }));
  await writeFile(join(root, 'host'), '');
  return { root, paths: { native: join(root, 'host'), extension: root, userData: root } };
}

test('on macOS the host manifest goes where Chrome reads a user\'s hosts, pointing at the bundled host', async () => {
  const { root, paths } = await fixture();
  const calls = [];
  await registerNativeHost(paths, { platform: 'darwin', home: root, run: async (...args) => calls.push(args) });
  const file = join(root, 'Library/Application Support/Google/Chrome/NativeMessagingHosts', `${NATIVE_HOST}.json`);
  assert.equal(join(macHostDirectory(root), `${NATIVE_HOST}.json`), file);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    name: NATIVE_HOST, description: 'UltraGo desktop connection', path: paths.native, type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId(key)}/`],
  });
  assert.equal(calls.length, 0, 'macOS 不碰注册表');
});

test('on Windows the manifest stays in the data folder and the registry points Chrome at it', async () => {
  const { root, paths } = await fixture();
  const calls = [];
  await registerNativeHost(paths, { platform: 'win32', home: root, run: async (...args) => calls.push(args) });
  assert.equal(calls[0][0], 'reg.exe');
  assert.deepEqual(calls[0][1].slice(0, 2), ['ADD', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST}`]);
  assert.equal(calls[0][1][calls[0][1].indexOf('/d') + 1], join(root, 'native-host.json'));
  assert.equal(JSON.parse(await readFile(join(root, 'native-host.json'), 'utf8')).path, paths.native);
  await assert.rejects(stat(macHostDirectory(root)));
});

test('other systems and a missing host binary are refused before anything is written', async () => {
  const { root, paths } = await fixture();
  await assert.rejects(registerNativeHost(paths, { platform: 'linux', home: root }), /Windows 和 macOS/);
  await assert.rejects(registerNativeHost({ ...paths, native: join(root, 'missing') }, { platform: 'darwin', home: root }), /ENOENT/);
  await assert.rejects(stat(macHostDirectory(root)));
});
