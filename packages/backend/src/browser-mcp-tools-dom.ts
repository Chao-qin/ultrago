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
import { RpcMethod, WAIT_FOR_DEFAULT_MS, WAIT_FOR_MAX_MS, type PageState, type SnapshotElement } from "@bcp/shared";
import { config, EVAL_DISABLED } from "./config.js";
import type { BrowserCall, ReadSnapshot } from "./browser-mcp-types.js";
import { deltaGate, describeTarget, fail, gateNote, renderDelta, renderHistoryNav, renderPageState, renderReadDump, text } from "./browser-mcp-render.js";
import { PageReadDumpStore } from "./browser-read-dump.js";
import { locatorShape, looseBool, tabId } from "./browser-mcp-shapes.js";
import { registerRpcTool } from "./browser-mcp-tool-spec.js";

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
  registerRpcTool(
    server,
    RpcMethod.Snapshot,
    {
      tabId,
      query: z.string().optional(),
      viewportOnly: looseBool.optional(),
      limit: z.coerce.number().int().positive().optional(),
      after: z.string().optional(),
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

  registerRpcTool(
    server,
    RpcMethod.PageState,
    {
      tabId,
      verbosity: z.preprocess((v) => (typeof v === "string" ? v.toLowerCase() : v), z.enum(["summary", "detail"])).optional(),
      resetDelta: looseBool.optional(),
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

  registerRpcTool(
    server,
    RpcMethod.Click,
    { ...locatorShape, tabId, humanize: looseBool.optional(), confirm: looseBool.optional() },
    async ({ ref, text: byText, role, name, css, near, exact, nth, x, y, tabId, humanize, confirm }) => {
      try {
        const r = await call(RpcMethod.Click, { ref, text: byText, role, name, css, near, exact, nth, x, y, tabId, humanize, confirm });
        const named = describeTarget({ ref, text: byText, role, name, css, near, x, y });
        return text(`Clicked ${named}${renderDelta(r.delta)}${gateNote(confirm ? "a confirmed critical/irreversible action" : deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.Type,
    {
      ref: locatorShape.ref,
      text: z.string(),
      name: locatorShape.name,
      role: locatorShape.role,
      css: locatorShape.css,
      near: locatorShape.near,
      exact: locatorShape.exact,
      nth: locatorShape.nth,
      submit: looseBool.optional(),
      tabId,
      humanize: looseBool.optional(),
      confirm: looseBool.optional(),
    },
    async ({ ref, text: value, name, role, css, near, exact, nth, submit, tabId, humanize, confirm }) => {
      try {
        const r = await call(RpcMethod.Type, { ref, text: value, name, role, css, near, exact, nth, submit, tabId, humanize, confirm });
        const named = describeTarget({ ref, role, name, css, near });
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

  registerRpcTool(
    server,
    RpcMethod.ReadContent,
    {
      maxChars: z.coerce.number().int().positive().optional(),
      tabId,
    },
    async ({ maxChars, tabId }) => {
      try {
        const r = await call(RpcMethod.ReadContent, { maxChars, full: true, tabId });
        if (!r.text.trim() && r.totalChars === 0)
          return text(`# ${r.title}\n${r.url}\n\n(no visible text after waiting for the DOM to settle — the page may still be loading slowly, be behind a login/consent wall, or render inside a canvas/iframe. Try wait_for a known element, or screenshot to see it.)`);
        const dump = await readDumps.create({
          url: r.url,
          title: r.title,
          text: r.text,
          totalChars: r.totalChars,
          overview: r.overview,
          maxChars,
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
        "Read one file of the current read_content / analyze_page text dump, for when your own file reader cannot reach the backend host. Start with the manifest path from the reply, then read only the chunks you need. Only paths inside the current dump are accepted. This call does not delete the dump; your next browser tool call does.",
      inputSchema: {
        path: z.string().describe("Absolute path from the current dump manifest or the read_content reply"),
        maxChars: z.coerce.number().int().positive().optional().describe("Maximum characters to return; omit for the whole file"),
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

  registerRpcTool(
    server,
    RpcMethod.WaitFor,
    {
      text: z.string().optional(),
      selector: z.string().optional(),
      state: z.preprocess((v) => (typeof v === "string" ? v.toLowerCase() : v), z.enum(["visible", "hidden"])).optional(),
      ms: z.coerce.number().int().nonnegative().max(WAIT_FOR_MAX_MS).optional(),
      tabId,
    },
    async ({ text: t, selector, state, ms, tabId }) => {
      try {
        if (t && selector) return fail(new Error("wait_for takes `text` OR `selector`, not both — make two calls if you need both"));
        if (state && !selector) return fail(new Error("`state` applies to `selector` only"));
        const condition = t || selector;
        if (!condition && ms === undefined) return fail(new Error("wait_for needs `text`, `selector`, or a fixed delay in `ms`"));
        const timeout = ms ?? WAIT_FOR_DEFAULT_MS;
        const r = await call(RpcMethod.WaitFor, { text: t, selector, state, ms: timeout, tabId });
        if (!condition) return text(`Waited ${timeout}ms.`);
        const what = t ? `text ${JSON.stringify(t)}` : `${selector} to be ${state ?? "visible"}`;
        return text(r.matched ? `Condition met: ${what}.` : `Timed out after ${timeout}ms waiting for ${what}.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.SelectOption,
    { ref: z.string(), values: z.array(z.string()), tabId },
    async ({ ref, values, tabId }) => {
      try {
        const r = await call(RpcMethod.SelectOption, { ref, values, tabId });
        return text(`Selected: ${r.selected.join(", ")}${renderDelta(r.delta)}${gateNote(deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.PressKey,
    { key: z.string(), ref: z.string().optional(), tabId },
    async ({ key, ref, tabId }) => {
      try {
        const r = await call(RpcMethod.PressKey, { key, ref, tabId });
        return text(`Pressed ${key}${renderDelta(r.delta)}${gateNote(deltaGate(r.delta))}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.Scroll,
    { ref: z.string().optional(), deltaY: z.coerce.number().optional(), toBottom: looseBool.optional(), humanize: looseBool.optional(), tabId },
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

  registerRpcTool(
    server,
    RpcMethod.GoBack,
    { tabId },
    async ({ tabId }) => {
      try {
        const r = await call(RpcMethod.GoBack, { tabId });
        return text(renderHistoryNav("back", r));
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.GoForward,
    { tabId },
    async ({ tabId }) => {
      try {
        const r = await call(RpcMethod.GoForward, { tabId });
        return text(renderHistoryNav("forward", r));
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.Reload,
    { tabId },
    async ({ tabId }) => {
      try {
        const r = await call(RpcMethod.Reload, { tabId });
        return text(renderHistoryNav("reload", r));
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerRpcTool(
    server,
    RpcMethod.Eval,
    {
      code: z.string(),
      tabId,
      frameId: z.coerce.number().optional(),
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
