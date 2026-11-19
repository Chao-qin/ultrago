/**
 * Everything crossing the page boundary: files in and out, the network log,
 * the event stream, and the pointer actions built on top of a click.
 *
 * Split out of browser-mcp.ts. `wait_for_event` scans the buffer from this
 * session's cursor before blocking, so the cursor is read live rather than
 * captured at registration time.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LocalMethod, RpcMethod, isAgentHiddenEvent, isTopologyEvent, type BrowserEvent, type BrowserTarget, type PlaybookStepAction } from "@bcp/shared";
import { config, domainAllowed } from "./config.js";
import { resolveUploadSources } from "./upload-source.js";
import type { EventStore } from "./event-store.js";
import type { BrowserCall } from "./browser-mcp-types.js";
import { deltaGate, describeTarget, fail, gateNote, renderDelta, text } from "./browser-mcp-render.js";
import { locatorShape, looseBool, tabId } from "./browser-mcp-shapes.js";
import { registerRpcTool } from "./browser-mcp-tool-spec.js";
import { pickOption, pickOptionDeltaKey } from "./pick-option.js";

/** How much of a captured response body read_network prints per request. */
const NETWORK_BODY_PREVIEW = 2_000;

/** Event reads filter by tab rather than resolve one, so an omitted tabId means
 *  every tab — unlike the action tools' shared `tabId`. */
const eventTabId = z.coerce.number().optional().describe("Only events from this tab; omit for events from every tab of your target browser (orchestration events are never filtered by tab)");

export interface IoToolDeps {
  server: McpServer;
  call: BrowserCall;
  events: EventStore;
  evLine: (e: BrowserEvent) => string;
  resolvedTarget: () => BrowserTarget | null;
  /** Live cursor — drainEvents advances it between registration and call. */
  getLastSeenSeq: () => number;
  /** This session's snapshot-baseline key (pick_option derives a private one from it). */
  deltaKey: string;
  /** Run a composite so the current plan step records it as ONE action. */
  recordAsOne: <T>(action: PlaybookStepAction, run: () => Promise<T>) => Promise<T>;
}

/** Registers switch_tab / download / upload_file / pick_option / drag /
 *  read_network / set_network_capture / read_events /
 *  wait_for_event / right_click / double_click / paste_text / hover. */
export function registerIoTools({ server, call, events, evLine, resolvedTarget, getLastSeenSeq, deltaKey, recordAsOne }: IoToolDeps): void {
  registerRpcTool(
    server,
    RpcMethod.SwitchTab,
    { tabId: z.coerce.number() },
    async ({ tabId }) => {
      try {
        const r = await call(RpcMethod.SwitchTab, { tabId });
        return text(`Switched to tab ${r.tabId} (window ${r.windowId})`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.Download,
    { url: z.string(), filename: z.string().optional() },
    async ({ url, filename }) => {
      try {
        const d = domainAllowed(url);
        if (!d.ok) return fail(d.reason);
        const r = await call(RpcMethod.Download, { url, filename });
        if (r.state === "complete") return text(`Downloaded ${r.filename} (id ${r.downloadId}).`);
        if (r.state === "interrupted")
          return text(
            `Download FAILED: ${r.filename} (id ${r.downloadId}) — ${r.error ?? "interrupted"}. ` +
            `The file was not written. Check the URL is reachable from the browser's session, or navigate to it first.`,
          );
        return text(
          `Download started: ${r.filename} (id ${r.downloadId}) — still in progress, the outcome is NOT known yet.`,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.Upload,
    {
      ref: locatorShape.ref,
      text: locatorShape.text,
      role: locatorShape.role,
      name: locatorShape.name,
      css: locatorShape.css,
      near: locatorShape.near,
      exact: locatorShape.exact,
      nth: locatorShape.nth,
      url: z.string().optional(),
      localPath: z.string().optional(),
      filename: z.string().optional(),
      attachments: z
        .array(
          z.object({
            url: z.string().optional(),
            localPath: z.string().optional(),
            filename: z.string().optional(),
            mimeType: z.string().optional(),
          }),
        )
        .optional(),
      batchSize: z.coerce.number().optional(),
      tabId,
    },
    async ({ ref, text: byText, role, name, css, near, exact, nth, url, localPath, filename, attachments, batchSize, tabId }) => {
      try {
        const single = (url ? 1 : 0) + (localPath ? 1 : 0);
        if (attachments && single) return fail(new Error("give `attachments` OR a single `url`/`localPath`, not both"));
        if (!attachments && single !== 1) return fail(new Error("give exactly one of `url` or `localPath` (or an `attachments` list)"));
        // Always hand `call()` the SOURCE list rather than pre-resolved bytes.
        // call() does the fetching/reading itself, so the params recorded by
        // noteAction stay declarative — {name, nth, attachments:[{localPath}]},
        // the shape a playbook can replay. Resolving here instead baked a
        // multi-megabyte dataBase64 blob and a ref (dead after the re-render an
        // upload causes) into every recorded step.
        const sources = attachments ?? [{ url, localPath, filename }];
        const r = await call(RpcMethod.Upload, { ref, text: byText, role, name, css, near, exact, nth, attachments: sources, batchSize, tabId });
        const where = ref ?? [byText && `text=${JSON.stringify(byText)}`, name && `name=${JSON.stringify(name)}`, role && `role=${role}`, css && `css=${css}`, near && `near=${JSON.stringify(near)}`, nth !== undefined && `nth=${nth}`].filter(Boolean).join(" + ");
        // Count the SOURCES sent, not r.files: an uploader that reads the file
        // and clears input.files (React gallery widgets routinely do) reports an
        // empty list, and calling that "0 file(s) attached" describes a working
        // upload as a no-op. r.files stays as evidence, under its own label.
        return text(`Attached ${sources.length} file(s) to ${where} — input.files set + change fired. This does NOT confirm the server accepted it; verify with read_network. On input now: ${r.files.length ? r.files.join(", ") : "(the page cleared input.files — normal for widgets that read the file immediately)"}${renderDelta(r.delta)}${gateNote(deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "pick_option",
    {
      description:
        "Choose from a CUSTOM (non-native) dropdown/combobox in one call: clicks the trigger, waits for the option list to render, then clicks the option whose visible text matches — searched only among the elements the opening click revealed. Use it for Ant Design / Element / Arco / custom dropdowns; for a native <select> use select_option. Name the trigger like any element (ref or description); a description survives the re-render the list causes and is what makes a recorded step replayable. Several matching options is an error listing them — pass the option's exact full text. Recorded as ONE step action, replayed as one.",
      inputSchema: {
        ...locatorShape,
        option: z.string().describe("Visible text of the option to choose — exact match preferred, then substring"),
        tabId,
      },
    },
    async (args) => {
      try {
        const r = await recordAsOne({ method: LocalMethod.PickOption, params: args as Record<string, unknown> }, () =>
          pickOption((m, p) => call(m, p as never), args, pickOptionDeltaKey(deltaKey)),
        );
        const openEvidence = renderDelta(r.openDelta).trim();
        const opened = r.fromRevealedList
          ? openEvidence ? `\nopening click: ${openEvidence}` : ""
          : `\n⚠ the opening click revealed no new elements, so "${r.picked}" was matched on the whole page — check that the trigger really opens this list (many widgets open from their inner input, not the wrapper).`;
        return text(`Picked "${r.picked}" (${r.ref}, ${r.where}) from ${describeTarget(args)}${opened}${renderDelta(r.delta)}${gateNote(deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.Drag,
    {
      ref: z.string(),
      toRef: z.string(),
      method: z.enum(["html5", "pointer"]).optional(),
      confirm: looseBool.optional(),
      tabId,
    },
    async ({ ref, toRef, method, confirm, tabId }) => {
      try {
        const r = await call(RpcMethod.Drag, { ref, toRef, dragMethod: method, confirm, tabId });
        return text(`Dragged ${ref} → ${toRef}${renderDelta(r.delta)}${gateNote(deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.ReadNetwork,
    { limit: z.coerce.number().int().positive().optional(), tabId },
    async ({ limit, tabId }) => {
      try {
        const r = await call(RpcMethod.ReadNetwork, { limit, tabId });
        if (!r.requests.length) return text("(no XHR/fetch recorded for this tab yet — the extension may have just woken, or the tab hasn't made requests)");
        // Bodies captured while set_network_capture was on arrive as network_body
        // events. Pair each with its request (same method + URL, newest first)
        // so the body sits under the request it answers.
        const tgt = resolvedTarget();
        const readTab = r.tabId ?? tabId; // an older extension does not report the tab it read
        const bodies = (readTab == null ? [] : events.since(0, readTab).events).filter(
          (e) => e.kind === "network_body" && (tgt == null || e.browser == null || e.browser === tgt.instanceId),
        );
        const used = new Set<BrowserEvent>();
        const bodyFor = (method: string, url: string): BrowserEvent | undefined => {
          for (let i = bodies.length - 1; i >= 0; i--) {
            const e = bodies[i]!;
            const d = e.detail ?? {};
            if (!used.has(e) && String(d.method ?? "").toUpperCase() === method.toUpperCase() && d.url === url) {
              used.add(e);
              return e;
            }
          }
          return undefined;
        };
        const lines = [...r.requests].reverse().map((q) => {
          const line = `${q.ok === false ? "✗" : (q.status ?? "…")} ${q.method} ${q.url}`;
          const b = bodyFor(q.method, q.url)?.detail;
          if (!b) return line;
          const body = String(b.body ?? "");
          const shown = body.length > NETWORK_BODY_PREVIEW ? `${body.slice(0, NETWORK_BODY_PREVIEW)}…` : body;
          return `${line}\n    body${b.truncated || body.length > NETWORK_BODY_PREVIEW ? " (truncated)" : ""}: ${shown}`;
        }).reverse();
        return text(`## Recent network (${r.requests.length})\n${lines.join("\n")}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.SetNetworkCapture,
    { enabled: looseBool, tabId },
    async ({ enabled, tabId }) => {
      try {
        const r = await call(RpcMethod.SetNetworkCapture, { enabled, tabId });
        if (!r.enabled) return text("Network body capture OFF for the tab.");
        return r.armedFrames > 0
          ? text(`Network body capture ON for the tab (${r.armedFrames} frame(s) patched).`)
          : text(
              "Network body capture could NOT be enabled: 0 frames were patched. This page does not " +
              "allow script injection (chrome://, the Web Store, or a strict CSP). Response bodies will " +
              "not arrive — read the response another way, or run this on a normal page.",
            );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "read_events",
    {
      description:
        "Pull recent page events the browser captured out-of-band between your tool calls — navigation, dialog, console error, network failure, etc. — plus orchestration events (browser/mode/claim/window). This is the full-detail companion to the '⚠ events since your last call' piggyback line: filter by kind/tab, and page from a prior read with sinceSeq. One summary line per event; captured response bodies are read with read_network.",
      inputSchema: {
        kinds: z.array(z.string()).optional().describe('Restrict to these event kinds (e.g. ["navigation","console_error"]); omit for all'),
        sinceSeq: z.coerce.number().optional().describe("Only events after this seq (from a previous read_events); omit for the whole buffer"),
        limit: z.coerce.number().optional().describe("Max events to return (default 50)"),
        tabId: eventTabId,
      },
    },
    async ({ kinds, sinceSeq, limit, tabId }) => {
      try {
        // Scope to THIS session's browser: tab ids collide across browsers, so
        // an unscoped tabId filter would surface another browser's events.
        // Don't push tabId into since() — topology events (tabId -1) must still
        // come through when a tabId is given; filter tab here WITH a topology bypass.
        const tgt = resolvedTarget();
        const { events: evs, maxSeq } = events.since(sinceSeq ?? 0);
        const filtered = evs
          .filter((e) => !isAgentHiddenEvent(e.kind))
          .filter((e) => isTopologyEvent(e.kind) || tgt == null || e.browser == null || e.browser === tgt.instanceId)
          .filter((e) => isTopologyEvent(e.kind) || tabId == null || e.tabId === tabId)
          .filter((e) => !kinds?.length || kinds.includes(e.kind))
          .slice(-(limit ?? 50));
        if (!filtered.length) return text(`(no matching events; current maxSeq=${maxSeq})`);
        const lines = filtered.map((e) => `[seq ${e.seq}] ${e.kind} (tab ${e.tabId}) — ${evLine(e)}`).join("\n");
        return text(`## Events (${filtered.length}, maxSeq=${maxSeq}) — page events + orchestration events (browser/mode/claim/window, shown with tab -1)\n${lines}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "wait_for_event",
    {
      description:
        "Wait until an event of a given kind occurs, then return it — the event-driven way to wait, instead of busy-polling. It first checks events that arrived since your previous tool call (so a transition that already happened is returned at once), then long-polls until a match lands or it times out. Page kinds: navigation (a full page load reaching complete — SPA route changes do not emit it; wait_for an element of the new view instead), dialog, console_error, network_failed, network_body, dom_changed, tab_closed. ORCHESTRATION kinds (not scoped to your target browser): browser_online, browser_offline, mode_changed, claim_changed, target_changed, window_opened, window_closed — wait for another browser to come online, another agent to release a tab, a window to open, your target to disconnect, etc.",
      inputSchema: {
        kinds: z.array(z.string()).describe('Event kinds to wait for — page (e.g. ["navigation"]) or orchestration (e.g. ["browser_offline","claim_changed"])'),
        urlPattern: z.string().optional().describe("For navigation/network events: only match when the event's url contains this substring"),
        tabId: eventTabId,
        timeoutMs: z.coerce.number().optional().describe("Max wait in ms (default 20000, capped at 60000)"),
      },
    },
    async ({ kinds, urlPattern, tabId, timeoutMs }) => {
      try {
        const cap = Math.min(timeoutMs ?? 20_000, 60_000);
        const tgt = resolvedTarget();
        const pred = (e: BrowserEvent): boolean =>
          kinds.includes(e.kind) &&
          !isAgentHiddenEvent(e.kind) &&
          // Topology events aren't browser- OR tab-scoped (they carry tabId -1);
          // page events stay scoped to this target + tab.
          (isTopologyEvent(e.kind) || tgt == null || e.browser == null || e.browser === tgt.instanceId) &&
          (isTopologyEvent(e.kind) || tabId == null || e.tabId === tabId) &&
          (!urlPattern || String(e.detail?.url ?? "").includes(urlPattern));
        // Catch-up: orchestration events are discrete transitions that often
        // ALREADY happened before this call (e.g. the browser came online 2s
        // ago). Scan the buffer since our cursor first, so we don't block 60s
        // for something that already fired. (waitFor only sees FUTURE pushes.)
        const already = events.since(getLastSeenSeq()).events.find(pred);
        const hit = already ?? (await events.waitFor(pred, cap));
        if (!hit) return text(`Timed out after ${cap}ms waiting for ${kinds.join("/")}.`);
        return text(`Event: ${hit.kind} (tab ${hit.tabId}) — ${evLine(hit)}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.ContextMenu,
    { ...locatorShape, tabId },
    async ({ ref, text: byText, role, name, css, near, exact, nth, x, y, tabId }) => {
      try {
        const r = await call(RpcMethod.ContextMenu, { ref, text: byText, role, name, css, near, exact, nth, x, y, tabId });
        return text(`Right-clicked ${describeTarget({ ref, text: byText, role, name, css, near, x, y })}.${renderDelta(r.delta)}${gateNote(deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.DblClick,
    { ...locatorShape, confirm: looseBool.optional(), tabId },
    async ({ ref, text: byText, role, name, css, near, exact, nth, x, y, confirm, tabId }) => {
      try {
        const r = await call(RpcMethod.DblClick, { ref, text: byText, role, name, css, near, exact, nth, x, y, confirm, tabId });
        return text(`Double-clicked ${describeTarget({ ref, text: byText, role, name, css, near, x, y })}.${renderDelta(r.delta)}${gateNote(deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.Paste,
    {
      ref: locatorShape.ref,
      text: z.string(),
      role: locatorShape.role,
      name: locatorShape.name,
      css: locatorShape.css,
      near: locatorShape.near,
      exact: locatorShape.exact,
      nth: locatorShape.nth,
      tabId,
    },
    async ({ ref, text: value, role, name, css, near, exact, nth, tabId }) => {
      try {
        const r = await call(RpcMethod.Paste, { ref, text: value, role, name, css, near, exact, nth, tabId });
        return text(`Pasted into ${describeTarget({ ref, role, name, css, near })}.${renderDelta(r.delta)}${gateNote(deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.Hover,
    { ...locatorShape, tabId },
    async ({ ref, text: byText, role, name, css, near, exact, nth, x, y, tabId }) => {
      try {
        const r = await call(RpcMethod.Hover, { ref, text: byText, role, name, css, near, exact, nth, x, y, tabId });
        return text(`Hovered ${describeTarget({ ref, text: byText, role, name, css, near, x, y })}.${renderDelta(r.delta)}${gateNote(deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
