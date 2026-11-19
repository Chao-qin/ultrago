#!/usr/bin/env node
/**
 * Bring a running console's database to a usable state — the steps a fresh
 * clone used to have to run by hand after `pnpm start`.
 *
 *   node scripts/seed-console.mjs [--url http://127.0.0.1:8790]
 *
 * Every start: re-index resource/playbooks/ (POST /api/books/rescan). That is
 * a pure file → index sync and safe to repeat.
 *
 * Only what was NEVER there is seeded, so nothing a user changed or deleted in
 * the console UI is overwritten or brought back:
 *   - schema registry empty   → scripts/register-schemas.mjs (also seeds the
 *                               default preprocess-config record)
 *   - a known flow is absent   → that flow's sync script
 * To pull repository changes into rows that already exist, run the individual
 * scripts by hand (they are repo-over-DB by design).
 *
 * `pnpm start` runs this after the console is listening; `pnpm doctor --fix`
 * runs it too. Exit code 1 when a step failed.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The flows that exist only as rows in console.db, with the script that writes each. */
export const SEEDED_FLOWS = [
  { name: "商品预处理", script: "scripts/sync-product-preprocess-flow.mjs" },
  { name: "商品预处理与发布", script: "scripts/sync-product-preprocess-publish-flow.mjs" },
];

/**
 * Decide what to run from what the console already holds. Pure, so the
 * "never overwrite what exists" rule is testable without a console.
 */
export function seedPlan({ schemaCount, flowNames }) {
  const steps = [];
  if (schemaCount === 0) steps.push({ label: "注册契约", script: "scripts/register-schemas.mjs" });
  steps.push({ label: "索引剧本", rescan: true });
  for (const f of SEEDED_FLOWS) if (!flowNames.includes(f.name)) steps.push({ label: `同步流程「${f.name}」`, script: f.script });
  return steps;
}

/** How long one console request may take before `pnpm start` stops waiting on it. */
const REQUEST_TIMEOUT_MS = 15_000;
/** How long one seeding script may run. */
const SCRIPT_TIMEOUT_MS = 180_000;

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body) ? body : (body.items ?? []);
}

export async function seedConsole(baseUrl, { log = console.log } = {}) {
  // Count deleted and inactive rows too: a flow the user deleted, or a registry
  // holding only inactive schemas, is a choice to respect — not a gap to refill.
  const [schemas, flows] = await Promise.all([
    getJson(`${baseUrl}/api/schemas?includeInactive=true&includeDeleted=true`),
    getJson(`${baseUrl}/api/flows?includeDeleted=true`),
  ]);
  const plan = seedPlan({ schemaCount: schemas.length, flowNames: flows.map((f) => f.name) });
  let failed = 0;
  for (const step of plan) {
    if (step.rescan) {
      const res = await fetch(`${baseUrl}/api/books/rescan`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) log(`[seed] ${step.label}：完成`);
      else { failed++; log(`[seed] ${step.label}：失败（HTTP ${res.status}）`); }
      continue;
    }
    const r = spawnSync(process.execPath, [resolve(ROOT, step.script), "--url", baseUrl], { cwd: ROOT, encoding: "utf8", timeout: SCRIPT_TIMEOUT_MS });
    if (r.status === 0) log(`[seed] ${step.label}：完成`);
    else {
      failed++;
      log(`[seed] ${step.label}：失败 — 手动重试：node ${step.script} --url ${baseUrl}\n${(r.stderr || r.stdout || "").trim().split("\n").slice(-5).join("\n")}`);
    }
  }
  return { failed, ran: plan.map((s) => s.label) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const i = process.argv.indexOf("--url");
  const baseUrl = i >= 0 ? process.argv[i + 1] : process.env.CONSOLE_URL || `http://127.0.0.1:${process.env.CONSOLE_PORT || 8790}`;
  seedConsole(baseUrl)
    .then(({ failed }) => { process.exitCode = failed ? 1 : 0; })
    .catch((e) => { console.error(`[seed] 无法读取工作台状态：${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
}
