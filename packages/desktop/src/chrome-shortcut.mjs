/**
 * A desktop shortcut that starts the user's Chrome with the rendering flags.
 *
 * The client connects to the Chrome the user already runs, so it cannot pass
 * launch arguments itself — and without them Chrome stops painting a task
 * window as soon as other windows cover it. A shortcut is the one-click way to
 * make "the Chrome I open" the Chrome that keeps rendering. Windows only
 * (Electron's shell.writeShortcutLink).
 */
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
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
