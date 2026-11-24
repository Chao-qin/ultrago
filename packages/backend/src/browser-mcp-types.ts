/**
 * The injected-collaborator types browser-mcp is built against.
 *
 * Split out so the per-domain tool modules can name `BrowserCall` without
 * importing the registration file that imports them back.
 */
import type { RpcMethod, RpcContracts, BrowserTarget } from "@bcp/shared";
import type { SnapshotView } from "./browser-mcp-render.js";
import type { BrowserDispatcher } from "./browser-dispatcher.js";
import type { BrowserSetupService } from "./browser-setup-service.js";

/** The per-session call wrapper exposed to tool handlers — `target` is
 * optional and falls back to the session target / backend default. */
export type BrowserCall = <M extends RpcMethod>(
  method: M,
  params: RpcContracts[M]["params"],
  target?: BrowserTarget,
) => Promise<RpcContracts[M]["result"]>;

/** The agent's own snapshot read, rendered for the reply (see readSnapshot in browser-mcp.ts). Call `commit` once
 *  the reply carrying `text` is built: until then its refs do not count as shown to the agent, so a tool that fails
 *  after reading never makes the next snapshot claim the agent saw them. */
export type ReadSnapshot = (
  tabId: number | undefined,
  view: SnapshotView,
) => Promise<RpcContracts[typeof RpcMethod.Snapshot]["result"] & { text: string; commit(): void }>;

/** The injected dispatcher call — target REQUIRED (the readiness gate lives
 * in the dispatcher; callers must resolve the target first). */
export type RawBrowserCall = <M extends RpcMethod>(
  method: M,
  params: RpcContracts[M]["params"],
  target: BrowserTarget,
) => Promise<RpcContracts[M]["result"]>;

/** Connected-browser registry (injected: backed by the WsServer's session
 * table). Everything is keyed by BrowserTarget — a label is display only. */
export interface BrowserRegistry {
  list(): Array<{ kind: "chrome" | "firefox"; instanceId: string; connectedAt: number; current: boolean; mode: "auto" | "manual"; ready: boolean }>;
  /** Throws (listing what IS connected) unless target is live. */
  validate(target: BrowserTarget): void;
  /** Global default target — what sessions without use_browser follow. */
  current(): BrowserTarget | null;
  getMode(instanceId: string): "auto" | "manual";
  setMode(target: BrowserTarget, mode: "auto" | "manual"): void;
  /** Shared claim registry — the cross-session view that lets agents see who
   * has claimed which tab (each session's own claim is otherwise private). */
  setClaim(sessionId: string, target: BrowserTarget, tabId: number, since: number): void;
  clearClaim(sessionId: string): void;
  listClaims(): Array<{ sessionId: string; instanceId: string; tabId: number; since: number }>;
}

/**
 * The Single Source of Truth for browser tools. Served over Streamable HTTP so
 * any MCP client (Claude Code, etc.) consumes the exact same tools via MCP.
 * Every handler forwards to the extension over WS-RPC (pure chrome.* APIs; no CDP).
 */
/** Browser-lifecycle surfaces injected so the MCP layer can offer
 * launch_browser / stop_browser / browser_status and route through the
 * dispatcher's readiness gate. */
export interface BrowserLifecycle {
  dispatcher: BrowserDispatcher;
  setup: BrowserSetupService;
}
