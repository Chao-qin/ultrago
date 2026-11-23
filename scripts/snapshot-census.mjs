#!/usr/bin/env node
/**
 * Snapshot-size census — what a snapshot reply costs, per page, measured on the real renderer.
 *
 * Reads the raw snapshots under bench/snapshots/ (captured by `pnpm --filter @bcp/extension snapshot:capture`) and
 * renders them with the backend's own renderSnapshot / renderSnapshotView from packages/backend/dist, so a change to
 * the renderer shows up here as a number instead of an impression. Offline and deterministic.
 *
 *   node scripts/snapshot-census.mjs           # print the table
 *   node scripts/snapshot-census.mjs --check   # CI: fail if a default reply grew >5%, needs more pages, or lists a
 *                                              #     different number of elements than the baseline
 *   node scripts/snapshot-census.mjs --write   # record the current numbers as the baseline (bench/snapshot-census.json)
 *
 * Columns: "full" renders every element with no paging and no summary — paging caps a single reply at 30k
 * characters, so a reply that got smaller can look unchanged when what really changed is the number of pages.
 * "reply" is the default first reply an agent actually gets. Line shares are taken over the full rendering.
 *
 * Tokens are an ESTIMATE (CJK character ≈ 1 token, other text ≈ 3.5 characters per token): good for comparing two
 * renderings of the same page, not for absolute cost. Nothing is sent to a tokenizer service — page text stays here.
 *
 * Missing data or a missing backend build exits 2: a census that measured nothing must never read as a pass.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = resolve(ROOT, "bench/snapshots");
const BASELINE = resolve(ROOT, "bench/snapshot-census.json");
const RENDER = resolve(ROOT, "packages/backend/dist/browser-mcp-render.js");
const GROWTH = 1.05;

const files = existsSync(DATA) ? readdirSync(DATA).filter((f) => f.endsWith(".json")).sort() : [];
if (!files.length || !existsSync(RENDER)) {
  console.error(`snapshot-census: ${files.length ? "" : `no snapshots in ${DATA}; `}${existsSync(RENDER) ? "" : `no backend build at ${RENDER} (pnpm --filter @bcp/backend build)`}. Exiting 2.`);
  process.exit(2);
}
const { renderSnapshot, renderSnapshotView } = await import(RENDER);

const tokens = (s) => {
  const cjk = (s.match(/[　-鿿＀-￯]/g) ?? []).length;
  return Math.round(cjk + (s.length - cjk) / 3.5);
};
/** Reading the whole default view by following `after`: how many replies it takes and how many refs they list.
 *  The listed count is the two-way half of the guard — a reply can also shrink by dropping what it must list. */
const readAll = (els) => {
  let pages = 0;
  let listed = 0;
  let after;
  for (;;) {
    pages++;
    const r = renderSnapshotView(els, { after });
    listed += r.shown.length;
    const next = /after: "([^"]+)"/.exec(r.text)?.[1];
    if (!next || pages > 100) return { pages, listed };
    after = next;
  }
};
const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");

const rows = files.map((f) => {
  const { name, elements } = JSON.parse(readFileSync(resolve(DATA, f), "utf8"));
  const full = renderSnapshot(elements);
  const lines = full.split("\n");
  const share = (re) => pct(lines.filter((l) => re.test(l)).length, lines.length);
  const chars = (re) => pct((full.match(re) ?? []).join("").length, full.length);
  return {
    page: name ?? f.replace(/\.json$/, ""),
    elements: elements.length,
    fullTokens: tokens(full),
    replyTokens: tokens(renderSnapshotView(elements).text),
    ...readAll(elements),
    hidden: share(/\[hidden\]/),
    offscreen: share(/\[offscreen\]/),
    group: share(/\(group\)/),
    boxes: chars(/ \(\d+,\d+ \d+×\d+\)/g),
    options: chars(/ options=\[[^\]]*\]/g),
  };
});

const sorted = (k) => rows.map((r) => r[k]).sort((a, b) => a - b);
const quantile = (k, q) => sorted(k)[Math.min(rows.length - 1, Math.floor(q * rows.length))];
const median = (k) => {
  const v = sorted(k);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
};
const sum = (k) => rows.reduce((t, r) => t + r[k], 0);
const numeric = ["elements", "listed", "fullTokens", "replyTokens", "pages"];
console.table([
  ...rows,
  Object.fromEntries([["page", "median"], ...numeric.map((k) => [k, median(k)])]),
  Object.fromEntries([["page", "P90"], ...numeric.map((k) => [k, quantile(k, 0.9)])]),
  Object.fromEntries([["page", "total"], ...numeric.map((k) => [k, sum(k)])]),
]);

const mode = process.argv[2];
const current = Object.fromEntries(rows.map((r) => [r.page, { replyTokens: r.replyTokens, pages: r.pages, listed: r.listed }]));
if (mode === "--write") {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + "\n");
  console.log(`baseline written: ${BASELINE}`);
} else if (mode === "--check") {
  if (!existsSync(BASELINE)) {
    console.error(`snapshot-census: no baseline at ${BASELINE} (run with --write). Exiting 2.`);
    process.exit(2);
  }
  const base = JSON.parse(readFileSync(BASELINE, "utf8"));
  const problems = [];
  for (const page of new Set([...Object.keys(base), ...Object.keys(current)])) {
    const b = base[page];
    const c = current[page];
    if (!b || !c) problems.push(`${page}: ${b ? "snapshot missing" : "not in the baseline"} — re-run with --write if that is intended`);
    else if (c.replyTokens > b.replyTokens * GROWTH || c.pages > b.pages || c.listed !== b.listed)
      problems.push(`${page}: default reply ${b.replyTokens} → ${c.replyTokens} tokens, ${b.pages} → ${c.pages} page(s), ${b.listed} → ${c.listed} listed`);
  }
  if (problems.length) {
    console.error(`snapshot-census: the default snapshot reply left the baseline:\n  ${problems.join("\n  ")}\nIf the change is intended, re-run with --write and commit the baseline with the change.`);
    process.exit(1);
  }
  console.log("snapshot-census: within the baseline");
} else if (mode) {
  console.error(`snapshot-census: unknown option ${mode}`);
  process.exit(2);
}
