import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_MODEL, detectOllama, findOllama, ollamaBaseUrl, pullModel, startOllama } from '../src/local-model.mjs';

const json = (value) => ({ ok: true, json: async () => value });
/** A fake Ollama: nothing here reaches the network or downloads anything. */
function fakeOllama({ running = true, models = [] } = {}) {
  return async (url) => {
    if (!running) throw new Error('ECONNREFUSED');
    if (url.endsWith('/api/version')) return json({ version: '0.12.0' });
    if (url.endsWith('/api/tags')) return json({ models: models.map((name) => ({ name })) });
    throw new Error(`unexpected ${url}`);
  };
}
const stream = (...chunks) => ({ ok: true, status: 200, body: (async function* () { for (const chunk of chunks) yield new TextEncoder().encode(chunk); })() });

test('Ollama is reached on its default address unless OLLAMA_HOST points elsewhere on this computer', () => {
  assert.equal(ollamaBaseUrl({}), 'http://127.0.0.1:11434');
  assert.equal(ollamaBaseUrl({ OLLAMA_HOST: '127.0.0.1:11500' }), 'http://127.0.0.1:11500');
  assert.equal(ollamaBaseUrl({ OLLAMA_HOST: 'http://localhost' }), 'http://localhost:11434');
  assert.equal(ollamaBaseUrl({ OLLAMA_HOST: '0.0.0.0:11500' }), 'http://127.0.0.1:11500', '监听全部网卡时从本机回环访问');
  assert.equal(ollamaBaseUrl({ OLLAMA_HOST: 'gpu-box.lan:11434' }), 'http://127.0.0.1:11434', '截图不能发到别的机器');
});

test('an Ollama installed after the client started is found in its install folder, not only on PATH', async () => {
  const local = await mkdtemp(join(tmpdir(), 'bcp-ollama-'));
  const find = async () => null;
  assert.equal(await findOllama({ env: { LOCALAPPDATA: local }, platform: 'win32', find }), null);
  await mkdir(join(local, 'Programs', 'Ollama'), { recursive: true });
  await writeFile(join(local, 'Programs', 'Ollama', 'ollama.exe'), '');
  assert.equal(await findOllama({ env: { LOCALAPPDATA: local }, platform: 'win32', find }), join(local, 'Programs', 'Ollama', 'ollama.exe'));
  assert.equal(await findOllama({ env: {}, platform: 'win32', find: async () => 'C:\\bin\\ollama.exe' }), 'C:\\bin\\ollama.exe');
});

test('on macOS Ollama is found where Finder-launched apps cannot see it: /usr/local/bin, Homebrew and inside Ollama.app', async () => {
  const find = async () => null;
  const look = (...files) => ({ env: {}, find, home: '/Users/u', exists: async (file) => files.includes(file) });
  assert.equal(await findOllama({ ...look(), platform: 'darwin' }), null);
  assert.equal(await findOllama({ ...look('/opt/homebrew/bin/ollama'), platform: 'darwin' }), '/opt/homebrew/bin/ollama');
  assert.equal(await findOllama({ ...look('/Applications/Ollama.app/Contents/Resources/ollama'), platform: 'darwin' }), '/Applications/Ollama.app/Contents/Resources/ollama');
  assert.equal(await findOllama({ ...look('/Users/u/Applications/Ollama.app/Contents/Resources/ollama'), platform: 'darwin' }), '/Users/u/Applications/Ollama.app/Contents/Resources/ollama');
  assert.equal(await findOllama({ ...look('/usr/local/bin/ollama'), platform: 'linux' }), null, '其他系统只看 PATH');
});

test('detection tells apart not installed, installed but stopped, running without the model, and ready', async () => {
  const none = async () => null;
  const found = async () => '/usr/bin/ollama';
  assert.deepEqual(
    await detectOllama({ env: {}, platform: 'linux', find: none, fetch: fakeOllama({ running: false }) }),
    { baseUrl: 'http://127.0.0.1:11434', executable: '', installed: false, running: false, version: '', hasModel: false },
  );
  const stopped = await detectOllama({ env: {}, platform: 'linux', find: found, fetch: fakeOllama({ running: false }) });
  assert.equal(stopped.installed, true);
  assert.equal(stopped.running, false);
  const other = await detectOllama({ env: {}, platform: 'linux', find: found, fetch: fakeOllama({ models: ['llama3:8b', `${LOCAL_MODEL}-q8_0`] }) });
  assert.equal(other.running, true);
  assert.equal(other.hasModel, false, '名字相近的模型不算');
  const ready = await detectOllama({ env: {}, platform: 'linux', find: none, fetch: fakeOllama({ models: [LOCAL_MODEL] }) });
  assert.equal(ready.installed, true, '正在运行就说明已安装，哪怕 PATH 里找不到');
  assert.equal(ready.hasModel, true);
});

test('the download reports bytes across all layers, even when a line arrives split, and ends only on success', async () => {
  const seen = [];
  await pullModel({
    baseUrl: 'http://127.0.0.1:11434',
    fetch: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:11434/api/pull');
      assert.deepEqual(JSON.parse(init.body), { model: LOCAL_MODEL, stream: true });
      return stream(
        '{"status":"pulling manifest"}\n{"status":"pulling a","digest":"a","total":100,"comp',
        'leted":40}\n{"status":"pulling b","digest":"b","total":50,"completed":10}\n',
        '{"status":"pulling a","digest":"a","total":100,"completed":100}\n{"status":"success"}',
      );
    },
    onProgress: (progress) => seen.push(progress),
  });
  assert.deepEqual(seen.map(({ completed, total }) => [completed, total]), [[0, 0], [40, 100], [50, 150], [110, 150], [110, 150]]);
  await assert.rejects(pullModel({ baseUrl: 'http://x', fetch: async () => stream('{"error":"pull model manifest: file does not exist"}\n') }), /file does not exist/);
  await assert.rejects(pullModel({ baseUrl: 'http://x', fetch: async () => stream('{"status":"pulling a","digest":"a","total":9,"completed":1}\n') }), /中断/);
  await assert.rejects(pullModel({ baseUrl: 'http://x', fetch: async () => ({ ok: false, status: 500 }) }), /500/);
});

test('starting Ollama runs its own server detached, so it outlives the client like the Ollama tray app', () => {
  const calls = [];
  startOllama('C:\\Ollama\\ollama.exe', (file, args, options) => {
    calls.push({ file, args, options });
    return { on: () => {}, unref: () => calls.push('unref') };
  });
  assert.deepEqual(calls[0].args, ['serve']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[1], 'unref');
});
