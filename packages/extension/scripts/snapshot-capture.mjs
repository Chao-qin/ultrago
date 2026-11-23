#!/usr/bin/env node
/**
 * Capture raw snapshots of public pages for the snapshot-size census (scripts/snapshot-census.mjs).
 *
 * Runs the REAL `bcpDomRuntime` (bundled from source, the same way check:dom does) in headless Chromium, so the
 * census measures what the extension would return, not a reimplementation. Manual, needs network: pages change,
 * which is why the census reads the committed JSON instead of re-capturing.
 *
 * Every capture is taken under the same conditions — 1280×800, scrolled to the top — because `inViewport` and the
 * boxes depend on them; two censuses of different conditions are not comparable. Top frame only: frame merging
 * lives in the extension's dispatcher, which this does not run.
 *
 * Public pages only. Pages behind a login carry shop and product data and must not be committed.
 *
 *   pnpm --filter @bcp/extension snapshot:capture            # all pages below
 *   pnpm --filter @bcp/extension snapshot:capture github-trending hn-list
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleRuntime, loadEsbuild, loadPlaywright } from "./toolchain.mjs";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../bench/snapshots");
const VIEWPORT = { width: 1280, height: 800 };
const PAGES = {
  "baidu-home": "https://www.baidu.com",
  "bilibili-home": "https://www.bilibili.com",
  "github-trending": "https://github.com/trending",
  "hn-list": "https://news.ycombinator.com",
  // From outside mainland China this lands on JD's English corporate site, not the shopping home page.
  "jd-corporate": "https://www.jd.com",
  "mdn-select": "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/select",
  // Large enough to stay paged after hidden elements are summarised, so the census's page check can fire.
  "wikipedia-list": "https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population",
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

mkdirSync(OUT, { recursive: true });
const browser = await pw.chromium.launch({ headless: true });
// bypassCSP: the runtime is injected with eval here, which a strict CSP (github) refuses; the extension's
// executeScript is not subject to the page's CSP, so this only removes a difference of the harness.
const context = await browser.newContext({ viewport: VIEWPORT, bypassCSP: true, locale: "zh-CN" });
let failed = 0;
for (const name of only.length ? only : Object.keys(PAGES)) {
  const page = await context.newPage();
  try {
    await page.goto(PAGES[name], { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {}); // long-polling pages never idle
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate((src) => { globalThis.__bcpRun = eval(`(${src})`); }, runtimeSource);
    const r = await page.evaluate(() => globalThis.__bcpRun("snapshot", {}));
    if (r.error) throw new Error(r.error);
    const { elements, moreBelow } = r.value;
    const conditions = await page.evaluate(() => ({ scrollY: window.scrollY, devicePixelRatio: window.devicePixelRatio }));
    writeFileSync(resolve(OUT, `${name}.json`), benchJson({ name, url: PAGES[name], capturedAt: new Date().toISOString().slice(0, 10), viewport: VIEWPORT, ...conditions, moreBelow }, elements));
    console.log(`${name}: ${elements.length} elements`);
  } catch (e) {
    failed++;
    console.error(`${name}: FAILED — ${String(e).split("\n")[0]}`);
  }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
