import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { findExecutable } from './agent-setup.mjs';

/** The small local model the client sets up: it reads screenshots, which is what CAPTCHA alerts need. */
export const LOCAL_MODEL = 'qwen3.5:4b';
export const OLLAMA_DOWNLOAD = 'https://ollama.com/download';
const DEFAULT_HOST = '127.0.0.1:11434';

/** Ollama's own address. OLLAMA_HOST is honoured only when it stays on this computer. */
export function ollamaBaseUrl(env = process.env) {
  const raw = (env.OLLAMA_HOST || '').trim();
  if (raw) {
    try {
      const url = new URL(/^https?:\/\//.test(raw) ? raw : `http://${raw}`);
      // Listening on every interface still includes this computer's loopback.
      const host = ['0.0.0.0', '[::]'].includes(url.hostname) ? '127.0.0.1' : url.hostname;
      if (['127.0.0.1', 'localhost', '[::1]'].includes(host)) return `http://${host}:${url.port || '11434'}`;
    } catch { /* fall back to the default address */ }
  }
  return `http://${DEFAULT_HOST}`;
}

/**
 * PATH alone misses Ollama in two common cases, so the install locations are checked as well. Windows: the
 * installer puts ollama.exe in %LOCALAPPDATA%\Programs\Ollama and adds it to the user PATH, which a client already
 * running at install time does not see. macOS: an app opened from Finder gets only the system PATH, without
 * /usr/local/bin or Homebrew's /opt/homebrew/bin, and the CLI itself lives inside Ollama.app.
 */
const isFile = async (file) => { try { return (await stat(file)).isFile(); } catch { return false; } };

export async function findOllama({ env = process.env, platform = process.platform, find = findExecutable, home = env.HOME, exists = isFile } = {}) {
  const found = await find('ollama', env, platform);
  if (found) return found;
  const candidates = platform === 'win32' ? [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe')]
    : platform === 'darwin' ? ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama',
      home && join(home, 'Applications', 'Ollama.app', 'Contents', 'Resources', 'ollama')]
    : [];
  for (const file of candidates.filter(Boolean)) if (await exists(file)) return file;
  return null;
}

/** What is on this computer: Ollama installed or not, running or not, and whether the model is downloaded. */
export async function detectOllama({ env = process.env, platform = process.platform, fetch = globalThis.fetch, find } = {}) {
  const baseUrl = ollamaBaseUrl(env);
  const executable = await findOllama({ env, platform, find });
  let version = '';
  let models = [];
  try {
    const reply = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(1500) });
    if (reply.ok) version = (await reply.json()).version || 'unknown';
  } catch { /* not running */ }
  if (version) {
    try {
      const reply = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (reply.ok) models = ((await reply.json()).models || []).map((model) => model.name).filter((name) => typeof name === 'string');
    } catch { /* treat as no models */ }
  }
  return {
    baseUrl, executable: executable || '', installed: !!executable || !!version, running: !!version, version,
    hasModel: models.some((name) => name === LOCAL_MODEL || name === `${LOCAL_MODEL}:latest`),
  };
}

/** Starts `ollama serve` on its own; it keeps running after the client quits, like Ollama's own tray app. */
export function startOllama(executable, run = spawn) {
  const child = run(executable, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on?.('error', () => {});
  child.unref?.();
}

/** Streams `/api/pull` and reports bytes downloaded; resolves when Ollama reports success. */
export async function pullModel({ baseUrl, model = LOCAL_MODEL, signal, fetch = globalThis.fetch, onProgress = () => {} }) {
  const reply = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal,
  });
  if (!reply.ok || !reply.body) throw new Error(`Ollama 拒绝了下载请求（${reply.status}）`);
  const layers = new Map();
  const decoder = new TextDecoder();
  let pending = '';
  let succeeded = false;
  const handle = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.error) throw new Error(event.error);
    if (event.digest && Number.isFinite(event.total)) layers.set(event.digest, { total: event.total, completed: event.completed || 0 });
    if (event.status === 'success') succeeded = true;
    const total = [...layers.values()].reduce((sum, layer) => sum + layer.total, 0);
    const completed = [...layers.values()].reduce((sum, layer) => sum + layer.completed, 0);
    onProgress({ status: event.status || '', total, completed });
  };
  for await (const chunk of reply.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop();
    lines.forEach(handle);
  }
  handle(pending + decoder.decode());
  if (!succeeded) throw new Error('下载在完成前中断，可以重新开始，已下载的部分会保留。');
}
