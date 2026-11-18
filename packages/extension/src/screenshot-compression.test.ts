import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import { compressScreenshot } from './screenshot-compression';

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

for (const [width, height, expectedWidth, expectedHeight] of [
  [2560, 1440, 1280, 720],
  [900, 1800, 640, 1280],
  [320, 160, 320, 160],
]) {
  test(`compresses ${width}x${height} to a readable JPEG without stretching or upscaling`, async () => {
    const page = await browser.newPage();
    try {
      const source = await page.evaluate(([w, h]) => {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'black';
        ctx.font = '48px sans-serif';
        ctx.fillText('Slide to verify', 20, 80);
        return canvas.toDataURL('image/png');
      }, [width, height]);
      const compressed = await page.evaluate(compressScreenshot, source);
      assert.match(compressed, /^data:image\/jpeg;base64,/);
      const dimensions = await page.evaluate(async (data) => {
        const bitmap = await createImageBitmap(await (await fetch(data)).blob());
        const result = [bitmap.width, bitmap.height];
        bitmap.close();
        return result;
      }, compressed);
      assert.deepEqual(dimensions, [expectedWidth, expectedHeight]);
      if (width > 1280) assert.ok(compressed.length < source.length);
    } finally {
      await page.close();
    }
  });
}

test('corrupt image fails instead of returning the original uncompressed screenshot', async () => {
  const page = await browser.newPage();
  try {
    await assert.rejects(page.evaluate(compressScreenshot, 'data:image/png;base64,AAAA'));
  } finally {
    await page.close();
  }
});
