import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, sep, extname } from 'node:path';

const require = createRequire(new URL('../packages/extension/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const root = resolve('packages/extension/.output/chrome-mv3');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 380, height: 700 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://extension.test/**', async (route) => {
    const path = resolve(root, '.' + new URL(route.request().url()).pathname);
    assert.ok(path.startsWith(root + sep));
    await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[extname(path)] || 'application/octet-stream', body: await readFile(path) });
  });
  await page.addInitScript(() => {
    const listeners = new Set();
    window.heldSnapshots = [];
    window.snapshotConnection = 'connected';
    window.chrome = { runtime: {
      getURL: (path) => 'https://extension.test/' + path,
      getManifest: () => ({ version: '0.1.6' }),
      sendMessage: async () => {
        if (window.holdSnapshot) return new Promise((resolve) => window.heldSnapshots.push(resolve));
        return { kind: 'state', conn: window.snapshotConnection, settings: { backendUrl: '', token: '' }, instanceId: 'fixture-browser', desktopManaged: true };
      },
      onMessage: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    } };
    window.emitConnection = (conn) => { for (const listener of listeners) listener({ kind: 'conn', conn }); };
  });
  await page.goto('https://extension.test/sidepanel.html');
  await page.locator('.badge-connected').filter({ hasText: '已连接' }).waitFor();
  await page.evaluate(() => { window.holdSnapshot = true; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => window.heldSnapshots.length > 0);
  await page.evaluate(() => {
    window.emitConnection('connected');
    for (const done of window.heldSnapshots.splice(0)) done({ kind: 'state', conn: 'connecting', settings: { backendUrl: '', token: '' } });
    window.holdSnapshot = false;
  });
  assert.equal(await page.locator('.badge-connected').textContent(), '已连接', '旧快照不得覆盖新连接通知');
  await page.evaluate(() => window.emitConnection('disconnected'));
  await page.locator('.badge-disconnected').waitFor();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.locator('.badge-connected').waitFor();
  assert.deepEqual(errors, []);
  process.stdout.write('PASS built extension panel: connected snapshot, stale-response rejection, disconnect event and visible-state recovery; fixture runtime only\n');
} finally { await browser.close(); }
