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
import { MCP_TOOL_INSTRUCTIONS, RpcMethod, isAgentHiddenEvent, isTopologyEvent, type BrowserEvent, type BrowserTarget } from "@bcp/shared";
import { config, domainAllowed } from "./config.js";
import { resolveUploadSources } from "./upload-source.js";
import type { EventStore } from "./event-store.js";
import type { BrowserCall } from "./browser-mcp-types.js";
import { deltaGate, fail, gateNote, renderDelta, text } from "./browser-mcp-render.js";
import { looseBool, tabId } from "./browser-mcp-shapes.js";

export interface IoToolDeps {
  server: McpServer;
  call: BrowserCall;
  events: EventStore;
  evLine: (e: BrowserEvent) => string;
  resolvedTarget: () => BrowserTarget | null;
  /** Live cursor — drainEvents advances it between registration and call. */
  getLastSeenSeq: () => number;
}

/** Registers switch_tab / download / upload_file / pick_option / drag /
 *  read_network / set_network_capture / read_events /
 *  wait_for_event / right_click / double_click / paste_text / hover / click_text. */
export function registerIoTools({ server, call, events, evLine, resolvedTarget, getLastSeenSeq }: IoToolDeps): void {
  server.registerTool(
    "switch_tab",
    { description: MCP_TOOL_INSTRUCTIONS[RpcMethod.SwitchTab].description, inputSchema: { tabId: z.coerce.number().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.SwitchTab].params["tabId"]) } },
    async ({ tabId }) => {
      try {
        const r = await call(RpcMethod.SwitchTab, { tabId });
        return text(`Switched to tab ${r.tabId} (window ${r.windowId})`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "download",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.Download].description,
      inputSchema: { url: z.string().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Download].params["url"]), filename: z.string().optional() },
    },
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

  server.registerTool(
    "upload_file",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.Upload].description,
      inputSchema: {
        ref: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Upload].params["ref"]),
        role: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Upload].params["role"]),
        name: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Upload].params["name"]),
        css: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Upload].params["css"]),
        near: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Upload].params["near"]),
        exact: looseBool.optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Upload].params["exact"]),
        nth: z.coerce.number().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Upload].params["nth"]),
        url: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Upload].params["url"]),
        localPath: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Upload].params["localPath"]),
        filename: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Upload].params["filename"]),
        attachments: z
          .array(
            z.object({
              url: z.string().optional(),
              localPath: z.string().optional(),
              filename: z.string().optional(),
              mimeType: z.string().optional(),
            }),
          )
          .optional()
          .describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Upload].params["attachments"]),
        batchSize: z.coerce.number().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Upload].params["batchSize"]),
        tabId,
      },
    },
    async ({ ref, role, name, css, near, exact, nth, url, localPath, filename, attachments, batchSize, tabId }) => {
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
        const r = await call(RpcMethod.Upload, { ref, role, name, css, near, exact, nth, attachments: sources, batchSize, tabId });
        const where = ref ?? [name && `name=${JSON.stringify(name)}`, role && `role=${role}`, css && `css=${css}`, near && `near=${JSON.stringify(near)}`, nth !== undefined && `nth=${nth}`].filter(Boolean).join(" + ");
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
        "Choose from a CUSTOM (non-native) dropdown/combobox: clicks the trigger [ref], waits for the option list to render, then clicks the option whose visible text matches. Use this for Ant Design / Element / Arco / custom dropdowns where select_option (native <select> only) throws.",
      inputSchema: {
        ref: z.string().describe("[ref] of the dropdown trigger"),
        option: z.string().describe("Visible text of the option to choose"),
        tabId,
      },
    },
    async ({ ref, option, tabId }) => {
      try {
        // The opening click's own result used to be dropped on the floor. It is the ONLY thing that separates
        // "the list rendered, pick from it" from "the trigger did nothing and the text below matched ordinary
        // page content" — and it also carries the repeat warning, i.e. the case where this click CLOSED a list
        // the agent had already opened.
        const open = await call(RpcMethod.Click, { ref, tabId });
        await call(RpcMethod.WaitFor, { ms: 500, tabId });
        const snap = await call(RpcMethod.Snapshot, { tabId });
        const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
        const want = norm(option);
        const named = snap.elements.filter((e) => e.name);
        const exact = named.filter((e) => norm(e.name) === want);
        // Rank a display:none leftover LAST (component libraries keep a closed dropdown mounted) rather than
        // dropping it: sort is stable, so document order is kept inside each group and any pick that resolves
        // today still resolves to the same element.
        const cands = (exact.length ? exact : named.filter((e) => norm(e.name).includes(want))).sort(
          (a, b) => Number(!!a.hidden) - Number(!!b.hidden),
        );
        if (!cands.length) {
          const visible = named.slice(0, 30).map((e) => e.name).join(" | ");
          return fail(new Error(`option "${option}" not found in the opened list. Visible: ${visible}`));
        }
        const match = cands[0]!;
        // WHERE the chosen entry sits, read off the snapshot's own parent links + visual zone. An option sits
        // under the list that just opened; a false positive sits under a nav bar, a breadcrumb or another row.
        // Printed so a wrong pick is visible in THIS result instead of only later, in the page.
        const byRef = new Map(snap.elements.map((e) => [e.ref, e] as const));
        const chain: string[] = [];
        for (let p = match.parentRef; p && chain.length < 3; ) {
          const pe = byRef.get(p);
          if (!pe) break;
          chain.push(`${pe.role}${pe.name ? ` "${pe.name.slice(0, 24)}"` : ""}`);
          p = pe.parentRef;
        }
        const where = [match.zone ? `@${match.zone}` : "", chain.length ? `under ${chain.join(" ← ")}` : "at the page root"]
          .filter(Boolean)
          .join(" ");
        const openEvidence = renderDelta(open.delta).trim();
        const others = cands
          .slice(1, 5)
          .map((e, i) => `${i + 2}) "${e.name}" [${e.ref}]${e.zone ? ` @${e.zone}` : ""}${e.hidden ? " [hidden]" : ""}`)
          .join(", ");
        const ambiguity =
          cands.length > 1
            ? `\n⚠ ${cands.length} elements on this page carry that text; the others are ${others}. ` +
              `If the wrong one was taken: pass the option's exact full text, or open the list yourself (click the ` +
              `trigger), snapshot, and click the entry by its [ref].`
            : "";
        const opened = openEvidence
          ? `\nopening click: ${openEvidence}`
          : `\n⚠ the opening click changed nothing measurable (no elements added, no dialog, no state flip) — the list ` +
            `probably never opened, so "${match.name}" was matched against content that was ALREADY on the page. ` +
            `Snapshot and check that ${ref} is the control that opens the list (many widgets open from their inner ` +
            `input, not from the wrapper you clicked).`;
        const r = await call(RpcMethod.Click, { ref: match.ref, tabId });
        return text(`Picked "${match.name}" (${match.ref}, ${where}) from ${ref}${opened}${ambiguity}${renderDelta(r.delta)}${gateNote(deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "drag",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.Drag].description,
      inputSchema: {
        ref: z.string().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Drag].params["ref"]),
        toRef: z.string().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Drag].params["toRef"]),
        method: z.enum(["html5", "pointer"]).optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Drag].params["method"]),
        confirm: looseBool.optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Drag].params["confirm"]),
        tabId,
      },
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

  server.registerTool(
    "read_network",
    { description: MCP_TOOL_INSTRUCTIONS[RpcMethod.ReadNetwork].description, inputSchema: { limit: z.coerce.number().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.ReadNetwork].params["limit"]), tabId } },
    async ({ limit, tabId }) => {
      try {
        const r = await call(RpcMethod.ReadNetwork, { limit, tabId });
        if (!r.requests.length) return text("(no XHR/fetch recorded for this tab yet — the extension may have just woken, or the tab hasn't made requests)");
        const lines = r.requests.map((q) => `${q.ok === false ? "✗" : (q.status ?? "…")} ${q.method} ${q.url}`).join("\n");
        return text(`## Recent network (${r.requests.length})\n${lines}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "set_network_capture",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.SetNetworkCapture].description,
      inputSchema: {
        enabled: looseBool.describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.SetNetworkCapture].params["enabled"]),
        tabId,
      },
    },
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
        "Pull recent page events the browser captured out-of-band between your tool calls — navigation, dialog, console error, network failure, etc. This is the full-detail companion to the '⚠ events since your last call' piggyback line: filter by kind/tab, and page from a prior read with sinceSeq. Metadata + summaries only.",
      inputSchema: {
        kinds: z.array(z.string()).optional().describe('Restrict to these event kinds (e.g. ["navigation","console_error"]); omit for all'),
        sinceSeq: z.coerce.number().optional().describe("Only events after this seq (from a previous read_events); omit for the whole buffer"),
        limit: z.coerce.number().optional().describe("Max events to return (default 50)"),
        tabId,
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
        "Block until an event of a given kind occurs, then return it — the event-driven way to wait, instead of busy-polling. Page kinds: navigation, dialog, console_error, network_failed, network_body, dom_changed, tab_closed. ORCHESTRATION kinds (not scoped to your target browser): browser_online, browser_offline, mode_changed, claim_changed, target_changed, window_opened, window_closed — wait for another browser to come online, another agent to release a tab, a window to open, your target to disconnect, etc. Long-poll: stays open until a match lands or it times out.",
      inputSchema: {
        kinds: z.array(z.string()).describe('Event kinds to wait for — page (e.g. ["navigation"]) or orchestration (e.g. ["browser_offline","claim_changed"])'),
        urlPattern: z.string().optional().describe("For navigation/network events: only match when the event's url contains this substring"),
        tabId,
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

  server.registerTool(
    "right_click",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.ContextMenu].description,
      inputSchema: { ref: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.ContextMenu].params["ref"]), text: z.string().optional(), role: z.string().optional(), name: z.string().optional(), css: z.string().optional(), near: z.string().optional(), exact: looseBool.optional(), nth: z.coerce.number().optional(), tabId },
    },
    async ({ ref, text: t, role, name, css, near, exact, nth, tabId }) => {
      try {
        const r = await call(RpcMethod.ContextMenu, { ref, role, name, css, near, exact, nth, tabId } as never);
        return text(`Right-clicked ${ref ?? name ?? css ?? t ?? "target"}.${renderDelta(r.delta)}${gateNote(deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "double_click",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.DblClick].description,
      inputSchema: { ref: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.DblClick].params["ref"]), text: z.string().optional(), role: z.string().optional(), name: z.string().optional(), css: z.string().optional(), near: z.string().optional(), exact: looseBool.optional(), nth: z.coerce.number().optional(), confirm: looseBool.optional(), tabId },
    },
    async ({ ref, text: t, role, name, css, near, exact, nth, confirm, tabId }) => {
      try {
        const r = await call(RpcMethod.DblClick, { ref, text: t, role, name, css, near, exact, nth, confirm, tabId } as never);
        return text(`Double-clicked ${ref ?? t ?? name ?? css ?? "target"}.${renderDelta(r.delta)}${gateNote(deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "paste_text",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.Paste].description,
      inputSchema: { ref: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Paste].params["ref"]), text: z.string().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Paste].params["text"]), role: z.string().optional(), name: z.string().optional(), css: z.string().optional(), near: z.string().optional(), exact: looseBool.optional(), nth: z.coerce.number().optional(), tabId },
    },
    async ({ ref, text: value, role, name, css, near, exact, nth, tabId }) => {
      try {
        const r = await call(RpcMethod.Paste, { ref, text: value, role, name, css, near, exact, nth, tabId } as never);
        return text(`Pasted into ${ref ?? name ?? css ?? "target"}.${renderDelta(r.delta)}${gateNote(deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "hover",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.Hover].description,
      inputSchema: { ref: z.string().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Hover].params["ref"]), tabId },
    },
    async ({ ref, tabId }) => {
      try {
        const r = await call(RpcMethod.Hover, { ref, tabId });
        return text(`Hovered ${ref}.${renderDelta(r.delta)}${gateNote(deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "click_text",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.ClickText].description,
      inputSchema: {
        text: z.string().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.ClickText].params["text"]),
        exact: looseBool.optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.ClickText].params["exact"]),
        nth: z.coerce.number().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.ClickText].params["nth"]),
        confirm: looseBool.optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.ClickText].params["confirm"]),
        tabId,
      },
    },
    async ({ text: t, exact, nth, confirm, tabId }) => {
      try {
        const r = await call(RpcMethod.ClickText, { text: t, exact, nth, confirm, tabId });
        // click_text takes index 0 when several elements match. Saying so is the
        // difference between "the only match" and "the first of nine table rows".
        const among = r.candidates > 1
          ? ` (match ${(nth ?? 0) + 1} of ${r.candidates} — pass nth to choose another)`
          : "";
        return text(`Clicked "${r.matched}"${among}.${renderDelta(r.delta)}${gateNote(deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
