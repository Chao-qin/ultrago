import { createHash } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const NATIVE_HOST = 'com.ultrago.desktop';
export function extensionId(key) {
  if (!key) throw new Error('扩展缺少固定公钥，无法注册连接宿主。');
  return [...createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export async function registerNativeHost(paths) {
  if (process.platform !== 'win32') throw new Error('当前内测连接宿主仅支持 Windows。');
  await access(paths.native);
  const manifest = JSON.parse(await readFile(join(paths.extension, 'manifest.json'), 'utf8'));
  const file = join(paths.userData, 'native-host.json');
  await writeFile(file, JSON.stringify({ name: NATIVE_HOST, description: 'UltraGo desktop connection', path: paths.native, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId(manifest.key)}/`] }), { mode: 0o600 });
  await promisify(execFile)('reg.exe', ['ADD', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST}`, '/ve', '/t', 'REG_SZ', '/d', file, '/f'], { windowsHide: true, timeout: 15_000 });
}
