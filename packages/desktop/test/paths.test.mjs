import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationPaths } from '../src/paths.mjs';

const resources = '/Applications/UltraGo.app/Contents/Resources';
const source = fileURLToPath(new URL('../', import.meta.url));

test('a Mac package runs its own host, Python and the Prisma engine built for its architecture', () => {
  const arm = applicationPaths('/data', resources, true, 'darwin', 'arm64');
  assert.equal(arm.native, join(resources, 'native/bcp-native-host'));
  assert.equal(arm.python, join(resources, 'runtime/python/bin/python3'));
  assert.equal(arm.engines, join(resources, 'prisma-engines'));
  assert.deepEqual(arm.engineFiles, { query: 'libquery_engine-darwin-arm64.dylib.node', schema: 'schema-engine-darwin-arm64' });
  assert.deepEqual(applicationPaths('/data', resources, true, 'darwin', 'x64').engineFiles, { query: 'libquery_engine-darwin.dylib.node', schema: 'schema-engine-darwin' });
});

test('from source on a Mac the staged pieces of that architecture are used and Prisma keeps its own engines', () => {
  const paths = applicationPaths('/data', '/ignored', false, 'darwin', 'x64');
  assert.equal(paths.native, join(source, 'native/bin/darwin-x64/bcp-native-host'));
  assert.equal(paths.python, join(source, 'native/bin/darwin-x64/python/bin/python3'));
  assert.equal(paths.engineFiles, null);
});

test('Windows keeps its layout and engine override; other systems get no override', () => {
  const windows = applicationPaths('C:/data', 'C:/UltraGo/resources', true, 'win32', 'x64');
  assert.equal(windows.native, join('C:/UltraGo/resources', 'native/bcp-native-host.exe'));
  assert.equal(windows.python, join('C:/UltraGo/resources', 'runtime/python/python.exe'));
  assert.deepEqual(windows.engineFiles, { query: 'query_engine-windows.dll.node', schema: 'schema-engine-windows.exe' });
  assert.equal(applicationPaths('/data', '/r', false, 'linux', 'x64').engineFiles, null);
});
