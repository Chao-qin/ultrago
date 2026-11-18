import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import type { ResolvedDelivery } from "@bcp/shared";

export interface DurableDeliveryPayload {
  runId: string;
  planId: string;
  bookName: string;
  trigger: "manual" | "schedule" | "mcp";
  mode?: "assisted" | "auto";
  status: string;
  ranSteps: number;
  totalSteps: number;
  durationMs: number;
  error?: string;
  params?: Record<string, unknown>;
  /** The book's terminal output. When it serializes past MAX_INLINE_OUTPUTS_BYTES
   *  the bridge replaces it with a {@link SpilledOutputs} ref so the outbox body
   *  stays small and console receives something it can reject on shape grounds
   *  rather than on size grounds (the latter retries forever). */
  outputs?: unknown;
  deliveries: ResolvedDelivery[];
  artifacts?: Array<{ path: string; kind?: string; size?: number; mimeType?: string | null }>;
}

/** Marker for an outputs value that was too large to inline into the outbox
 *  body. Console (or anyone else) seeing this should treat it as a pointer and
 *  read the file at `path` to recover the original value. */
export interface SpilledOutputs {
  __bcpOffloaded: true;
  path: string;
  bytes: number;
}

/** Inline-vs-spill threshold for outputs. 1 MB is comfortably under any HTTP
 *  body ceiling the bridge targets (25 MB on GitHub / 100 MB on internal
 *  fetch) while leaving room for typical book outputs (a 200 KB canonical
 *  JSON, an addv2 payload, a few MB of rendered markdown). Bumping this
 *  would re-open the "retries forever because the body is too big" hole that
 *  this whole mechanism exists to plug. */
export const MAX_INLINE_OUTPUTS_BYTES = 1 * 1024 * 1024;

/** If `payload.outputs` is larger than the inline cap, serialize it to disk
 *  and substitute a {@link SpilledOutputs} ref. Otherwise pass through. */
export async function spillOutputsIfLarge(
  payload: DurableDeliveryPayload,
  spillDir: string,
): Promise<DurableDeliveryPayload> {
  if (payload.outputs === undefined) return payload;
  let serialized: string;
  try {
    serialized = JSON.stringify(payload.outputs);
  } catch {
    // Circular refs etc. fall back to the original payload — the bridge will
    // stringify it as best it can and the caller will see the real error from
    // downstream. Better than silently dropping the value here.
    return payload;
  }
  if (!serialized || serialized.length <= MAX_INLINE_OUTPUTS_BYTES) return payload;
  await mkdir(spillDir, { recursive: true });
  const spillPath = join(spillDir, `${payload.runId}.json`);
  await writeFile(spillPath, serialized, "utf8");
  const ref: SpilledOutputs = { __bcpOffloaded: true, path: spillPath, bytes: serialized.length };
  // Logged so an operator can see WHY this run's body is tiny and where to find
  // the real bytes — without this the silent swap looks like a missing field.
  console.warn(
    `[delivery] outputs for run ${payload.runId} spilled: ${serialized.length} bytes → ${spillPath}`,
  );
  return { ...payload, outputs: ref };
}

export interface DeliverySink {
  ingest(payload: DurableDeliveryPayload): Promise<void>;
}

/**
 * Durable bridge from the backend process to console. The JSON outbox is
 * written before the HTTP request, so a console outage or backend restart does
 * not turn an in-memory terminal callback into a lost delivery.
 *
 * LAZY by design: construction has zero side effects (no URL validation, no
 * outbox dir, no timer). The bridge activates only when a terminal book
 * delivery actually occurs (ingest) or when boot recovery finds leftover
 * outbox files — so a browser-only backend (no book execution) never pays any
 * delivery cost.
 */
export class ConsoleDeliveryClient implements DeliverySink {
  private readonly baseUrl: string;
  private readonly outboxDir: string;
  private readonly spillDir: string;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private started = false;

  constructor(opts?: { baseUrl?: string; outboxDir?: string; spillDir?: string }) {
    // No side effects here: the URL is validated lazily on start() so an
    // invalid BCP_CONSOLE_URL can never fail a browser-only backend boot.
    const raw = (opts?.baseUrl ?? process.env.BCP_CONSOLE_URL ?? "http://127.0.0.1:8790").replace(/\/$/, "");
    this.baseUrl = raw;
    // The default is relative to the CURRENT WORKING DIRECTORY, and the repo's
    // `/reports/*` gitignore rules only describe it when that is the repo root.
    // Two independent things put it there, both measured 2026-08-28:
    //   - `packages/backend/package.json`'s `start` and `dev` both begin
    //     `cd ../..`. `pnpm --filter @bcp/backend exec pwd` prints the PACKAGE
    //     dir, so that `cd` is what moves it up: `cd ../..` from
    //     packages/backend is the repo root.
    //   - `scripts/backend.sh` ALSO does it itself — `cd "$ROOT"` on the line
    //     above `nohup pnpm --filter @bcp/backend start` in `start()`, and again
    //     at the top of `dev()` (plus three `(cd "$ROOT" && …)` subshells for
    //     the weclaw commands).
    // A previous version of this comment asserted the opposite — that
    // backend.sh "shells out rather than cd-ing itself" — which was never
    // checked and is false. The conclusion (cwd is the repo root) is if anything
    // safer than claimed, since either mechanism alone would establish it.
    //
    // That is not a promise this line makes on its own; it is the assumption the
    // whole backend already runs on (playbook.ts's PLAYBOOKS_DIR,
    // local-actions.ts's REPORTS_DIR, delivery-executor.ts's reports dir and
    // config.ts's .env lookup all resolve against cwd the same way). Started
    // from anywhere else, every one of those moves together — the outbox is not
    // the special case, and BCP_DELIVERY_OUTBOX_DIR is how to put it back.
    this.outboxDir = resolve(opts?.outboxDir ?? process.env.BCP_DELIVERY_OUTBOX_DIR ?? join(process.cwd(), "reports", ".delivery-outbox"));
    // Outputs that exceed MAX_INLINE_OUTPUTS_BYTES spill here. Lives outside
    // outboxDir on purpose — outbox unlinks on 2xx, but the spilled bytes may
    // still be wanted for debug/replay even after a successful delivery (and
    // are definitely wanted after a failed one). Same `.reports/*` gitignore
    // pattern covers it. Configurable for tests via `opts.spillDir`.
    this.spillDir = resolve(opts?.spillDir ?? process.env.BCP_DELIVERY_OUTPUTS_DIR ?? join(process.cwd(), "reports", ".delivery-outputs"));
  }

  /** Activate the bridge (idempotent): validate config, start the flush timer.
   * Called lazily by ingest() and by recoverIfPending() at boot. */
  start(): void {
    if (this.started) return;
    assertLoopbackUrl(this.baseUrl);
    this.started = true;
    void this.flush();
    this.flushTimer = setInterval(() => void this.flush(), 1_000);
    this.flushTimer.unref?.();
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.started = false;
  }

  /** Boot-time crash recovery: resume flushing ONLY when a previous run left
   * pending outbox files. Never creates the outbox dir and never starts the
   * timer in a browser-only backend. */
  async recoverIfPending(): Promise<void> {
    if (this.started) return;
    let files: string[];
    try {
      files = await readdir(this.outboxDir);
    } catch {
      return; // no outbox yet — nothing to recover
    }
    if (files.some((f) => f.endsWith(".json"))) this.start();
  }

  async ingest(payload: DurableDeliveryPayload): Promise<void> {
    // Lazy activation: a terminal delivery is the ONLY thing that should make
    // a browser-only backend start the delivery bridge.
    this.start();
    await mkdir(this.outboxDir, { recursive: true });
    const name = `${createHash("sha1").update(payload.runId).digest("hex")}.json`;
    const target = join(this.outboxDir, name);
    const temp = `${target}.${process.pid}.tmp`;
    let next = await spillOutputsIfLarge(payload, this.spillDir);
    try {
      const prior = JSON.parse(await readFile(target, "utf8")) as DurableDeliveryPayload;
      // Cancellation is user intent and must not be replaced by a late backend
      // success snapshot while the console is temporarily unavailable.
      if (prior.status === "cancelled" && payload.status !== "cancelled") next = prior;
    } catch {
      // No prior outbox item, or a corrupt one that can be safely replaced.
    }
    await writeFile(temp, JSON.stringify(next), "utf8");
    await rename(temp, target);
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushOnce().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async flushOnce(): Promise<void> {
    await mkdir(this.outboxDir, { recursive: true });
    let files: string[];
    try { files = (await readdir(this.outboxDir)).filter((f) => f.endsWith(".json")).sort(); } catch { return; }
    for (const file of files) {
      const target = join(this.outboxDir, file);
      let payload: DurableDeliveryPayload;
      try {
        payload = JSON.parse(await readFile(target, "utf8")) as DurableDeliveryPayload;
      } catch {
        continue;
      }
      try {
        const res = await fetch(`${this.baseUrl}/internal/deliveries/ingest`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-bcp-delivery-bridge": "1" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) await unlink(target).catch(() => undefined);
      } catch {
        // The outbox remains for the next timer tick or backend restart.
      }
    }
  }
}

function assertLoopbackUrl(raw: string): void {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`console delivery URL is invalid: ${raw}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("console delivery URL must use http(s)");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("console delivery URL must target loopback");
  }
}
