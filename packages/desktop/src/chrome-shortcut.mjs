/**
 * A desktop shortcut that starts the user's Chrome with the rendering flags.
 *
 * The client connects to the Chrome the user already runs, so it cannot pass
 * launch arguments itself — and without them Chrome stops painting a task
 * window as soon as other windows cover it. A shortcut is the one-click way to
 * make "the Chrome I open" the Chrome that keeps rendering. Windows gets a
 * .lnk (Electron's shell.writeShortcutLink); macOS has no shortcut with
 * arguments, so it gets a minimal app bundle that runs `open -a … --args`.
 */
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { CHROME_RENDERING_FLAGS } from '@bcp/backend/dist/browser-adapters.js';

export const SHORTCUT_NAME = 'Chrome（UltraGo）.lnk';

/** The installed chrome.exe, per-user install first, as Chrome's installer places it. */
export function chromeExecutable(env, exists = existsSync) {
  const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean);
  return roots.map((root) => win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')).find((p) => exists(p)) ?? null;
}

/** Where the shortcut goes and what it runs, or null when Chrome is not installed. */
export function chromeShortcutSpec({ env, desktopDir, exists = existsSync }) {
  const target = chromeExecutable(env, exists);
  if (!target) return null;
  return {
    path: win32.join(desktopDir, SHORTCUT_NAME),
    options: {
      target,
      args: CHROME_RENDERING_FLAGS.join(' '),
      description: '启动 Chrome，并让 UltraGo 的后台任务窗口在被遮挡时继续渲染',
      icon: target,
      iconIndex: 0,
    },
  };
}

export const MAC_LAUNCHER_NAME = 'Chrome（UltraGo）.app';

/** Chrome.app installed for everyone first, then for this user only. */
export function macChromeApp(home, exists = existsSync) {
  return ['/Applications/Google Chrome.app', posix.join(home, 'Applications', 'Google Chrome.app')].find((p) => exists(p)) ?? null;
}

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/** The launcher app's files, or null when Chrome is not installed. `open` passes --args only to a Chrome not yet running. */
export function macChromeLauncher({ home, desktopDir, exists = existsSync }) {
  const chrome = macChromeApp(home, exists);
  if (!chrome) return null;
  const path = posix.join(desktopDir, MAC_LAUNCHER_NAME);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIdentifier</key><string>com.ultrago.chrome-launcher</string>
  <key>CFBundleName</key><string>Chrome（UltraGo）</string>
  <key>CFBundleIconFile</key><string>app.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`;
  return {
    path,
    files: [
      { path: posix.join(path, 'Contents', 'Info.plist'), content: plist, mode: 0o644 },
      { path: posix.join(path, 'Contents', 'MacOS', 'launcher'), content: `#!/bin/sh\nexec /usr/bin/open -a ${quote(chrome)} --args ${CHROME_RENDERING_FLAGS.join(' ')}\n`, mode: 0o755 },
    ],
    icon: { from: posix.join(chrome, 'Contents', 'Resources', 'app.icns'), to: posix.join(path, 'Contents', 'Resources', 'app.icns') },
  };
}

/** Writes the launcher; a missing Chrome icon only leaves it with the default app icon. */
export async function writeMacChromeLauncher(spec) {
  for (const file of spec.files) {
    await mkdir(posix.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content);
    // Set after writing: a mode given to writeFile applies only when the file is new, and a rerun replaces it.
    await chmod(file.path, file.mode);
  }
  await mkdir(posix.dirname(spec.icon.to), { recursive: true });
  await copyFile(spec.icon.from, spec.icon.to).catch(() => {});
}
