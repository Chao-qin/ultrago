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
        "Register an ordered, verifiable plan for a MULTI-STEP task, then work it with advance(). Each step declares its own done-criteria (verify) + recovery (onFail); once you're in a plan, advance re-reads the page ITSELF and won't move to the next step until the current step's verify holds. IMPORTANT — this is an OPT-IN gate: P0 does NOT force your actions through the plan, so its value depends on you choosing to plan multi-step tasks and giving each step a REAL, non-empty verify (empty or \"\" verifies are rejected). Verification is COARSE (structural facts only — no response body, no CDP): it can't prove an exact field value or a business result carried in a 200 body. In manual mode, claim a tab first (verification reads target your claimed/current tab). Skip planning for a trivial single action; you still perform each action with the normal tools — plan/advance only gate.",
      inputSchema: {
        goal: z.string(),
        steps: z.array(stepShape).min(1),
        record: z
          .object({ paramNames: z.array(z.string()), paramValues: z.record(z.string(), z.string()) })
          .optional()
          .describe(
            "Turn on recording for this plan. Every advance()'d step's action gets captured; record_stop() then saves it as a reusable playbook. paramValues are THIS run's concrete values for each paramName — used to auto-substitute {{slot}} placeholders when saving.",
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
        "Verify the CURRENT step of a plan and move to the next. The runner gathers its own evidence and checks the step's declared criteria: pass → returns the next step; fail → says what's still wrong and whether to retry/rescan or that recovery is exhausted (escalate). It never performs the action — do that first, then call this. If the step has an agent-judged `assert`, a first advance (after the mechanical checks pass) returns the claim for YOU to judge — gather evidence / screenshot, then call advance again with confirm:true (it holds) or confirm:false (it doesn't).",
      inputSchema: {
        planId: z.string(),
        confirm: looseBool.optional().describe("Your verdict for a step's agent-judged `assert`, AFTER you've looked: true = it holds, false = it doesn't"),
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
        else
          msg =
            `⚠ Step ${r.index + 1}/${r.total} FAILED verification: ${r.failed.join("; ")}.\n` +
            `Goal was: ${r.step.goal}. Auto-recovery is exhausted — STOP: fix the underlying cause then advance again, replan, or ask the user. Do NOT proceed as if it succeeded.`;
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
        "Show a plan's current step and its done-criteria — use it to re-orient if you've lost track of where you are in a multi-step task. Also reports whether the plan is RECORDING and how much of it has captured a replayable action so far, which nothing else surfaces once plan()'s reply has scrolled away.",
      inputSchema: { planId: z.string() },
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
              `.\n  record_stop({planId:"${planId}", name:"<name>"}) saves it — re-saving the same name just overwrites. plan_abort throws it away.`
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
        "Drop a plan you're not going to finish — a recording you'd rather re-do from scratch, or an auto-playbook run that went wrong and shouldn't be resumed. Any recording is DISCARDED (nothing is written to disk; already-saved playbooks are untouched). This is the only way to end a run early: record_stop refuses an incomplete plan by design, and an abandoned plan otherwise stays 'active' — which matters when BCP_FORCE_PLAN is on, since it would keep letting mutating actions through. Page state is NOT rolled back; whatever the run already did to the browser stays done.",
      inputSchema: { planId: z.string() },
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
        "Finalize a recording plan (started via plan(..., {record})) into a playbook, saved to resource/playbooks/<name>.json. The plan must be COMPLETE (every step advanced) — a half-finished run isn't a usable playbook. Review the returned JSON before trusting it: {{slot}} auto-substitution matches by exact value, so a coincidental match can misfire.",
      inputSchema: { planId: z.string(), name: z.string() },
    },
    async ({ planId, name }) => {
      try {
        const { steps, paramNames, warnings } = runner.stopRecording(planId);
        const status = runner.status(planId);
        const pb: Playbook = { name, goal: status.goal, paramNames, steps };
        const path = await savePlaybook(pb);
        const warnText = warnings.length ? `\n⚠ ${warnings.join("\n⚠ ")}` : "";
        return text(`Saved playbook "${name}" → ${path}${warnText}\n\nReview before trusting it:\n${JSON.stringify(pb, null, 2)}`);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
