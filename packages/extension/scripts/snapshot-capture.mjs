#!/usr/bin/env node
/**
 * Capture raw snapshots of public pages for the snapshot-size census (scripts/snapshot-census.mjs).
 *
 * Runs the REAL `bcpDomRuntime` (bundled from source, the same way check:dom does) in headless Chromium, so the
 * census measures what the extension would return, not a reimplementation. Manual, needs network: pages change,
 * which is why the census reads the committed JSON instead of re-capturing.
 *
 * Every capture is taken under the same conditions — 1280×800, scrolled to the top, zh-CN, Asia/Shanghai — because
 * `inViewport` and the boxes depend on them; two censuses of different conditions are not comparable, which is why
 * each file also records the Chromium version and user agent. Every frame is read and merged by the dispatcher's
 * own merge (src/snapshot-merge.ts), so iframe content — MDN's live <select> example — is in the census as it is
 * in a real reply.
 *
 * Public pages only. Pages behind a login carry shop and product data and must not be committed.
 *
 *   pnpm --filter @bcp/extension snapshot:capture            # all pages below
 *   pnpm --filter @bcp/extension snapshot:capture github-trending hn-list
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleFrameMerge, bundleRuntime, loadEsbuild, loadPlaywright } from "./toolchain.mjs";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../bench/snapshots");
/** Fingerprint of the runtime source a capture ran — the census compares it to tell a stale capture. */
const RUNTIME_HASH = createHash("sha256").update(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/content/dom-runtime.ts"))).digest("hex").slice(0, 12);
const VIEWPORT = { width: 1280, height: 800 };
/** `open`: a selector clicked before the capture, for state a page only reaches by interaction (an open modal);
 *  `openedWhen`: the selector that proves it opened — the capture waits for it to be visible and fails without it. */
const PAGES = {
  "baidu-home": { url: "https://www.baidu.com" },
  "bilibili-home": { url: "https://www.bilibili.com" },
  "github-trending": { url: "https://github.com/trending" },
  "hn-list": { url: "https://news.ycombinator.com" },
  // From outside mainland China this lands on JD's English corporate site, not the shopping home page.
  "jd-corporate": { url: "https://www.jd.com" },
  "mdn-select": { url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/select" },
  // An open modal: everything behind it renders with its @dialog layer.
  "w3c-modal-dialog": { url: "https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/dialog/", open: 'button:has-text("Add Delivery Address")', openedWhen: '[role="dialog"]' },
  // Large enough to stay paged after hidden elements are summarised, so the census's page check can fire.
  "wikipedia-list": { url: "https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population" },
};

/** One element per line: a re-capture then reviews as a line diff of what changed on the page. */
const benchJson = (meta, elements) =>
  `${JSON.stringify(meta).slice(0, -1)},"elements":[\n${elements.map((e) => JSON.stringify(e)).join(",\n")}\n]}\n`;

const only = process.argv.slice(2);
const unknown = only.filter((n) => !(n in PAGES));
if (unknown.length) {
  console.error(`snapshot-capture: unknown page(s) ${unknown.join(", ")}; known: ${Object.keys(PAGES).join(", ")}`);
  process.exit(2);
}
const esbuild = await loadEsbuild();
const pw = await loadPlaywright();
if (!esbuild || !pw) {
  console.error(`snapshot-capture: toolchain unavailable (esbuild=${!!esbuild}, playwright-core=${!!pw}). Exiting 2.`);
  process.exit(2);
}
const runtimeSource = (await bundleRuntime(esbuild)).bcpDomRuntime.toString();
const { mergeFrameSnapshots } = await bundleFrameMerge(esbuild);

mkdirSync(OUT, { recursive: true });
const browser = await pw.chromium.launch({ headless: true });
// bypassCSP: the runtime is injected with eval here, which a strict CSP (github) refuses; the extension's
// executeScript is not subject to the page's CSP, so this only removes a difference of the harness.
const context = await browser.newContext({ viewport: VIEWPORT, bypassCSP: true, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
let failed = 0;
for (const name of only.length ? only : Object.keys(PAGES)) {
  const page = await context.newPage();
  try {
    const { url, open, openedWhen } = PAGES[name];
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {}); // long-polling pages never idle
    await page.evaluate(() => window.scrollTo(0, 0));
    if (open) {
      await page.click(open, { timeout: 10_000 });
      await page.locator(openedWhen).first().waitFor({ state: "visible", timeout: 10_000 });
    }
    // Every frame, numbered as the dispatcher's frameIds are numbered: 0 for the top, distinct ids for the rest.
    const results = [];
    for (const [frameId, frame] of page.frames().entries()) {
      try {
        await frame.evaluate((src) => { globalThis.__bcpRun = eval(`(${src})`); }, runtimeSource);
        results.push({ frameId, result: await frame.evaluate(() => globalThis.__bcpRun("snapshot", {})) });
      } catch (e) {
        if (frameId === 0) throw e; // a detached or blocked sub-frame is skipped, as executeScript skips it
      }
    }
    if (results[0]?.result?.error) throw new Error(results[0].result.error);
    const { elements, moreBelow } = mergeFrameSnapshots(0, results);
    const conditions = await page.evaluate(() => ({ scrollY: window.scrollY, devicePixelRatio: window.devicePixelRatio, userAgent: navigator.userAgent, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
    const meta = { name, url, open, runtime: RUNTIME_HASH, capturedAt: new Date().toISOString().slice(0, 10), chromium: browser.version(), viewport: VIEWPORT, ...conditions, moreBelow, frames: results.length };
    writeFileSync(resolve(OUT, `${name}.json`), benchJson(meta, elements));
    console.log(`${name}: ${elements.length} elements in ${results.length} frame(s)`);
  } catch (e) {
    failed++;
    console.error(`${name}: FAILED — ${String(e).split("\n")[0]}`);
  }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
