/**
 * Intra-extension messaging shapes (SSOT).
 *
 *   sidepanel / popup  <-- chrome.runtime -->  service worker
 *
 * DOM ops + the overlay are injected on demand via chrome.scripting (see
 * dom-runtime.ts) — there is no persistent content script. These shapes are
 * distinct from the WS wire protocol in @bcp/shared, which governs the
 * service-worker <-> backend link.
 *
 * The extension is a pure browser executor: the side panel is just a
 * connection status + settings surface, so these shapes only cover connection
 * state and settings — no chat/task/agent traffic.
 *
 * `RpcErrorInfo` is the one type shared with the wire protocol, and deliberately
 * so: it is produced here and consumed by the backend unchanged, so a second
 * definition would be a second thing to keep in step. Everything else in this
 * file stays local.
 */
import type { RpcErrorInfo } from "@bcp/shared";

export interface Settings {
  backendUrl: string;
  token: string;
}

export const DEFAULT_SETTINGS: Settings = {
  // 127.0.0.1 (not "localhost"): on dual-stack hosts "localhost" resolves to
  // ::1 first, and the backend WS binds IPv4 loopback only (ws-server.ts) — so
  // "localhost" makes Firefox try [::1]:8787 and fail where Chrome falls back to
  // IPv4. Pinning IPv4 matches the MCP endpoint URL used everywhere else.
  backendUrl: "ws://127.0.0.1:8787",
  token: "bcp-dev-token",
};

export type ConnState = "disconnected" | "connecting" | "connected";

/* ---- sidepanel -> service worker ---- */
export type UiToSw =
  | { kind: "interrupt" }
  | { kind: "getState" }
  | { kind: "saveSettings"; settings: Settings };

/* ---- service worker -> sidepanel ---- */
export type SwToUi =
  | { kind: "state"; conn: ConnState; settings: Settings; instanceId?: string; desktopManaged?: boolean }
  | { kind: "conn"; conn: ConnState };

/** Result of a browser RPC dispatched by the service worker. */
export type ExecResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string; errorInfo?: RpcErrorInfo };
