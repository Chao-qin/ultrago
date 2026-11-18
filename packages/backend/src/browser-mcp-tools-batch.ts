/**
 * `batch` — several browser steps in one round trip.
 *
 * Split out of browser-mcp.ts. It touches no session state at all: every step
 * goes through `call`, so the group moves as-is.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RpcMethod, type ActionDelta } from "@bcp/shared";
import type { BrowserCall } from "./browser-mcp-types.js";
import { renderDelta, text } from "./browser-mcp-render.js";
import { looseBool, tabId } from "./browser-mcp-shapes.js";

export interface BatchToolDeps {
  server: McpServer;
  call: BrowserCall;
  drainEvents: (onTab?: number) => string;
}

/** Registers batch. */
export function registerBatchTools({ server, call, drainEvents }: BatchToolDeps): void {
  server.registerTool(
    "batch",
    {
      description:
        "Run several browser actions in ONE call to save agent round-trips — e.g. fill a form (type into 3 fields) then click submit, without a separate tool call per step. Steps run in order and STOP at the first error. Use for a known sequence on an already-snapshotted page; if the DOM changes unpredictably between steps (a click opens a portal), snapshot and act separately instead. Each step's args match the matching single tool.",
      inputSchema: {
        steps: z.array(
          z.object({
            action: z.enum(["click", "type_text", "select_option", "press_key", "hover", "scroll"]),
            ref: z.string().optional(),
            text: z.string().optional(),
            values: z.array(z.string()).optional(),
            key: z.string().optional(),
            submit: looseBool.optional(),
            confirm: looseBool.optional(),
            deltaY: z.coerce.number().optional(),
            toBottom: looseBool.optional(),
          }),
        ).describe("Ordered steps; each is { action, ...args }"),
        tabId,
      },
    },
    async ({ steps, tabId }) => {
      const results: string[] = [];
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        // Each step's evidence used to be thrown away — no variable received the
        // call's result — and every step that did not throw printed the same
        // fixed "✓". Filling and submitting a form is the case that most needs
        // evidence, and it was the one getting the least.
        let stepDelta: ActionDelta | undefined;
        try {
          switch (s.action) {
            case "click": stepDelta = (await call(RpcMethod.Click, { ref: s.ref!, confirm: s.confirm, tabId })).delta; break;
            case "type_text": stepDelta = (await call(RpcMethod.Type, { ref: s.ref!, text: s.text ?? "", submit: s.submit, confirm: s.confirm, tabId })).delta; break;
            case "select_option": stepDelta = (await call(RpcMethod.SelectOption, { ref: s.ref!, values: s.values ?? [], tabId })).delta; break;
            case "press_key": stepDelta = (await call(RpcMethod.PressKey, { key: s.key ?? "", ref: s.ref, tabId })).delta; break;
            case "hover": stepDelta = (await call(RpcMethod.Hover, { ref: s.ref!, tabId })).delta; break;
            case "scroll": await call(RpcMethod.Scroll, { ref: s.ref, deltaY: s.deltaY, toBottom: s.toBottom, tabId }); break;
          }
          results.push(`${i + 1}. ${s.action} ${s.ref ?? ""}${renderDelta(stepDelta) || "  (nothing observably changed)"}`);
        } catch (e) {
          results.push(`${i + 1}. ${s.action} ✗ ${e instanceof Error ? e.message : String(e)}`);
          return text(`Batch stopped at step ${i + 1}/${steps.length}:\n${results.join("\n")}`);
        }
      }
      return text(`Batch done (${steps.length} steps):\n${results.join("\n")}${drainEvents(tabId)}`);
    },
  );
}
