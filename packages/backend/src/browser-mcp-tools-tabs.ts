/**
 * Navigation, tabs and windows.
 *
 * Split out of browser-mcp.ts. These read the session's claim (closing the
 * claimed tab has to drop it) but never assign to it — the one read is routed
 * through `getClaimed` so the group sees the session's live value rather than
 * a copy frozen at registration time.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RpcMethod, type BrowserTarget, type TabInfo } from "@bcp/shared";
import { domainAllowed } from "./config.js";
import type { BrowserCall } from "./browser-mcp-types.js";
import { fail, gateNote, text, windowFocusLabel, windowFocusLegend } from "./browser-mcp-render.js";
import { looseBool, tabId } from "./browser-mcp-shapes.js";
import { registerRpcTool } from "./browser-mcp-tool-spec.js";

/** The session's claim, as this group needs to see it. */
export type Claim = { target: BrowserTarget | null; tabId: number } | null;

export interface TabsToolDeps {
  server: McpServer;
  call: BrowserCall;
  resolvedTarget: () => BrowserTarget | null;
  claimFor: (target: BrowserTarget | null) => number | undefined;
  setClaimed: (next: Claim) => void;
  /** Live read — NOT a value, or closing the claimed tab would consult a stale one. */
  getClaimed: () => Claim;
  drainEvents: (onTab?: number) => string;
}

/** Registers navigate / new_tab / close_tab / new_window / close_window / list_windows. */
export function registerTabsTools({ server, call, resolvedTarget, claimFor, setClaimed, getClaimed, drainEvents }: TabsToolDeps): void {
  registerRpcTool(
    server,
    RpcMethod.Navigate,
    { url: z.string(), tabId },
    async ({ url, tabId }) => {
      try {
        const d = domainAllowed(url);
        if (!d.ok) return fail(d.reason);
        const r = await call(RpcMethod.Navigate, { url, tabId });
        // Asked-vs-got, the same shape type_text's valueMismatch reports. The navigation barrier resolves when
        // the tab reaches `complete`, WHATEVER document that turned out to be, so a login / consent / regional
        // redirect lands here as an ordinary success and every later action silently applies to a page the
        // caller never asked for. Compare host (www-insensitive) + path (trailing-slash-insensitive) only:
        // scheme upgrades and query/hash rewrites are not a different page and reporting them would be noise.
        let landed = "";
        try {
          const a = new URL(url), b = new URL(r.url);
          const host = (u: URL) => u.hostname.replace(/^www\./, "");
          const path = (u: URL) => u.pathname.replace(/\/+$/, "");
          if (host(a) !== host(b) || path(a) !== path(b))
            landed =
              `\n⚠ this is NOT the URL you asked for (${url}) — the site redirected. You are on ${r.url}, and ` +
              `everything you do next applies to THAT page. Re-issuing the same navigate normally lands here ` +
              `again: deal with what actually loaded (sign-in / consent / region wall), or reach the target from ` +
              `a link on this page.`;
        } catch {
          /* a URL the parser rejects is the caller's problem, not a redirect */
        }
        return text(`Navigated to ${r.url} (tab ${r.tabId}) — "${r.title}"${landed}${gateNote("navigated to a new page")}${drainEvents(r.tabId)}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.NewTab,
    {
      url: z.string().optional(),
      active: looseBool.optional(),
      claim: looseBool.optional(),
    },
    async ({ url, active, claim }) => {
      try {
        if (url) {
          const d = domainAllowed(url);
          if (!d.ok) return fail(d.reason);
        }
        // Freeze the target BEFORE the await: a failover during NewTab would make
        // resolvedTarget() return a different browser than the tab was created in,
        // binding the claim to the wrong browser (cross-instance tabId collision).
        const claimTgt = resolvedTarget();
        const r = await call(RpcMethod.NewTab, { url, active: active ?? false });
        if (claim) setClaimed({ target: claimTgt, tabId: r.tabId });
        return text(`Opened tab ${r.tabId}${r.url ? ` at ${r.url}` : ""}${claim ? " (claimed as this session's default)" : ""}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.CloseTab,
    { tabId },
    async ({ tabId }) => {
      try {
        // Resolve the target before the await so the post-close claim check
        // matches the browser the close actually routed to (not a failed-over one).
        const tgt = resolvedTarget();
        const r = await call(RpcMethod.CloseTab, { tabId });
        // An extension older than this backend does not report the id; fall back to what we sent.
        const closed = r.tabId ?? tabId ?? claimFor(tgt);
        // Drop a dangling claim if we just closed the claimed tab (explicitly,
        // or via the claim-default injection that call() applied for us).
        const held = getClaimed();
        if (held && closed === held.tabId && held.target?.instanceId === tgt?.instanceId) {
          setClaimed(null);
        }
        const why = tabId != null ? "" : held && closed === held.tabId ? " (this session's claimed tab — the claim is released)" : " (the active tab of the last-focused window)";
        return text(closed != null ? `Closed tab ${closed}${why}` : "Closed the active tab of the last-focused window");
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.NewWindow,
    {
      url: z.string().optional(), focused: looseBool.optional(), minimized: looseBool.optional(),
      left: z.coerce.number().optional(), top: z.coerce.number().optional(),
      width: z.coerce.number().optional(), height: z.coerce.number().optional(),
      restoreFocus: looseBool.optional(),
    },
    async ({ url, focused, minimized, left, top, width, height, restoreFocus }) => {
      try {
        if (url) {
          const d = domainAllowed(url);
          if (!d.ok) return fail(d.reason);
        }
        const r = await call(RpcMethod.NewWindow, { url, focused, minimized, left, top, width, height, restoreFocus });
        const b = r.bounds;
        // Report where it ACTUALLY landed: Chrome clamps off-screen coordinates
        // on some platforms, and asking is the only way to find out.
        const where = b ? ` @ ${b.left},${b.top} ${b.width}x${b.height} (${b.state})` : "";
        return text(`Opened window ${r.windowId}, tab ${r.tabId}${r.url ? ` at ${r.url}` : ""}${where}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.CloseWindow,
    { windowId: z.coerce.number().optional() },
    async ({ windowId }) => {
      try {
        const r = await call(RpcMethod.CloseWindow, { windowId });
        const closed = r.windowId ?? windowId;
        return text(closed != null ? `Closed window ${closed}${windowId != null ? "" : " (the last-focused window)"}` : "Closed the last-focused window");
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.ListWindows,
    {},
    async () => {
      try {
        const { windows, focusedWindowId, lastFocusedWindowId } = await call(RpcMethod.ListWindows, {});
        if (!windows.length) return text("(no windows)");
        const blocks = windows.map((w) => {
          const head = `window ${w.windowId}${windowFocusLabel(w.windowId, focusedWindowId, lastFocusedWindowId)}${w.state && w.state !== "normal" ? ` [${w.state}]` : ""}`;
          const rows = w.tabs.map((t) => `    ${t.id === w.activeTabId ? "*" : " "} [${t.id}] ${t.title} — ${t.url}`).join("\n");
          return `${head}\n${rows}`;
        });
        return text(`${blocks.join("\n\n")}\n\n${windowFocusLegend(windows.length, focusedWindowId)}`);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
