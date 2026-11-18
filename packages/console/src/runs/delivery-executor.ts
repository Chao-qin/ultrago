/**
 * delivery-executor.ts — the post-run delivery EXECUTION layer (console side).
 *
 * The backend resolves a book's deliveries for a run and surfaces them (plus the
 * produced outputs) in the internal-runner snapshot. THIS console layer executes
 * them, backed by SQLite (DeliveryRun rows) so a crash between "run finished"
 * and "delivered" doesn't lose the delivery — the dispatcher re-runs any
 * pending/errored DeliveryRun on the next tick (redelivery loop).
 *
 * Every delivery is best-effort: a failure is recorded and NEVER changes the
 * run outcome. webhook carries an Idempotency-Key so the receiver can dedupe an
 * at-least-once redelivery.
 *
 * file    → verify the produced file landed in reports/ (the write happened
 *           in-run via a local.writeFile step; this just confirms + reports it).
 * print   → render the produced data as text for the run-detail view.
 * webhook → POST the run outcome to an external URL (10s timeout).
 * message → send via weclaw (recipient = weclaw defaultRecipient).
 *
 * There is no `db` kind any more. It existed to persist a run's outputs, but a
 * landing place that only exists for runs configured with that delivery covers
 * a subset, and a subset cannot be a source of truth — every run's product now
 * lands unconditionally as a SchemaRecord row (OutputLandingService), so the
 * delivery had nothing left to do.
 */
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { ResolvedDelivery, RunConclusion } from "@bcp/shared";
// NOT getManager(): that singleton is per-process, and its lifecycle half
// (phase/pid/uptime, start/stop/status) is meaningful only in the backend
// process that spawns the daemon. The console never needed it — importing the
// two process-agnostic pieces instead keeps the misleading half out of reach.
import { WecClient, config as weclawConfig } from "@bcp/weclaw";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Monorepo root = 4 levels up from packages/console/src/runs/ (reports/ lives there).
const REPORTS_DIR = process.env.BCP_DATA_ROOT ? path.join(process.env.BCP_DATA_ROOT, 'reports') : path.resolve(__dirname, "../../../../reports");

export interface DeliveryResult {
  kind: ResolvedDelivery["kind"];
  on: RunConclusion;
  status: "ok" | "skipped" | "error";
  detail?: string;
}

/** Everything the delivery layer needs about a finished run — assembled by the
 * dispatcher from the backend snapshot (and reconstructed from the DB on a
 * redelivery, so every field must be recoverable without the backend). */
export interface DeliveryContext {
  /** The console Run row's id. Required, not optional, and deliberately here
   *  rather than as a parameter: it WAS a 4th optional positional arg on
   *  executeDelivery, and dfc88a3 — removing the unrelated `outputStore` param —
   *  rewrote the single call site without it, so every webhook since has shipped
   *  with no runId while typecheck stayed green. A required field on the context
   *  every caller must already build turns that same mistake into a compile
   *  error, and there are only two places a DeliveryContext is constructed. */
  runId: string;
  planId: string;
  bookName: string;
  status: string;
  ranSteps: number;
  totalSteps: number;
  durationMs: number;
  error?: string;
  outputs?: unknown;
  paramsJson?: string;
  /** Report-relative paths this run wrote, from its landed artifact rows. The
   *  `file` delivery is checked against this list — see `verifyFile`. */
  artifacts?: Array<{ path: string }>;
}

/** A delivery's `on` gate vs the run outcome. Mirrors GitHub Actions'
 * `if: conclusion == …` branching. */
export function matchesConclusion(on: RunConclusion, status: string): boolean {
  switch (on) {
    case "success":
      return status === "success";
    case "failure":
      return status === "escalated" || status === "failed";
    case "cancelled":
      return status === "cancelled";
    case "any":
      return true;
  }
}

/** Execute ONE delivery, gated by `on`, best-effort. `index` is its position in
 * the book's delivery list — used to build a stable Idempotency-Key. */
export async function executeDelivery(
  d: ResolvedDelivery,
  ctx: DeliveryContext,
  index: number,
): Promise<DeliveryResult> {
  if (!matchesConclusion(d.on, ctx.status)) {
    return { kind: d.kind, on: d.on, status: "skipped", detail: `on:${d.on} ≠ status:${ctx.status}` };
  }
  try {
    return { kind: d.kind, on: d.on, status: "ok", detail: await deliver(d, ctx, index) };
  } catch (e) {
    return { kind: d.kind, on: d.on, status: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}

async function deliver(d: ResolvedDelivery, ctx: DeliveryContext, index: number): Promise<string | undefined> {
  switch (d.kind) {
    case "file":
      if (typeof d.artifact !== "string" || !d.artifact.trim()) throw new Error("invalid file delivery: artifact is required");
      if (/^\{\{.+\}\}$/.test(d.artifact)) throw new Error(`invalid file delivery: unresolved artifact ${d.artifact}`);
      return verifyFile(d.artifact, ctx.artifacts ?? []);
    case "print":
      return renderPrint(d, ctx);
    case "webhook":
      return webhookPost(d.url, d.method, ctx, `${ctx.planId}:${index}`);
    case "message":
      return wechatSend(d.template, ctx);
  }
}

/** A `file` delivery reports success only for a file THIS run wrote.
 *
 *  `artifacts` comes from the run's landed artifact rows (`SchemaRecord`,
 *  `source = "run:<id>:artifact:<path>"`), which is where the deleted
 *  `Artifact` table's contents went. Without the ownership half, a run that
 *  failed to write its report would still "deliver" a same-named file left
 *  behind by an earlier run — the check has blocked 10 deliveries in this
 *  database, spread over 10 distinct runs and naming 9 distinct files (one file
 *  was claimed twice). Recount with
 *  `SELECT COUNT(*), COUNT(DISTINCT runId) FROM DeliveryRun WHERE lastError
 *  LIKE '%not owned by this run%'` — 10 / 10 as of 2026-08-28, identical across
 *  the live database and three backup snapshots. So it is a live guard and not
 *  a formality. */
async function verifyFile(p: string, artifacts: Array<{ path: string }>): Promise<string> {
  const relativePath = normalizeReportPath(p);
  if (!artifacts.some((a) => normalizeReportPath(a.path) === relativePath)) {
    throw new Error(`file delivery artifact is not owned by this run: ${relativePath}`);
  }
  const abs = path.resolve(REPORTS_DIR, relativePath);
  await access(abs);
  return relativePath;
}

function renderPrint(d: Extract<ResolvedDelivery, { kind: "print" }>, ctx: DeliveryContext): string | undefined {
  const o = ctx.outputs;
  if (o === undefined) return undefined;
  if (typeof o === "string") return o;
  const rendered = d.format === "text" ? JSON.stringify(o) : JSON.stringify(o, null, 2);
  return rendered ?? String(o);
}

async function webhookPost(
  url: string,
  method: "POST" | "PUT",
  ctx: DeliveryContext,
  idempotencyKey: string,
): Promise<string> {
  await assertSafeWebhookUrl(url);
  const res = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      // Stable per-run-per-delivery key so the receiver can dedupe an
      // at-least-once redelivery.
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({
      kind: "run_finished",
      runId: ctx.runId,
      planId: ctx.planId,
      bookName: ctx.bookName,
      status: ctx.status,
      ranSteps: ctx.ranSteps,
      totalSteps: ctx.totalSteps,
      durationMs: ctx.durationMs,
      error: ctx.error,
      params: parseParams(ctx.paramsJson),
      outputs: ctx.outputs,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`webhook ${url} → HTTP ${res.status}`);
  return `HTTP ${res.status}`;
}

async function wechatSend(template: string, ctx: DeliveryContext): Promise<string> {
  // Line-for-line what the manager's two getters do (weclaw-manager.ts:171 and
  // the constructor at :56), minus the lifecycle surface the console must not
  // touch. Constructing the client per send is free — it only stores a string.
  const to = weclawConfig.defaultRecipient;
  if (!to) throw new Error("wechat delivery: no recipient configured (weclaw defaultRecipient)");
  const text = renderTemplate(template, ctx);
  const r = await new WecClient(weclawConfig.apiUrl).sendText({ to, text });
  return `sent to ${r.to}`;
}

export function renderTemplate(template: string, ctx: DeliveryContext): string {
  const base = template;
  const vars: Record<string, string> = {
    planId: ctx.planId,
    bookName: ctx.bookName,
    status: ctx.status,
    ranSteps: String(ctx.ranSteps),
    totalSteps: String(ctx.totalSteps),
    durationMs: String(ctx.durationMs),
    error: ctx.error ?? "",
  };
  const params = parseParams(ctx.paramsJson);
  return base.replace(/\{\{([\w.]+)\}\}/g, (_, key: string) => {
    if (vars[key] !== undefined) return vars[key];
    const value = key === "outputs"
      ? ctx.outputs
      : key === "params"
        ? params
        : readPath(key.startsWith("outputs.") ? ctx.outputs : key.startsWith("params.") ? params : undefined, key.split(".").slice(1));
    if (value === undefined) return `{{${key}}}`;
    return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  });
}

function parseParams(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readPath(value: unknown, pathParts: string[]): unknown {
  let current = value;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function normalizeReportPath(value: string): string {
  const raw = value.replaceAll("\\", "/");
  const candidate = path.isAbsolute(raw)
    ? path.relative(REPORTS_DIR, raw)
    : raw.startsWith("reports/") ? raw.slice("reports/".length) : raw;
  const abs = path.resolve(REPORTS_DIR, candidate);
  const rel = path.relative(REPORTS_DIR, abs);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`file delivery path escapes reports/: ${value}`);
  return rel.split(path.sep).join("/");
}

async function assertSafeWebhookUrl(raw: string): Promise<void> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("webhook url must be an absolute http(s) URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("webhook url must use http(s)");
  if (url.username || url.password) throw new Error("webhook url must not contain credentials");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || isPrivateIp(host)) throw new Error("webhook url resolves to a private address");
  if (!isIP(host)) {
    const addresses = await lookup(host, { all: true });
    if (addresses.some((entry) => isPrivateIp(entry.address))) throw new Error("webhook url resolves to a private address");
  }
}

function isPrivateIp(value: string): boolean {
  if (isIP(value) === 4) {
    const p = value.split(".").map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
  }
  const low = value.toLowerCase();
  return low === "::1" || low === "::" || low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd") || low.startsWith("::ffff:127.") || low.startsWith("::ffff:10.") || low.startsWith("::ffff:192.168.");
}
