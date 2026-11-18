import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { ParamMap } from "@bcp/shared";

const DEFAULT_BACKEND_INTERNAL = "http://127.0.0.1:8789";

/** Talks to backend's /internal/* HTTP API. The console itself doesn't drive
 *  the browser — the backend still owns the extension WS. The console is a
 *  loopback HTTP client of the backend's InternalRunner, polling for status
 *  and queuing runs. */
@Injectable()
export class BackendClient implements OnModuleInit {
  private readonly logger = new Logger(BackendClient.name);
  private baseUrl = DEFAULT_BACKEND_INTERNAL;

  onModuleInit(): void {
    this.baseUrl = process.env.BCP_INTERNAL_URL || DEFAULT_BACKEND_INTERNAL;
    this.logger.log(`backend internal: ${this.baseUrl}`);
  }

  /** Cheap liveness check used by /api/health and the console's startup probe. */
  async health(): Promise<{ ok: boolean; plans?: number; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/internal/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const body = (await res.json()) as { ok: boolean; plans: number };
      return { ok: !!body.ok, plans: body.plans };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Start a playbook run on the backend. Returns the planId immediately;
   *  the run executes async on the backend side, polled via getRun().
   *  `playbookJson` is the full JSON content of the playbook — the backend
   *  uses it instead of loading from disk, so the console is the SSOT. */
  async startRun(input: {
    name: string;
    params: ParamMap;
    mode: "assisted" | "auto";
    trigger?: "manual" | "schedule" | "mcp";
    runId?: string;
    planId?: string;
    timezone?: string;
    /** Full playbook JSON (the raw file content). When provided, the
     *  backend skips loadPlaybook() and uses this directly. */
    playbookJson?: string;
  }): Promise<{ planId: string; status: string; totalSteps: number; currentGoal: string | null }> {
    const res = await fetch(`${this.baseUrl}/internal/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    if (!res.ok) {
      throw new Error(body.error ?? `backend returned HTTP ${res.status}`);
    }
    return {
      planId: String(body.planId),
      status: String(body.status),
      totalSteps: Number(body.totalSteps ?? 0),
      currentGoal: (body.currentGoal as string | null) ?? null,
    };
  }

  /** Pull the live state of a run. Polled from RunDetail and the dispatcher. */
  async getRun(planId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/internal/run/${encodeURIComponent(planId)}`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    if (!res.ok) {
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return body;
  }

  async cancelRun(planId: string): Promise<{ ok: boolean; status: string }> {
    const res = await fetch(`${this.baseUrl}/internal/run/${encodeURIComponent(planId)}/cancel`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return { ok: true, status: String(body.status ?? "cancelled") };
  }

  async getStepResult(planId: string, resultId: string): Promise<{ raw: string; upstreamTruncated: boolean } | undefined> {
    const res = await fetch(`${this.baseUrl}/internal/run/${encodeURIComponent(planId)}/results/${encodeURIComponent(resultId)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`step result returned HTTP ${res.status}`);
    const body = await res.json() as { raw?: unknown; upstreamTruncated?: unknown };
    if (typeof body.raw !== 'string' || typeof body.upstreamTruncated !== 'boolean') throw new Error('invalid step result response');
    return { raw: body.raw, upstreamTruncated: body.upstreamTruncated };
  }

  /* ------------------------- browser lifecycle ------------------------- */

  private lifecycleHeaders(): Record<string, string> {
    // Spec §12: /internal/browsers/setup|stop require X-BCP-Internal-Token.
    // Read the same env the backend uses; the default matches the backend's
    // default so dev works out of the box.
    return {
      "content-type": "application/json",
      "x-bcp-internal-token": process.env.BCP_INTERNAL_TOKEN || "bcp-internal-dev-token",
    };
  }

  /** Read-only lifecycle status (never starts a browser). */
  async browserStatus(selector?: { kind?: "chrome" | "firefox"; instanceId?: string }) {
    const qs = new URLSearchParams();
    if (selector?.kind) qs.set("kind", selector.kind);
    if (selector?.instanceId) qs.set("instanceId", selector.instanceId);
    const res = await fetch(`${this.baseUrl}/internal/browsers/status?${qs}`, {
      headers: { "x-bcp-internal-token": process.env.BCP_INTERNAL_TOKEN || "bcp-internal-dev-token" },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `backend returned HTTP ${res.status}`);
    return body;
  }

  /** Start/reuse a browser instance + wait for the ready ack (lifecycle mutation).
   *  mode 缺省 "user"（安全默认）。 */
  async browserSetup(input: { kind: "chrome" | "firefox"; mode?: "user" | "managed"; instanceId?: string; waitMs?: number }) {
    const res = await fetch(`${this.baseUrl}/internal/browsers/setup`, {
      method: "POST",
      headers: this.lifecycleHeaders(),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(320_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `backend returned HTTP ${res.status}`);
    return body;
  }

  /** Stop a backend-owned managed instance (lifecycle mutation). */
  async browserStop(input: { kind: "chrome" | "firefox"; instanceId: string }) {
    const res = await fetch(`${this.baseUrl}/internal/browsers/stop`, {
      method: "POST",
      headers: this.lifecycleHeaders(),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `backend returned HTTP ${res.status}`);
    return body;
  }
}
