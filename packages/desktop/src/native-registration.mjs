import { createHash } from 'node:crypto';
import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const NATIVE_HOST = 'com.ultrago.desktop';
export function extensionId(key) {
  if (!key) throw new Error('扩展缺少固定公钥，无法注册连接宿主。');
  return [...createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/** Chrome reads a current user's native messaging hosts from this folder on macOS; Windows uses the registry. */
export const macHostDirectory = (home) => join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');

export async function registerNativeHost(paths, { platform = process.platform, home = homedir(), run = promisify(execFile) } = {}) {
  if (platform !== 'win32' && platform !== 'darwin') throw new Error('当前内测连接宿主仅支持 Windows 和 macOS。');
  await access(paths.native);
  const manifest = JSON.parse(await readFile(join(paths.extension, 'manifest.json'), 'utf8'));
  const host = JSON.stringify({ name: NATIVE_HOST, description: 'UltraGo desktop connection', path: paths.native, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId(manifest.key)}/`] });
  if (platform === 'darwin') {
    const directory = macHostDirectory(home);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${NATIVE_HOST}.json`), host, { mode: 0o644 });
    return;
  }
  const file = join(paths.userData, 'native-host.json');
  await writeFile(file, host, { mode: 0o600 });
  await run('reg.exe', ['ADD', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST}`, '/ve', '/t', 'REG_SZ', '/d', file, '/f'], { windowsHide: true, timeout: 15_000 });
}
