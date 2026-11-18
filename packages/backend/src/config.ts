import path from "node:path";
import os from "node:os";
import dotenv from "dotenv";
import { DEFAULT_PORT, runtimePort } from "@bcp/shared";

if (process.env.BCP_DESKTOP !== '1') dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true });

/** A switch is on for "on", "1", "true" or "yes" in any case. Users write all of these; accepting only one
 * spelling silently left the switch off for everyone who chose another. */
export function envFlag(value: string | undefined): boolean {
  return /^(on|1|true|yes)$/i.test((value ?? "").trim());
}

/** How to turn page eval on, for every error that refuses it. The desktop client starts the backend itself,
 * so an env entry in an assistant's MCP config never reaches the process that checks it. */
export const EVAL_DISABLED = "page JS (eval) is disabled. Desktop client: turn on 「允许页面脚本」 under 准备与连接. Otherwise start the backend with BCP_EVAL=on (on/1/true/yes).";

/** Same for local.eval steps, which run in this backend process (node:vm, not a hard boundary). */
export const LOCAL_EVAL_DISABLED = "backend JS (local.eval) is disabled. Desktop client: turn on 「允许本机脚本」 under 准备与连接. Otherwise start the backend with BCP_LOCAL_EVAL=on (on/1/true/yes).";

/** Runtime config, all overridable via env. */
export const config = {
  port: runtimePort(process.env.BCP_PORT, DEFAULT_PORT),
  /** Host the extension WS binds to. Loopback by default; set BCP_HOST=0.0.0.0
   * to expose it on the network so a REMOTE browser can reach this box directly
   * (bypassing an SSH tunnel / VS Code port-forward). The token gates who can
   * drive; set a real BCP_TOKEN when the network isn't fully trusted. The MCP
   * endpoint deliberately stays loopback (it carries no token). */
  host: process.env.BCP_HOST || "127.0.0.1",
  /** Streamable-HTTP MCP endpoint port (every MCP client connects here). */
  mcpPort: runtimePort(process.env.BCP_MCP_PORT, 8788),
  get mcpUrl(): string {
    return `http://127.0.0.1:${this.mcpPort}/mcp`;
  },
  /** Shared secret the extension must present in its `hello` frame. */
  token: process.env.BCP_TOKEN || "bcp-dev-token",
  /** RPC timeout (ms) for a single browser action. */
  rpcTimeoutMs: Number(process.env.BCP_RPC_TIMEOUT_MS) || 30_000,
  /** Optional navigation boundary. Empty allowlist = allow all (minus blocklist). */
  allowedDomains: csv(process.env.BCP_ALLOWED_DOMAINS),
  blockedDomains: csv(process.env.BCP_BLOCKED_DOMAINS),
  /** Gate the arbitrary-JS `eval` tool. Off by default (arbitrary page JS is a
   * big blast radius); set BCP_EVAL=on to enable it. Read on every call, so the desktop
   * client can switch it at runtime (see /internal/browsers/policy). */
  get evalEnabled(): boolean { return envFlag(process.env.BCP_EVAL); },
  /** Gate the `local.eval` playbook step (arbitrary JS run in the BACKEND
   * Node process, not a browser sandbox — bigger blast radius than page
   * eval). Off by default; set BCP_LOCAL_EVAL=on to enable it. Read on every call, so the desktop
   * client can switch it at runtime (see /internal/browsers/policy). */
  get localEvalEnabled(): boolean { return envFlag(process.env.BCP_LOCAL_EVAL); },
  /** When on (BCP_FORCE_PLAN=on), mutating browser actions are REFUSED unless the
   * session has an active plan — turning the opt-in plan/advance gate into a hard
   * requirement (you must declare a verifiable plan before you can change the
   * page). Off by default; the gate stays opt-in. */
  get forcePlan(): boolean { return envFlag(process.env.BCP_FORCE_PLAN); },
  /** Set BCP_WECLAW_DISABLE=1 to skip the weclaw sidecar (useful for tests). */
  weclawDisabled: envFlag(process.env.BCP_WECLAW_DISABLE),
  /** Optional realtime webhook for the few events that are only actionable
   * while they are happening (a challenge appearing / clearing, a browser
   * going away). Empty = disabled, and then nothing is subscribed or sent.
   * NOT SSRF-checked, unlike a book's webhook delivery: that URL can come from
   * a book someone else wrote, this one comes from THIS machine's env — and a
   * loopback receiver is the expected case, so the check would reject the
   * normal setup. */
  eventWebhook: process.env.BCP_EVENT_WEBHOOK || "",
  /** Shared secret for the loopback internal HTTP lifecycle endpoints
   * (/internal/browsers/setup|stop). The console reads the same env var with
   * the same default — keep the default in sync with console's BackendClient. */
  internalToken: process.env.BCP_INTERNAL_TOKEN || "bcp-internal-dev-token",
  /** Backend-owned root for managed browser profiles + extension artifacts.
   * Only backend-created directories live here; instanceIds are format-validated
   * before joining paths. */
  browserRoot: process.env.BCP_BROWSER_ROOT || path.join(os.homedir(), ".bcp", "browser"),
  /** Built extension output to package into managed/user artifacts. Auto-detected
   * from the monorepo when unset (packages/extension/.output). */
  extensionDir: process.env.BCP_EXTENSION_DIR || "",
  serverVersion: "0.1.0",
} as const;

function csv(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Enforce the navigation boundary against a URL's hostname. */
export function domainAllowed(url: string): { ok: boolean; reason?: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: true }; // relative URL — the browser resolves it against the (already-gated) current page
  }
  const scheme = u.protocol.replace(":", "").toLowerCase();
  // Fail closed on script/exfil-capable schemes regardless of allow/blocklist.
  if (["javascript", "data", "file", "blob", "vbscript"].includes(scheme)) {
    return { ok: false, reason: `${scheme}: URLs are not permitted` };
  }
  const host = u.hostname.toLowerCase();
  const matches = (d: string) => host === d || host.endsWith("." + d);
  if (config.blockedDomains.some(matches)) return { ok: false, reason: `${host} is blocked (BCP_BLOCKED_DOMAINS)` };
  if (config.allowedDomains.length && !config.allowedDomains.some(matches))
    return { ok: false, reason: `${host} is not in the allowlist (BCP_ALLOWED_DOMAINS)` };
  return { ok: true };
}
