/**
 * Which browser this session drives, and which tab it owns.
 *
 * Split out of browser-mcp.ts. This is the group that WRITES the session's
 * routing state, so target and claim are reached through accessors rather than
 * captured: `use_browser` and `launch_browser` move the value every other tool
 * group routes by.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RpcMethod, browserLabel, type BrowserStatus, type BrowserTarget } from "@bcp/shared";
import type { BrowserCall, BrowserLifecycle, BrowserRegistry, RawBrowserCall } from "./browser-mcp-types.js";
import type { Claim } from "./browser-mcp-tools-tabs.js";
import { fail, text, windowFocusLabel } from "./browser-mcp-render.js";
import { looseBool, tabId } from "./browser-mcp-shapes.js";

export interface LifecycleToolDeps {
  server: McpServer;
  call: BrowserCall;
  rawCall: RawBrowserCall;
  browsers?: BrowserRegistry;
  lifecycle?: BrowserLifecycle;
  deltaKey: string;
  resolvedTarget: () => BrowserTarget | null;
  isUserVisibleTab: (target: BrowserTarget, tabIdArg: number) => Promise<boolean>;
  getSessionTarget: () => BrowserTarget | null;
  /** Moves what every other group routes by — hence a setter, not a value. */
  setSessionTarget: (next: BrowserTarget | null) => void;
  getClaimed: () => Claim;
  setClaimed: (next: Claim) => void;
}

/** Registers use_browser / claim_tab / set_browser_mode with a browser
 *  registry, launch_browser / stop_browser with the lifecycle services, and
 *  browser_state — the one status view — with either. */
export function registerLifecycleTools({
  server, call, rawCall, browsers, lifecycle, deltaKey, resolvedTarget, isUserVisibleTab,
  getSessionTarget, setSessionTarget, getClaimed, setClaimed,
}: LifecycleToolDeps): void {
  if (browsers) {
    server.registerTool(
      "use_browser",
      {
        description:
          "Point THIS session's tools at a specific browser INSTANCE (kind + full instanceId from browser_state). Session-scoped: other MCP sessions keep their own targets, so several agents can drive different instances concurrently without fighting. Omit instanceId to use the global default when it is that kind; outside the desktop client it otherwise falls back to the first connected instance of that kind (the desktop client only drives its own browser).",
        inputSchema: {
          kind: z.enum(["chrome", "firefox"]).describe('Browser kind, e.g. "chrome"'),
          instanceId: z.string().optional().describe("Full instance id from browser_state; omit to use the default instance of that kind"),
        },
      },
      async ({ kind, instanceId }) => {
        try {
          const list = browsers.list();
          const desktopDefault = process.env.BCP_DESKTOP === '1' ? browsers.current() : null;
          const target: BrowserTarget | null = instanceId
            ? { kind, instanceId }
            : process.env.BCP_DESKTOP === '1'
              ? desktopDefault?.kind === kind ? desktopDefault : null
              : (list.find((b) => b.kind === kind && b.current) ?? list.find((b) => b.kind === kind) ?? null);
          if (!target) return fail(new Error(`no ${kind} instance connected — launch_browser it first or open the extension`));
          browsers.validate(target);
          const prev = resolvedTarget();
          setSessionTarget(target);
          // A claim is tab-in-THAT instance; carrying it across would inject a
          // foreign tabId (per-instance small ints collide) into the new target.
          let note = "";
          const prevClaim = getClaimed();
          if (prevClaim && prevClaim.target?.instanceId !== target.instanceId) {
            setClaimed(null);
            note = prev?.instanceId === target.instanceId ? "" : " Previous tab claim released (it belonged to another browser — claim_tab again here if needed).";
          }
          return text(`This session now drives ${browserLabel(target)} (other sessions are unaffected).${note}`);
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "claim_tab",
      {
        description:
          "Claim a tab as THIS session's default workspace: tools that omit tabId then target the claimed tab instead of the active tab of the last-focused window. Essential when several agent sessions — or the agent and the user — share one browser. release:true reverts to the active-tab default.",
        inputSchema: {
          tabId: z.coerce.number().optional().describe("Tab to claim (from list_windows / new_tab); omit to claim the active tab of the last-focused window"),
          release: looseBool.optional().describe("true = release the claim instead"),
        },
      },
      async ({ tabId, release }) => {
        try {
          if (release) {
            setClaimed(null);
            return text("Claim released — tools without tabId target the visible tab again.");
          }
          const tgt = resolvedTarget();
          let id = tabId;
          // In manual mode, never let the claim point at the user's visible tab —
          // whether default-claimed (id omitted) or explicitly passed. Otherwise
          // later tabId-less ops would inject it and drive the user's own page.
          if (browsers && tgt && browsers.getMode(tgt.instanceId) === "manual") {
            const label = browserLabel(tgt);
            if (id == null) {
              return fail(
                new Error(
                  `browser "${label}" is in manual mode — claim_tab needs an explicit tabId of an agent-created background tab (new_tab with claim:true).`,
                ),
              );
            }
            if (await isUserVisibleTab(tgt, id)) {
              return fail(
                new Error(
                  `browser "${label}" is in manual mode — tab ${id} is the user's currently-visible tab; claiming it would let agents drive the page they're looking at. Claim an agent-created background tab instead.`,
                ),
              );
            }
          }
          if (id == null) {
            // The same tab every tabId-less tool falls back to: the active tab
            // of the last-focused window (not "the" visible tab — each window
            // has one).
            const { windows, focusedWindowId, lastFocusedWindowId } = await call(RpcMethod.ListWindows, {});
            const win = windows.find((w) => w.windowId === (focusedWindowId ?? lastFocusedWindowId));
            if (win?.activeTabId == null) return fail(new Error("no last-focused window with an active tab — pass tabId explicitly (list_windows lists them)"));
            id = win.activeTabId;
          }
          setClaimed({ target: tgt, tabId: id });
          const conflict = browsers?.listClaims().find((c) => c.sessionId !== deltaKey && c.instanceId === tgt?.instanceId && c.tabId === id);
          return text(`Claimed tab ${id} (${tgt ? browserLabel(tgt) : "default browser"}) for this session — tools without tabId now target it.${conflict ? `\n⚠ another session (${conflict.sessionId}) also claims this tab — you may be about to collide.` : ""}`);
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "set_browser_mode",
      {
        description:
          "Mark a browser INSTANCE as manual (the user is personally driving it) or auto (agents may drive freely). In manual mode agents cannot switch its tabs or act on the tab the user is looking at: a tool that omits tabId (and has no claimed tab) is refused — only page_state, snapshot, read_content and read_network may still read that tab — new_tab opens in the background, and screenshots never re-foreground. Set manual when the user says they're using that browser themselves.",
        inputSchema: {
          kind: z.enum(["chrome", "firefox"]).describe("Browser kind"),
          instanceId: z.string().describe("Full instance id from browser_state"),
          mode: z.enum(["auto", "manual"]).describe('"manual" = the user is driving this browser; "auto" = agents may drive it freely'),
        },
      },
      async ({ kind, instanceId, mode }) => {
        try {
          const target: BrowserTarget = { kind, instanceId };
          browsers.setMode(target, mode);
          const label = browserLabel(target);
          return text(
            mode === "manual"
              ? `${label} is now MANUAL: its visible tab belongs to the user — agents work only in explicitly-addressed background tabs.`
              : `${label} is now AUTO: agents may switch tabs and re-foreground for screenshots.`,
          );
        } catch (e) {
          return fail(e);
        }
      },
    );

  }

  // ── Browser lifecycle (readiness / launch / stop) — spec §11.2 ────────────
  // Registered only when the lifecycle services are injected (production
  // wiring always passes them; tests/other entry points without them simply
  // don't expose the tools — no crash on first use).
  const statusText = (s: BrowserStatus): string => {
    const ext = s.extension ? `, extension ${s.extension.clientName ?? "?"}@${s.extension.clientVersion ?? "?"}${s.extension.artifactHash ? ` (${s.extension.artifactHash.slice(0, 8)})` : ""}` : "";
    const probe = s.probe ? `, windows=${s.probe.windows ?? "?"} tabs=${s.probe.tabs ?? "?"}` : "";
    return `${browserLabel(s.instance.target)} (${s.instance.profileMode}) → ${s.readiness}${ext}${probe}${s.lastError ? `, error: ${s.lastError.code} — ${s.lastError.message}` : ""}`;
  };

  if (lifecycle) {
    server.registerTool(
      "launch_browser",
      {
      description:
        "Start (or reuse) a browser instance for automation and WAIT for its extension to complete the handshake (hello→welcome→ready). Omit instanceId to reuse the connected instance of that kind and mode, else the one already set up here, else to create a new one. user mode (default): opens your real browser normally; when its extension does not connect within a short grace window, the install guide (chrome://extensions + the extension build to load) opens. managed mode: launches a dedicated backend-owned profile with the extension pre-loaded. Returns the target (kind + full instanceId) + readiness, and makes it this session's target when ready. Idempotent: an already-ready instance returns immediately. Default wait 30s, max 5min.",
        inputSchema: {
          kind: z.enum(["chrome", "firefox"]).describe("Browser kind"),
          mode: z.enum(["user", "managed"]).optional().describe("user = your own profile (default, never owned by the backend); managed = dedicated backend-owned profile (chrome only)"),
          instanceId: z.string().optional().describe("Full instance id to start or reuse; omit to reuse the connected/known instance of this kind and mode, or create one"),
          waitMs: z.coerce.number().optional().describe("Max wait for the ready ack, ms (default 30000)"),
        },
      },
      async ({ kind, mode, instanceId, waitMs }) => {
        try {
          const result = await lifecycle.setup.setup({ kind, mode: mode ?? "user", instanceId, waitMs });
          // A ready launch also fixes this session's target (so subsequent tools
          // route here without an explicit use_browser).
          if (result.ready && result.status.probe?.ok) {
            setSessionTarget(result.target);
          }
          return text(
            `launch_browser: ${statusText(result.status)}${result.ready ? "\nReady — this session now drives it." : "\nNot ready yet — check browser_state / open the side panel."}`,
          );
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "stop_browser",
      {
        description:
          "Stop a MANAGED browser instance (the dedicated profile the backend launched). Only backend-owned managed instances can be stopped — user-profile instances are never touched. Requires confirm:true (irreversible external process control).",
        inputSchema: {
          kind: z.enum(["chrome", "firefox"]).describe("Browser kind"),
          instanceId: z.string().describe("Full instance id of the managed instance (from browser_state / launch_browser)"),
          confirm: z.literal(true).describe("Must be true — stopping a browser process is irreversible"),
        },
        annotations: { readOnlyHint: false },
      },
      async ({ kind, instanceId, confirm }) => {
        void confirm;
        try {
          const status = await lifecycle.setup.stop({ kind, instanceId });
          return text(`stop_browser: ${browserLabel({ kind, instanceId })} → ${status.readiness}`);
        } catch (e) {
          return fail(e);
        }
      },
    );
  }

  if (!browsers && !lifecycle) return;
  server.registerTool(
    "browser_state",
    {
      description:
        "The one browser status view: this session's target and claimed tab; every connected browser instance (kind + full instanceId, mode, global default) × its windows (which has OS focus, which tab each shows) × tabs; every tab claim, marked as yours or another session's; and, when the backend manages browser setup, each configured instance's readiness (connected / waiting_extension / executable_missing / …) plus the browser executables it can launch. Read-only; does NOT change your target. Copy instance ids from here into use_browser / set_browser_mode / stop_browser.",
      inputSchema: {},
    },
    async () => {
      try {
        const sections: string[] = [];
        if (browsers) {
          const list = browsers.list();
          const sessionTarget = getSessionTarget();
          const held = getClaimed();
          const def = browsers.current();
          const targetLive = sessionTarget == null || list.some((b) => b.instanceId === sessionTarget.instanceId);
          sections.push(
            `this session: target=${sessionTarget ? `${browserLabel(sessionTarget)}${targetLive ? "" : " (DISCONNECTED — use_browser to switch)"}` : `(follows the global default → ${def ? browserLabel(def) : "none"})`}` +
              (held ? `, claimed tab ${held.tabId}${held.target ? ` in ${browserLabel(held.target)}` : ""}` : ", no claimed tab"),
          );
          const claims = browsers.listClaims();
          const blocks = await Promise.all(
            list.map(async (b) => {
              const target: BrowserTarget = { kind: b.kind, instanceId: b.instanceId };
              let winText: string;
              try {
                // rawCall with an explicit target: read this instance WITHOUT
                // changing the session's own target/routing.
                const { windows, focusedWindowId, lastFocusedWindowId } = await rawCall(RpcMethod.ListWindows, {}, target);
                winText = windows
                  .map((w) => {
                    const head = `  window ${w.windowId}${windowFocusLabel(w.windowId, focusedWindowId, lastFocusedWindowId)}${w.state && w.state !== "normal" ? ` [${w.state}]` : ""}`;
                    const rows = w.tabs.map((t) => `      ${t.id === w.activeTabId ? "*" : " "} [${t.id}] ${t.title}`).join("\n");
                    return `${head}\n${rows}`;
                  })
                  .join("\n");
              } catch (e) {
                winText = `  (windows unavailable: ${e instanceof Error ? e.message : String(e)})`;
              }
              const here = claims.filter((c) => c.instanceId === b.instanceId);
              const claimText = here.length
                ? `\n  claimed: ${here.map((c) => `tab ${c.tabId} by ${c.sessionId === deltaKey ? "THIS session" : `another session (${c.sessionId}, ${Math.round((Date.now() - c.since) / 1000)}s ago)`}`).join("; ")}`
                : "";
              const flags = [b.current ? "global default" : "", sessionTarget?.instanceId === b.instanceId ? "this session's target" : "", b.ready ? "" : "handshaking"].filter(Boolean);
              return `### ${browserLabel(target)} [${b.mode}]${flags.length ? ` (${flags.join(", ")})` : ""}${claimText}\n${winText}`;
            }),
          );
          sections.push(list.length ? `## Connected browsers\n\n${blocks.join("\n\n")}` : "## Connected browsers\n(none — launch_browser, or open the extension's side panel/sidebar)");
        }
        if (lifecycle) {
          const resp = await lifecycle.setup.status({});
          const insts = resp.instances.length
            ? resp.instances.map((i) => `  ${statusText(i)}`).join("\n")
            : "  (none configured yet — launch_browser creates one)";
          const cands = resp.candidates.length
            ? resp.candidates.map((c) => `  ${c.kind} @ ${c.path} [${c.source}]${c.usable ? ` (${c.version ?? "?"})` : ` — unusable: ${c.error?.message ?? "?"}`}`).join("\n")
            : "  (none — install Chrome/Firefox or set BROWSER_PATH)";
          sections.push(`## Configured instances (readiness)\n${insts}\n\n## Launchable executables\n${cands}`);
        }
        return text(`# Browser state\n\n${sections.join("\n\n")}`);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
