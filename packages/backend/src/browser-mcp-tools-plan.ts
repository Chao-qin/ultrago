/**
 * The plan family: declaring a multi-step plan, advancing its cursor, reading
 * its state, aborting it, and closing a recording.
 *
 * Split out of browser-mcp.ts. These five tools talk only to the PlanRunner —
 * they neither read nor write the session's routing state — which is why they
 * are the group that can stand alone with the smallest surface: a server to
 * register on and the runner to drive.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Playbook, PlanStep } from "@bcp/shared";
import type { PlanRunner } from "./orchestrator.js";
import { savePlaybook } from "./playbook.js";
import { describeRecording, describeVerify, fail, text } from "./browser-mcp-render.js";
import { looseBool, stepShape } from "./browser-mcp-shapes.js";

export interface PlanToolDeps {
  server: McpServer;
  /** This session's runner — plan/advance/abort all drive exactly this one. */
  runner: PlanRunner;
}

/** Registers plan / advance / plan_status / plan_abort / record_stop. */
export function registerPlanTools({ server, runner }: PlanToolDeps): void {
  server.registerTool(
    "plan",
    {
      description:
        "Register a multi-step task as ordered steps, each with its own done-criteria (verify), then work through it with advance: you perform each step with the normal tools, and advance reads the page itself and does not move on until the step's verify holds. Use it for forms, wizards and publish or checkout flows; skip it for one or two actions. Every step needs a real verify (an empty one is rejected). Prefer checks the runner measures — elementValue for a field's value, networkOk (plus bodyIncludes for the response body) for a save that must reach the server, evalCheck for anything a page expression can compute — over assert / visualAssert, which hand the judgment back to you. Pass record to save the run as a playbook (see record_stop). In manual mode, claim a tab first. When the backend runs with BCP_FORCE_PLAN=on, mutating tools are refused without an active plan.",
      inputSchema: {
        goal: z.string().describe("What the whole plan achieves"),
        steps: z.array(stepShape).min(1).describe("Ordered steps, each with its own goal and verify"),
        record: z
          .object({
            paramNames: z.array(z.string()).describe("Names of the playbook's inputs"),
            paramValues: z.record(z.string(), z.string()).describe("This run's value for each name"),
          })
          .optional()
          .describe(
            "Record this run as a playbook: the action of every advanced step is captured, and record_stop saves it. On save, every string in a step's action or verify that exactly equals one of paramValues becomes that name's {{slot}}.",
          ),
      },
    },
    async ({ goal, steps, record }) => {
      try {
        const { planId, total, first } = await runner.create(goal, steps as PlanStep[], record);
        return text(
          `Plan ${planId} registered — ${total} step(s). Goal: ${goal}${record ? " (recording ON)" : ""}\n\n` +
            `Step 1/${total}: ${first.goal}\n  done when: ${describeVerify(first.verify)}\n\n` +
            `Do this step with the normal tools, then call advance({planId:"${planId}"}). It won't let you proceed until the runner confirms this step.`,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "advance",
    {
      description:
        "Check the current step of a plan against its verify and move on. Pass returns the next step; fail says what is still wrong and whether to redo the step (onFail retry or rescan, while maxRetries lasts) or stop (escalate, the default). It does not perform the action — act first, then call advance. For a step with assert / visualAssert, the first call returns the claim; look at the page, then call again with confirm.",
      inputSchema: {
        planId: z.string().describe("Plan id from plan() / run_playbook"),
        confirm: looseBool.optional().describe("Your verdict on the step's assert / visualAssert after looking: true if it holds, false if not"),
      },
    },
    async ({ planId, confirm }) => {
      try {
        const r = await runner.advance(planId, confirm);
        if (r.kind === "judgeVisual") {
          const prompt =
            `⏸ Step ${r.index + 1}/${r.total} passed its mechanical checks but needs YOUR VISUAL judgment (🟡 agent-judged): "${r.claim}".\n` +
            `A screenshot is attached — look at it, then call advance({planId:"${planId}", confirm:true}) if it holds, or confirm:false if not.`;
          const b64 = r.dataUrl.replace(/^data:image\/\w+;base64,/, "");
          return b64
            ? { content: [{ type: "image" as const, data: b64, mimeType: "image/png" }, { type: "text" as const, text: prompt }] }
            : text(prompt + "\n(screenshot unavailable — use screenshot/analyze_page yourself, then confirm.)");
        }
        let msg: string;
        if (r.kind === "complete")
          msg =
            `✅ Plan complete — all ${r.total} step(s) verified.${describeRecording(r.recording)}` +
            (r.recording ? `\nRecording finished — call record_stop({planId:"${planId}", name:"<playbook name>"}) to save it, or plan_abort to throw it away.` : "");
        else if (r.kind === "advanced")
          msg =
            `✓ Step verified.${describeRecording(r.recording)}\n` +
            `→ Step ${r.index + 1}/${r.total}: ${r.next.goal}\n  done when: ${describeVerify(r.next.verify)}`;
        else if (r.kind === "judge")
          msg =
            `⏸ Step ${r.index + 1}/${r.total} passed its mechanical checks but needs YOUR judgment (🟡 agent-judged, weaker than the structured checks): "${r.assert}".\n` +
            `Look yourself FIRST — read_content / snapshot, or screenshot for a visual claim — then call advance({planId, confirm:true}) if it holds, or confirm:false if not. Don't confirm blind.`;
        else if (r.kind === "retry")
          msg =
            `✗ Not verified yet: ${r.failed.join("; ")}.\n` +
            `Recovery: ${r.strategy}${r.strategy === "rescan" ? " — re-snapshot before retrying" : ""}. Redo the step, then call advance again (retries left: ${r.remaining}).`;
        else {
          const why = (r.step.onFail ?? "escalate") === "escalate"
            ? `This step stops on its first failure (onFail ${r.step.onFail ? '"escalate"' : 'not set — the default is "escalate"'})`
            : "Its retry budget is used up";
          msg =
            `⚠ Step ${r.index + 1}/${r.total} FAILED verification: ${r.failed.join("; ")}.\n` +
            `Goal was: ${r.step.goal}. ${why} — STOP: fix the underlying cause then advance again, replan, or ask the user. Do NOT proceed as if it succeeded.`;
        }
        return text(msg);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "plan_status",
    {
      description:
        "Show a plan's current step and its verify, and, while recording, how many steps have captured a replayable action. Use it to re-orient in a long task.",
      inputSchema: { planId: z.string().describe("Plan id from plan() / run_playbook") },
    },
    async ({ planId }) => {
      try {
        const s = runner.status(planId);
        const r = s.recording;
        const rec = !r
          ? ""
          : s.done
            ? `\n⏺ Recording finished — ${r.captured}/${s.total} step(s) captured a replayable action` +
              (r.checkOnly ? `, ${r.checkOnly} check-only (auto replay will pause there)` : "") +
              `.\n  record_stop({planId:"${planId}", name:"<name>"}) saves it (an existing playbook of that name is kept unless you pass overwrite:true). plan_abort throws it away.`
            : `\n⏺ RECORDING — ${r.captured}/${s.index} finished step(s) captured a replayable action` +
              (r.checkOnly ? `, ${r.checkOnly} saved check-only (auto replay will pause there)` : "") +
              `. Slots: ${r.paramNames.join(", ") || "(none declared)"}.` +
              `\n  While recording: ONE mutating action per step, and don't target elements by ref (refs die with the snapshot).`;
        if (s.done) return text(`Plan "${s.goal}" — ✅ complete (${s.total}/${s.total}).${rec}`);
        return text(
          `Plan "${s.goal}" — step ${s.index + 1}/${s.total}: ${s.current!.goal}\n  done when: ${describeVerify(s.current!.verify)}${rec}`,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "plan_abort",
    {
      description:
        "End a plan or a paused playbook run early — the only way to: record_stop refuses an unfinished plan, and an abandoned plan stays active (with BCP_FORCE_PLAN on, it keeps permitting actions). Its recording is discarded; saved playbooks are untouched. Nothing done in the browser is undone.",
      inputSchema: { planId: z.string().describe("Plan id to abort") },
    },
    async ({ planId }) => {
      try {
        const a = runner.abort(planId);
        return text(
          `Plan ${planId} aborted at step ${Math.min(a.index + 1, a.total)}/${a.total} ("${a.goal}").` +
            (a.wasRecording ? " Its recording was discarded — nothing saved." : "") +
            `\nNote: actions already performed in the browser were NOT undone.`,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "record_stop",
    {
      description:
        "Save a completed recording plan (one started with record) as resource/playbooks/<name>.json and return the JSON. Every step must have been advanced. Review the result: slots are substituted by exact value, so a value that happens to appear elsewhere becomes a slot there too.",
      inputSchema: {
        planId: z.string().describe("The completed recording plan's id"),
        name: z.string().describe('Playbook name, also its file name: a letter or digit, then letters, digits, ".", "_" or "-"'),
        overwrite: looseBool.optional().describe("Replace an existing playbook with this name (default false: refuse)"),
      },
    },
    async ({ planId, name, overwrite }) => {
      try {
        const { steps, paramNames, warnings } = runner.stopRecording(planId);
        const status = runner.status(planId);
        const pb: Playbook = { name, goal: status.goal, paramNames, steps };
        const path = await savePlaybook(pb, { overwrite });
        const warnText = warnings.length ? `\n⚠ ${warnings.join("\n⚠ ")}` : "";
        return text(`Saved playbook "${name}" → ${path}${warnText}\n\nReview before trusting it:\n${JSON.stringify(pb, null, 2)}`);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
