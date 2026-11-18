/**
 * Reading a page and acting on it: the snapshot/state pair, the pointer and
 * keyboard actions, the waits, and eval.
 *
 * Split out of browser-mcp.ts. Every tool here goes through `call` and answers
 * about the page in front of it — none of them touches the session's routing
 * or claim state, which is what lets them move as a block.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_TOOL_INSTRUCTIONS, RpcMethod, type PageState, type SnapshotElement } from "@bcp/shared";
import { config, EVAL_DISABLED } from "./config.js";
import type { BrowserCall, ReadSnapshot } from "./browser-mcp-types.js";
import { deltaGate, fail, gateNote, renderDelta, renderHistoryNav, renderPageState, renderReadDump, text } from "./browser-mcp-render.js";
import { PageReadDumpStore } from "./browser-read-dump.js";
import { looseBool, tabId } from "./browser-mcp-shapes.js";

export interface DomToolDeps {
  server: McpServer;
  call: BrowserCall;
  deltaKey: string;
  drainEvents: (onTab?: number) => string;
  readDumps: PageReadDumpStore;
  readSnapshot: ReadSnapshot;
}

/** Registers the page-reading and page-acting tools. */
export function registerDomTools({ server, call, deltaKey, drainEvents, readDumps, readSnapshot }: DomToolDeps): void {
  server.registerTool(
    "snapshot",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.Snapshot].description,
      inputSchema: {
        tabId,
        query: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Snapshot].params["query"]),
        viewportOnly: looseBool.optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Snapshot].params["viewportOnly"]),
        limit: z.coerce.number().int().positive().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Snapshot].params["limit"]),
        after: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Snapshot].params["after"]),
      },
    },
    async ({ tabId, query, viewportOnly, limit, after }) => {
      try {
        const r = await readSnapshot(tabId, { query, viewportOnly, limit, after });
        const more = r.moreBelow ? "\n\n↓ more content below the fold — use scroll to load/see it" : "";
        return text(`# ${r.title}\n${r.url}\n\n${r.text}${more}${drainEvents(tabId)}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "page_state",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.PageState].description,
      inputSchema: {
        tabId,
        verbosity: z.preprocess((v) => (typeof v === "string" ? v.toLowerCase() : v), z.enum(["summary", "detail"])).optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.PageState].params["verbosity"]),
        resetDelta: looseBool.optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.PageState].params["resetDelta"]),
      },
    },
    async ({ tabId, verbosity, resetDelta }) => {
      try {
        const s = await call(RpcMethod.PageState, { tabId, verbosity, resetDelta, deltaKey });
        return text(renderPageState(s) + drainEvents(s.tabId));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "click",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.Click].description,
      inputSchema: {
        ref: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Click].params["ref"]),
        text: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Click].params["text"]),
        role: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Click].params["role"]),
        name: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Click].params["name"]),
        css: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Click].params["css"]),
        near: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Click].params["near"]),
        exact: looseBool.optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Click].params["exact"]),
        nth: z.coerce.number().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Click].params["nth"]),
        x: z.coerce.number().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Click].params["x"]),
        y: z.coerce.number().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Click].params["y"]),
        tabId,
        humanize: looseBool.optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Click].params["humanize"]),
        confirm: looseBool.optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Click].params["confirm"]),
      },
    },
    async ({ ref, text: byText, role, name, css, near, exact, nth, x, y, tabId, humanize, confirm }) => {
      try {
        const r = await call(RpcMethod.Click, { ref, text: byText, role, name, css, near, exact, nth, x, y, tabId, humanize, confirm });
        const named = ref ?? (x !== undefined && y !== undefined ? `(${x},${y})` : [byText && `text=${JSON.stringify(byText)}`, role && `role=${role}`, name && `name=${JSON.stringify(name)}`, css && `css=${css}`, near && `near=${JSON.stringify(near)}`].filter(Boolean).join(" + "));
        return text(`Clicked ${named}${renderDelta(r.delta)}${gateNote(confirm ? "a confirmed critical/irreversible action" : deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "type_text",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.Type].description,
      inputSchema: {
        ref: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Type].params["ref"]),
        text: z.string().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Type].params["text"]),
        name: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Type].params["name"]),
        role: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Type].params["role"]),
        css: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Type].params["css"]),
        near: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Type].params["near"]),
        exact: looseBool.optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Type].params["exact"]),
        nth: z.coerce.number().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Type].params["nth"]),
        submit: looseBool.optional(), tabId,
        humanize: looseBool.optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Type].params["humanize"]),
        confirm: looseBool.optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Type].params["confirm"]),
      },
    },
    async ({ ref, text: value, name, role, css, near, exact, nth, submit, tabId, humanize, confirm }) => {
      try {
        const r = await call(RpcMethod.Type, { ref, text: value, name, role, css, near, exact, nth, submit, tabId, humanize, confirm });
        const named = ref ?? [name && `name=${JSON.stringify(name)}`, role && `role=${role}`, css && `css=${css}`, near && `near=${JSON.stringify(near)}`].filter(Boolean).join(" + ");
        // "and submitted" used to be printed off the `submit` PARAMETER — i.e.
        // off what the caller asked for, never off what happened. It is now
        // stated only when the runtime saw requestSubmit() actually reached;
        // a submit that navigated reports through delta.urlChanged instead.
        const submitted = r.delta?.submitted === true ? " and submitted" : "";
        return text(`Typed into ${named}${submitted}${renderDelta(r.delta)}${gateNote(submit ? "a form submission" : confirm ? "a confirmed critical/irreversible action" : deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "read_content",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.ReadContent].description,
      inputSchema: {
        maxChars: z.coerce.number().int().positive().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.ReadContent].params["maxChars"]),
        offset: z.coerce.number().int().nonnegative().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.ReadContent].params["offset"]),
        tabId,
      },
    },
    async ({ maxChars, offset, tabId }) => {
      try {
        const r = await call(RpcMethod.ReadContent, { maxChars, offset, full: true, tabId });
        if (!r.text.trim() && r.totalChars === 0)
          return text(`# ${r.title}\n${r.url}\n\n(no visible text after waiting for the DOM to settle — the page may still be loading slowly, be behind a login/consent wall, or render inside a canvas/iframe. Try wait_for a known element, or screenshot to see it.)`);
        const dump = await readDumps.create({
          url: r.url,
          title: r.title,
          text: r.text,
          totalChars: r.totalChars,
          overview: r.overview,
          maxChars,
          requestedOffset: offset,
        });
        return text(`# ${r.title}\n${r.url}\n\n${renderReadDump(dump)}${drainEvents(tabId)}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "read_content_dump",
    {
      description:
        "Read one file from the currently-live page text dump created by read_content or analyze_page. Start with the returned manifest path, then pass only the needed chunk path. The path is sandboxed to the current dump directory; the dump expires before the next browser operation.",
      inputSchema: {
        path: z.string().describe("Absolute path copied from the current dump manifest or read_content reply"),
        maxChars: z.coerce.number().int().positive().optional().describe("Optional output cap for this file; omit to read the whole selected chunk"),
      },
    },
    async ({ path, maxChars }) => {
      try {
        return text(await readDumps.read(path, maxChars));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "wait_for",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.WaitFor].description,
      inputSchema: { text: z.string().optional(), selector: z.string().optional(), state: z.preprocess((v) => (typeof v === "string" ? v.toLowerCase() : v), z.enum(["visible", "hidden"])).optional(), ms: z.coerce.number().optional(), tabId },
    },
    async ({ text: t, selector, state, ms, tabId }) => {
      try {
        const r = await call(RpcMethod.WaitFor, { text: t, selector, state, ms, tabId });
        return text(r.matched ? "Condition met." : "Timed out waiting.");
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "wait_signal",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.WaitSignal].description,
      inputSchema: {
        condition: z.record(z.string(), z.unknown()).describe("Declarative Book v2 signal condition tree (urlIncludes/settled/networkIdle/selector/textPresent/script/all/any/not)"),
        timeoutMs: z.coerce.number().positive().optional().describe("Absolute wait ceiling in ms (default 30s)"),
        tabId,
      },
    },
    async ({ condition, timeoutMs, tabId }) => {
      try {
        const deadline = timeoutMs ?? 30_000;
        const r = await call(RpcMethod.WaitSignal, { condition: condition as unknown as import("@bcp/shared").SignalCondition, timeoutMs: deadline, tabId });
        if (r.satisfied) {
          const ev = r.evidence === undefined ? "" : ` evidence: ${JSON.stringify(r.evidence)}`;
          return text(`Signal satisfied.${ev}`);
        }
        return text(
          `Signal timed out after ${deadline}ms.${r.failedPaths?.length ? ` failed: ${r.failedPaths.join(", ")}` : ""} url=${r.url ?? "?"} pageState=${JSON.stringify(r.pageState ?? {})}`,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "select_option",
    { description: MCP_TOOL_INSTRUCTIONS[RpcMethod.SelectOption].description, inputSchema: { ref: z.string(), values: z.array(z.string()).describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.SelectOption].params["values"]), tabId } },
    async ({ ref, values, tabId }) => {
      try {
        const r = await call(RpcMethod.SelectOption, { ref, values, tabId });
        return text(`Selected: ${r.selected.join(", ")}${renderDelta(r.delta)}${gateNote(deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "press_key",
    { description: MCP_TOOL_INSTRUCTIONS[RpcMethod.PressKey].description, inputSchema: { key: z.string(), ref: z.string().optional(), tabId } },
    async ({ key, ref, tabId }) => {
      try {
        const r = await call(RpcMethod.PressKey, { key, ref, tabId });
        return text(`Pressed ${key}${renderDelta(r.delta)}${gateNote(deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "scroll",
    { description: MCP_TOOL_INSTRUCTIONS[RpcMethod.Scroll].description, inputSchema: { ref: z.string().optional(), deltaY: z.coerce.number().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Scroll].params["deltaY"]), toBottom: looseBool.optional(), humanize: looseBool.optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Scroll].params["humanize"]), tabId } },
    async ({ ref, deltaY, toBottom, humanize, tabId }) => {
      try {
        const r = await call(RpcMethod.Scroll, { ref, deltaY, toBottom, humanize, tabId });
        if (r.via === "wheel")
          return text(
            r.consumed
              ? `No DOM-scrollable container (canvas-style page) — dispatched a synthetic wheel (${r.target}) and the page CONSUMED it (preventDefault), so something handled the scroll. The container's own offset is not readable from here: verify with screenshot or snapshot.`
              : `No DOM-scrollable container (canvas-style page) — dispatched a synthetic wheel (${r.target}) and NOTHING consumed it, so the page almost certainly did not scroll. Try scroll with the ref of a (scrollable) element from the snapshot, or check you are on the right tab.`,
          );
        if (r.movedBy === 0)
          return text(
            `Scroll did NOT move ${r.target} — still at ${r.scrollY}/${r.scrollHeight}px. Already at that end, or an onscroll/overflow handler pinned it. ` +
            `Scrolling a different container (snapshot marks them (scrollable)) is usually the fix, not repeating this call.`,
          );
        return text(`Scrolled ${r.target} by ${r.movedBy}px to ${r.scrollY}/${r.scrollHeight}px.${r.moreBelow ? " More below — scroll again or snapshot." : " Reached the end."}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "go_back",
    { description: MCP_TOOL_INSTRUCTIONS[RpcMethod.GoBack].description, inputSchema: { tabId } },
    async ({ tabId }) => {
      try {
        const r = await call(RpcMethod.GoBack, { tabId });
        return text(renderHistoryNav("back", r));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "go_forward",
    { description: MCP_TOOL_INSTRUCTIONS[RpcMethod.GoForward].description, inputSchema: { tabId } },
    async ({ tabId }) => {
      try {
        const r = await call(RpcMethod.GoForward, { tabId });
        return text(renderHistoryNav("forward", r));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "reload",
    { description: MCP_TOOL_INSTRUCTIONS[RpcMethod.Reload].description, inputSchema: { tabId } },
    async ({ tabId }) => {
      try {
        const r = await call(RpcMethod.Reload, { tabId });
        return text(renderHistoryNav("reload", r));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "eval",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.Eval].description,
      inputSchema: {
        code: z.string(),
        tabId,
        frameId: z.coerce.number().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Eval].params["frameId"]),
      },
    },
    async ({ code, tabId, frameId }) => {
      try {
        if (!config.evalEnabled) return fail(EVAL_DISABLED);
        const r = await call(RpcMethod.Eval, { code, tabId, frameId });
        const body = JSON.stringify(r.value);
        return text(r.truncated ? `${body}\n\n⚠ eval result truncated (exceeded size cap)` : body);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
