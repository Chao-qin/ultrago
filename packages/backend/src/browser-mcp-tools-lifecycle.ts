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
import { MCP_TOOL_INSTRUCTIONS, RpcMethod, browserLabel, type BrowserStatus, type BrowserTarget } from "@bcp/shared";
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

/** Registers list_browsers / use_browser / claim_tab / set_browser_mode /
 *  browser_state, plus browser_status / launch_browser / stop_browser when the
 *  lifecycle services are injected. */
export function registerLifecycleTools({
  server, call, rawCall, browsers, lifecycle, deltaKey, resolvedTarget, isUserVisibleTab,
  getSessionTarget, setSessionTarget, getClaimed, setClaimed,
}: LifecycleToolDeps): void {
  if (browsers) {
    server.registerTool(
      "list_browsers",
      {
        description:
          "List the browser instances connected to this server (chrome / firefox, each with a stable instanceId): their mode (auto = agents may drive freely; manual = the user is personally driving it), the global default target, and what THIS session targets/claims. Multiple instances — even of the same kind — can be online at once and are fully isolated. use_browser takes the (kind, instanceId) pair from here.",
        inputSchema: {},
      },
      async () => {
        const list = browsers.list();
        if (!list.length) return text("(no browsers connected — launch_browser or open the extension's side panel/sidebar)");
        const lines = list
          .map(
            (b) =>
              `${b.current ? "→" : " "} ${b.kind}:${b.instanceId} [${b.mode}]${b.ready ? "" : " (handshaking)"} (connected ${new Date(b.connectedAt).toISOString()})`,
          )
          .join("\n");
        const sessionTarget = getSessionTarget();
        const held = getClaimed();
        const targetLive = sessionTarget == null || list.some((b) => b.kind === sessionTarget!.kind && b.instanceId === sessionTarget!.instanceId);
        const mine = `this session: target=${sessionTarget ? `${browserLabel(sessionTarget)}${targetLive ? "" : " (DISCONNECTED — use_browser to switch)"}` : `(default → ${browsers.current() ? browserLabel(browsers.current()!) : "none"})`}${held ? `, claimed tab ${held.tabId} in ${held.target ? browserLabel(held.target) : "(default browser)"}` : ""}`;
        // Peers' claims — the cross-session view so you can tell a tab is already
        // spoken for by another agent before you touch it.
        const peers = browsers.listClaims().filter((c) => c.sessionId !== deltaKey);
        const peerLine = peers.length
          ? `\n\nother sessions' claims:\n${peers.map((c) => `  • tab ${c.tabId} in ${c.instanceId} (session ${c.sessionId}, ${Math.round((Date.now() - c.since) / 1000)}s ago)`).join("\n")}`
          : "\n\nother sessions' claims: (none)";
        return text(`## Connected browser instances (→ = global default, [mode])\n${lines}\n\n${mine}${peerLine}`);
      },
    );

    server.registerTool(
      "use_browser",
      {
        description:
          "Point THIS session's tools at a specific browser INSTANCE (kind + instanceId from list_browsers). Session-scoped: other MCP sessions keep their own targets, so several agents can drive different instances concurrently without fighting. Omit instanceId to pick the current default (or the first live instance of that kind).",
        inputSchema: {
          kind: z.enum(["chrome", "firefox"]).describe('Browser kind, e.g. "chrome"'),
          instanceId: z.string().optional().describe("Instance id from list_browsers; omit to use the default/first live instance of that kind"),
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
          "Claim a tab as THIS session's default workspace: tools that omit tabId then target the claimed tab instead of the window's visible tab. Essential when several agent sessions — or the agent and the user — share one browser. release:true reverts to visible-tab defaulting.",
        inputSchema: {
          tabId: z.coerce.number().optional().describe("Tab to claim (from list_tabs/new_tab); omit to claim the currently visible tab"),
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
            const { tabs } = await call(RpcMethod.ListTabs, {});
            const actives = tabs.filter((t) => t.active);
            if (actives.length === 0) return fail(new Error("no visible tab found — pass tabId explicitly"));
            if (actives.length > 1) {
              // One active tab PER WINDOW — "the visible tab" is ambiguous.
              return fail(
                new Error(
                  `multiple windows are open, each with its own visible tab (${actives.map((t) => `${t.id}: ${t.title}`).join("; ")}) — pass the tabId you mean.`,
                ),
              );
            }
            id = actives[0]!.id;
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
          "Mark a browser INSTANCE as manual (the user is personally driving it) or auto (agents may drive freely). In manual mode agents cannot switch its tabs or touch its visible tab: every operation needs an explicit tabId, new_tab opens in the background, and screenshots never re-foreground. Set manual when the user says they're using that browser themselves.",
        inputSchema: {
          kind: z.enum(["chrome", "firefox"]).describe("Browser kind"),
          instanceId: z.string().describe("Instance id from list_browsers"),
          mode: z.enum(["auto", "manual"]),
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

    server.registerTool(
      "browser_state",
      {
        description:
          "The whole-picture orchestration view in ONE read: every connected browser instance × its mode × its windows (which is OS-focused) × their tabs, plus which tabs are claimed by which session. Use this to coordinate in a multi-browser / multi-agent / multi-window setup — see everything before deciding your next move. Read-only; does NOT change your session's target.",
        inputSchema: {},
      },
      async () => {
        try {
          const list = browsers.list();
          if (!list.length) return text("(no browsers connected)");
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
              const myClaims = claims.filter((c) => c.instanceId === b.instanceId);
              const claimText = myClaims.length ? `\n  claimed: ${myClaims.map((c) => `tab ${c.tabId} by ${c.sessionId}`).join(", ")}` : "";
              const label = browserLabel(target);
              return `### ${label} [${b.mode}]${b.current ? " (global default)" : ""}${claimText}\n${winText}`;
            }),
          );
          return text(`# Browser state (all connected)\n\n${blocks.join("\n\n")}`);
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
      "browser_status",
      {
        description:
          "Read-only browser lifecycle status: which executables are discoverable (chrome/firefox candidates), which instances are configured, and each instance's readiness (executable_missing / waiting_extension / connected / protocol_incompatible / auth_rejected / unsupported / failed …). Does NOT start a browser and does NOT probe — it only reads the service's instance and candidate state.",
        inputSchema: {
          kind: z.enum(["chrome", "firefox"]).optional().describe("Filter instances by kind"),
          instanceId: z.string().optional().describe("Filter to one instance"),
        },
      },
      async ({ kind, instanceId }) => {
        try {
          const resp = await lifecycle.setup.status({ kind, instanceId });
          const cands = resp.candidates.length
            ? resp.candidates.map((c) => `  ${c.kind} @ ${c.path} [${c.source}]${c.usable ? ` (${c.version ?? "?"})` : ` — unusable: ${c.error?.message ?? "?"}`}`).join("\n")
            : "  (none — install Chrome/Firefox or set BROWSER_PATH)";
          const insts = resp.instances.length
            ? resp.instances.map((i) => `  ${statusText(i)}`).join("\n")
            : "  (no instances configured yet — launch_browser to create one)";
          return text(
            `## Browser status\n### Executable candidates\n${cands}\n\n### Instances\n${insts}\n\ndefault target: ${resp.defaultTarget ? browserLabel(resp.defaultTarget) : "none"}`,
          );
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "launch_browser",
      {
      description:
        "Start (or reuse) a browser instance for automation and WAIT for its extension to complete the handshake (hello→welcome→ready). user mode (default): opens your real browser normally — if the extension is already installed it just connects; the install guide (chrome://extensions) opens ONLY when no extension connected within a short grace window. managed mode: launches a dedicated backend-owned profile with the extension pre-loaded. Returns the target (kind + instanceId) + readiness. Idempotent: an already-ready instance returns immediately. Default wait 30s, max 5min.",
        inputSchema: {
          kind: z.enum(["chrome", "firefox"]),
          mode: z.enum(["user", "managed"]).optional().describe("user = your own profile (default, never owned by the backend); managed = dedicated backend-owned profile (chrome only)"),
          instanceId: z.string().optional().describe("Reuse an existing instance id; omit to generate a fresh one"),
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
            `launch_browser: ${statusText(result.status)}${result.ready ? "\nReady — this session now drives it." : "\nNot ready yet — check browser_status / open the side panel."}`,
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
          kind: z.enum(["chrome", "firefox"]),
          instanceId: z.string(),
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
}
