/**
 * Browser lifecycle domain — SSOT for the "browser readiness & extension
 * install" contract (spec: docs/superpowers/specs/2026-08-23-browser-readiness-
 * and-extension-install-design.md).
 *
 * A browser KIND ("chrome" / "firefox") is NOT an instance identity. Every
 * connection, bridge, claim, event and browser run is keyed by an immutable
 * BrowserTarget { kind, instanceId }. The profile mode (user / managed) is a
 * backend-side instance property — never trusted from the extension.
 *
 * Types-only + constants module (no runtime deps): safe to import from the
 * backend, the extension bundle, and the console.
 */

/** Chrome or Firefox — the only browser kinds the backend can drive. */
export type BrowserKind = "chrome" | "firefox";

/** user = the user's own profile (backend never claims ownership); managed =
 * a dedicated profile the backend created and owns. */
export type BrowserProfileMode = "user" | "managed";

/** Globally-unique instance identity. Format: [a-z0-9][a-z0-9._-]{0,63}.
 * Backend generates one in `setup` when the caller omits it; the extension
 * presents the same id it received via its runtime config. */
export interface BrowserTarget {
  kind: BrowserKind;
  instanceId: string;
}

/** Optional kind / instanceId filter for status queries. */
export interface BrowserSelector {
  kind?: BrowserKind;
  instanceId?: string;
}

const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Format-validate an instanceId BEFORE it is used to build paths or registry
 * keys. An invalid id must never reach path concatenation (path traversal). */
export function isValidInstanceId(id: string): boolean {
  return INSTANCE_ID_RE.test(id);
}

/** Chrome flags that keep a window rendering while other windows cover it.
 * Without them Chrome stops painting an occluded window: animations freeze on
 * their first frame, React commits stall, screenshots come back blank — and a
 * task window is behind the user's own windows by design. Playwright and
 * Puppeteer pass the second flag by default; the first is Windows' occlusion
 * calculation. They only take effect when Chrome STARTS with them. */
export const CHROME_RENDERING_FLAGS = [
  "--disable-features=CalculateNativeWinOcclusion",
  "--disable-backgrounding-occluded-windows",
] as const;

/** How a target is named in tool replies and errors: kind plus the FULL
 * instanceId. Agents copy ids out of these replies into use_browser /
 * set_browser_mode / stop_browser, which match the id exactly — a shortened
 * id there is an id that does not work. */
export function browserLabel(target: BrowserTarget): string {
  return `${target.kind}:${target.instanceId}`;
}

/* ------------------------------------------------------------------ *
 * Readiness states                                                    *
 * ------------------------------------------------------------------ */

export type BrowserReadiness =
  | "not_configured"
  | "executable_missing"
  | "unsupported"
  | "stopped"
  | "starting"
  | "waiting_extension"
  | "connected"
  | "browser_probe_failed"
  | "protocol_incompatible"
  | "auth_rejected"
  | "stopping"
  | "crashed"
  | "failed";

/** Executable discovery output — NOT a browser instance. */
export interface BrowserExecutableCandidate {
  kind: BrowserKind;
  path: string;
  source: "configured" | "standard_path" | "path";
  version?: string;
  usable: boolean;
  error?: BrowserError;
}

export interface BrowserInstanceRef {
  target: BrowserTarget;
  profileMode: BrowserProfileMode;
}

export interface BrowserStatus {
  instance: BrowserInstanceRef;
  readiness: BrowserReadiness;
  executable?: BrowserExecutableCandidate;
  pid?: number;
  profileDir?: string;
  extension?: {
    connected: boolean;
    clientName?: string;
    clientVersion?: string;
    artifactHash?: string;
    protocolVersion?: number;
    sessionId?: string;
    connectedAt?: number;
  };
  probe?: { windows?: number; tabs?: number; ok: boolean };
  lastError?: BrowserError;
  checkedAt: number;
}

export interface BrowserStatusResponse {
  defaultTarget?: BrowserTarget;
  candidates: BrowserExecutableCandidate[];
  instances: BrowserStatus[];
}

/* ------------------------------------------------------------------ *
 * Structured errors                                                   *
 * ------------------------------------------------------------------ */

export type BrowserErrorCode =
  | "target_required"
  | "browser_unavailable"
  | "executable_missing"
  | "executable_invalid"
  | "unsupported"
  | "profile_invalid"
  | "profile_locked"
  | "ownership_conflict"
  | "port_conflict"
  | "startup_timeout"
  | "extension_timeout"
  | "auth_rejected"
  | "protocol_incompatible"
  | "target_mismatch"
  | "artifact_mismatch"
  | "browser_probe_failed"
  | "foreign_process"
  | "stop_rejected"
  | "internal_error";

export interface BrowserError {
  code: BrowserErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, string | number | boolean>;
}

/** Construct a BrowserError with sane defaults. */
export function browserError(
  code: BrowserErrorCode,
  message: string,
  extra?: Partial<BrowserError>,
): BrowserError {
  return { code, message, retryable: extra?.retryable ?? false, ...extra };
}

/* ------------------------------------------------------------------ *
 * Setup / readiness service contract (wire shape)                     *
 * ------------------------------------------------------------------ */

export interface BrowserSetupRequest {
  kind: BrowserKind;
  /** Default "user" — the safe default: a user-profile instance is never
   * owned/stopped by the backend. "managed" is opt-in (dedicated backend-owned
   * profile; chrome only). */
  mode?: BrowserProfileMode;
  instanceId?: string;
  waitMs?: number;
}

export interface BrowserSetupResult {
  target: BrowserTarget;
  status: BrowserStatus;
  ready: boolean;
  operationId: string;
}

export interface BrowserProbe {
  windows?: number;
  tabs?: number;
  ok: boolean;
  error?: BrowserError;
}

export interface ReadyBrowser {
  target: BrowserTarget;
  status: BrowserStatus;
  probe: BrowserProbe;
}

/* ------------------------------------------------------------------ *
 * Extension runtime config — generated by the backend into the        *
 * artifact staging directory at build time; the extension reads it at *
 * startup. Never passed through browser argv.                         *
 * ------------------------------------------------------------------ */

export interface ExtensionRuntimeConfig {
  backendUrl: string;
  token: string;
  browser: BrowserKind;
  instanceId: string;
  artifactHash: string;
}

/* ------------------------------------------------------------------ *
 * Managed ownership manifest                                         *
 * ------------------------------------------------------------------ */

export interface ManagedManifest {
  ownerId: string;
  backendPid: number;
  backendStartTime: number;
  browserPid?: number;
  browserStartTime?: number;
  target: BrowserTarget;
  profileDir: string;
  artifactHash: string;
  createdAt: number;
}
