/**
 * `batch` — several browser steps in one round trip.
 *
 * Split out of browser-mcp.ts. It touches no session state at all: every step
 * goes through `call`, so the group moves as-is.
 *
 * Each step's arguments are the SAME shapes the single tools take (shared
 * locator fields included), so "each step's args match the matching single
 * tool" is true by construction rather than a promise the schema broke.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RpcMethod, type ActionDelta, TOOL_HINTS } from "@bcp/shared";
import type { BrowserCall } from "./browser-mcp-types.js";
import { deltaGate, describeTarget, gateNote, renderDelta, text } from "./browser-mcp-render.js";
import { locatorShape, looseBool, tabId } from "./browser-mcp-shapes.js";

export interface BatchToolDeps {
  server: McpServer;
  call: BrowserCall;
  drainEvents: (onTab?: number) => string;
}

const fieldLocator = {
  ref: locatorShape.ref, name: locatorShape.name, role: locatorShape.role, css: locatorShape.css,
  near: locatorShape.near, exact: locatorShape.exact, nth: locatorShape.nth,
};

const stepShape = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), ...locatorShape, humanize: looseBool.optional(), confirm: looseBool.optional() }),
  z.object({
    action: z.literal("type_text"), ...fieldLocator,
    text: z.string().describe("The value to type — not a locator. Replaces the current content"),
    submit: looseBool.optional(), humanize: looseBool.optional(), confirm: looseBool.optional(),
  }),
  z.object({ action: z.literal("select_option"), ref: z.string(), values: z.array(z.string()) }),
  z.object({ action: z.literal("press_key"), key: z.string(), ref: z.string().optional() }),
  z.object({ action: z.literal("hover"), ...locatorShape }),
  z.object({ action: z.literal("scroll"), ref: z.string().optional(), deltaY: z.coerce.number().optional(), toBottom: looseBool.optional(), humanize: looseBool.optional() }),
]);

/** Registers batch. */
export function registerBatchTools({ server, call, drainEvents }: BatchToolDeps): void {
  server.registerTool(
    "batch",
    {
      annotations: TOOL_HINTS.pageAction,
      description:
        "Run a known sequence of actions in one call, e.g. fill three fields and click submit. Each step is {action, ...that tool's arguments}, with action one of click, type_text, select_option, press_key, hover or scroll; tabId is set once for the whole batch. Steps run in order and stop at the first error. If a step changes the page unpredictably (opens a dialog, navigates), target later steps by description, or act one step at a time.",
      inputSchema: {
        steps: z.array(stepShape).min(1).describe("Ordered steps, each {action, ...that tool's arguments}"),
        tabId,
      },
    },
    async ({ steps, tabId }) => {
      const results: string[] = [];
      let gate: string | null = null;
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]!;
        let stepDelta: ActionDelta | undefined;
        let label = "";
        try {
          switch (s.action) {
            case "click": {
              const { action: _a, ...args } = s;
              stepDelta = (await call(RpcMethod.Click, { ...args, tabId })).delta;
              label = describeTarget(args);
              if (s.confirm) gate ??= "a confirmed critical/irreversible action";
              break;
            }
            case "type_text": {
              const { action: _a, ...args } = s;
              stepDelta = (await call(RpcMethod.Type, { ...args, tabId })).delta;
              // `text` is the typed VALUE (maybe a password) — never echo it as the target.
              label = describeTarget({ ref: s.ref, name: s.name, role: s.role, css: s.css, near: s.near });
              if (s.submit) gate ??= "a form submission";
              break;
            }
            case "select_option":
              stepDelta = (await call(RpcMethod.SelectOption, { ref: s.ref, values: s.values, tabId })).delta;
              label = s.ref;
              break;
            case "press_key":
              stepDelta = (await call(RpcMethod.PressKey, { key: s.key, ref: s.ref, tabId })).delta;
              label = `${s.key}${s.ref ? ` on ${s.ref}` : ""}`;
              break;
            case "hover": {
              const { action: _a, ...args } = s;
              stepDelta = (await call(RpcMethod.Hover, { ...args, tabId })).delta;
              label = describeTarget(args);
              break;
            }
            case "scroll": {
              const r = await call(RpcMethod.Scroll, { ref: s.ref, deltaY: s.deltaY, toBottom: s.toBottom, humanize: s.humanize, tabId });
              label = r.via === "dom" ? `${r.target} by ${r.movedBy}px` : `${r.target} (synthetic wheel)`;
              break;
            }
          }
          gate ??= deltaGate(stepDelta);
          results.push(`${i + 1}. ${s.action} ${label}${renderDelta(stepDelta) || "  (nothing observably changed)"}`);
        } catch (e) {
          results.push(`${i + 1}. ${s.action} ✗ ${e instanceof Error ? e.message : String(e)}`);
          return text(`Batch stopped at step ${i + 1}/${steps.length}:\n${results.join("\n")}${gateNote(gate)}`);
        }
      }
      return text(`Batch done (${steps.length} steps):\n${results.join("\n")}${gateNote(gate)}${drainEvents(tabId)}`);
    },
  );
}
