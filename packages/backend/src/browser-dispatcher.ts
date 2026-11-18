/**
 * BrowserDispatcher — the single entry point for every ordinary browser RPC
 * (MCP tools, InternalRunner, playback, evidence, cleanup). Callers must never
 * reach for RpcBridge / rawCall / ws.callBrowser directly: this class owns the
 * readiness gate (dispatch → ensureBrowserReady → probe → forward).
 *
 * Target selection stays in the callers (MCP session target, run target,
 * backend default) — dispatch takes an already-resolved BrowserTarget. Probe
 * results are cached briefly so a burst of tool calls doesn't re-probe every
 * time; the cache is per-instance and invalidated on disconnect.
 */
import {
  browserError,
  type BrowserError,
  type BrowserProbe,
  type BrowserTarget,
  type RpcContracts,
} from "@bcp/shared";
import { RpcMethod } from "@bcp/shared";
import { BrowserSetupService } from "./browser-setup-service.js";
import { WsServer } from "./ws-server.js";

const PROBE_TTL_MS = 5_000;

export class BrowserDispatcher {
  private readonly probeCache = new Map<string, { at: number; probe: BrowserProbe }>();

  constructor(
    private readonly ws: WsServer,
    private readonly setup: BrowserSetupService,
  ) {}

  /** Three-layer target resolution (spec §3.2): explicit target wins; then the
   * caller's session/run target; then the backend default. Nothing resolvable
   * → target_required (never guess by browser kind). */
  resolveTarget(explicit?: BrowserTarget, sessionTarget?: BrowserTarget | null): BrowserTarget {
    if (explicit) return explicit;
    if (sessionTarget) return sessionTarget;
    const def = this.ws.current();
    if (!def) {
      throw browserError("target_required", "no browser target — call launch_browser / use_browser first (or wait for one to connect)", { retryable: false });
    }
    return def;
  }

  /** The ONLY path for ordinary browser RPCs. Ensures the target is ready
   * (authenticated + probed), then forwards. Never re-probes more often than
   * the TTL. */
  async dispatch<T = unknown>(target: BrowserTarget, method: RpcMethod, params: Record<string, unknown>): Promise<T> {
    await this.ensureReady(target);
    return this.ws.callBrowser<T>(method, params, target);
  }

  /** Typed convenience for contract methods. */
  dispatchRpc<M extends RpcMethod>(target: BrowserTarget, method: M, params: RpcContracts[M]["params"]): Promise<RpcContracts[M]["result"]> {
    return this.dispatch<RpcContracts[M]["result"]>(target, method, params as Record<string, unknown>);
  }

  /** Ensure authenticated session + successful bootstrap probe. The probe is
   * cached per instance for PROBE_TTL_MS so tool bursts don't pay 2 RPCs each. */
  async ensureReady(target: BrowserTarget): Promise<BrowserProbe> {
    if (process.env.BCP_DESKTOP === '1' && !this.ws.isReady(target)) {
      throw browserError('browser_unavailable', 'selected browser is offline; choose or reconnect it in the desktop client', { retryable: true });
    }
    const cached = this.probeCache.get(target.instanceId);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS && cached.probe.ok) {
      return cached.probe;
    }
    await this.setup.ensureBrowserReady(target);
    const probe = await this.bootstrapProbe(target);
    this.probeCache.set(target.instanceId, { at: Date.now(), probe });
    return probe;
  }

  /** The controlled probe path — forwarded to the setup service (which owns
   * the only authenticated list_windows/list_tabs call). No recursion. */
  async bootstrapProbe(target: BrowserTarget): Promise<BrowserProbe> {
    return this.setup.bootstrapProbe(target);
  }

  /** Invalidate a target's probe cache (disconnect, manual re-setup). */
  invalidate(instanceId: string): void {
    this.probeCache.delete(instanceId);
  }

  /** Translate an unknown error into the structured BrowserError shape for
   * API/MCP surfaces that need a code. */
  static toError(e: unknown): BrowserError {
    if (e && typeof e === "object" && "code" in e && typeof (e as BrowserError).code === "string") {
      return e as BrowserError;
    }
    const msg = e instanceof Error ? e.message : String(e);
    const retryable = /timeout|not connected|disconnected|retry/i.test(msg);
    return browserError("internal_error", msg, { retryable });
  }
}
