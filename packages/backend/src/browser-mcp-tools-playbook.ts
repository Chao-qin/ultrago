/**
 * Local side-effects and playbook execution: local_eval, write_file,
 * list_playbooks and run_playbook.
 *
 * Split out of browser-mcp.ts. run_playbook owns a browser context and tidies
 * up the claimed tab when a run ends, so it reads the session's claim — through
 * `getClaimed`, never a captured value, since a run outlives the claim it
 * started with.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LocalMethod, MCP_TOOL_INSTRUCTIONS, RpcMethod, validateBookV2, type BrowserTarget, type ParamMap, type Playbook, type PlanStep } from "@bcp/shared";
import { config, EVAL_DISABLED, LOCAL_EVAL_DISABLED } from "./config.js";
import { applyParamDefaults, instantiateSteps, listPlaybooks, loadPlaybook, savePlaybook, validatePlaybookParams } from "./playbook.js";
import { materializePlaybookUpload } from "./playbook-upload.js";
import { keepFailedTabs, runAutoPlayback, type RunFinishInfo } from "./playback.js";
import { RunBrowserContext } from "./run-browser-context.js";
import { runLocalEval, writeLocalFile } from "./local-actions.js";
import { extractArtifacts, extractOutputs, instantiateDeliveries } from "./delivery-executor.js";
import type { DeliverySink } from "./console-delivery-client.js";
import type { EventStore, RunFinishedEvent } from "./event-store.js";
import type { PlanRunner } from "./orchestrator.js";
import { RECORDABLE_READS } from "./recordable-methods.js";
import type { BrowserCall } from "./browser-mcp-types.js";
import type { Claim } from "./browser-mcp-tools-tabs.js";
import { describeVerify, fail, text } from "./browser-mcp-render.js";
import { looseBool, tabId } from "./browser-mcp-shapes.js";

export interface PlaybookToolDeps {
  server: McpServer;
  call: BrowserCall;
  events: EventStore;
  runner: PlanRunner;
  deliverySink?: DeliverySink;
  resolvedTarget: () => BrowserTarget | null;
  claimFor: (target: BrowserTarget | null) => number | undefined;
  setClaimed: (next: Claim) => void;
  /** Live read — a run outlives the claim it started with. */
  getClaimed: () => Claim;
  playbackContexts: Map<string, RunBrowserContext>;
  playbackParams: Map<string, ParamMap>;
}

/** Registers local_eval / write_file / list_playbooks / run_playbook. */
export function registerPlaybookTools({
  server, call, events, runner, deliverySink,
  resolvedTarget, claimFor, setClaimed, getClaimed,
  playbackContexts, playbackParams,
}: PlaybookToolDeps): void {
  server.registerTool(
    "local_eval",
    {
      description:
        "Run JS in the BACKEND process (NOT the browser page — for that, use the eval tool) against `results`, this plan's collected step values so far (every prior step that read/mutated something, in order — see plan()). Returns the code's value. Use to turn browser reads you've already done into an artifact, e.g. build a markdown report string from an earlier eval/read_content step's data, then hand it to write_file. Gated by the backend-JS policy — on by default in the desktop client (the user can turn it off), off in a dev backend unless BCP_LOCAL_EVAL=on — since this runs in the backend's own process (bigger blast radius than page eval, which is at least confined to a browser tab). If this plan is recording (plan(..., {record})), this call is captured as that step's action exactly like a click/type would be — record_stop saves it, and run_playbook(mode:\"auto\") replays it with zero agent involvement later. Call advance({planId}) afterward either way.",
      inputSchema: { planId: z.string(), code: z.string() },
    },
    async ({ planId, code }) => {
      try {
        if (!config.localEvalEnabled)
          throw new Error(LOCAL_EVAL_DISABLED);
        const priorResults = runner.getResults(planId); // throws a clear error if planId is unknown
        const value = runLocalEval(code, priorResults);
        runner.noteAction({ method: LocalMethod.Eval, params: { code } }, value);
        return text(`local.eval → ${JSON.stringify(value)}\n\nCall advance({planId:"${planId}"}) to confirm this step.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "write_file",
    {
      description:
        "Write the immediately preceding step's value (typically a local_eval's markdown/text output) to reports/<path> — a path that escapes reports/ is refused. If this plan is recording, this call is captured as that step's action like any other — record_stop saves it, run_playbook(mode:\"auto\") replays it later with zero agent involvement. Call advance({planId}) afterward either way.",
      inputSchema: { planId: z.string(), path: z.string() },
    },
    async ({ planId, path }) => {
      try {
        const priorResults = runner.getResults(planId); // throws a clear error if planId is unknown
        const prev = priorResults.at(-1)?.value;
        const abs = await writeLocalFile(path, typeof prev === "string" ? prev : JSON.stringify(prev));
        runner.noteAction({ method: LocalMethod.WriteFile, params: { path } }, { path: abs });
        return text(`Wrote ${abs}\n\nCall advance({planId:"${planId}"}) to confirm this step.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_playbooks",
    {
      description:
        "List the playbooks saved on this machine — name, goal, the {{slot}} params each one expects, and step count. run_playbook needs an exact name AND a matching param set, so check here before assuming a task has to be driven (or recorded) from scratch.",
      inputSchema: {},
    },
    async () => {
      try {
        const { playbooks, unreadable } = await listPlaybooks();
        const bad = unreadable.length ? `\n\n⚠ Not valid playbook JSON, skipped: ${unreadable.join(", ")}` : "";
        if (!playbooks.length) return text(`No playbooks saved yet — record one with plan(..., {record}) then record_stop.${bad}`);
        const lines = playbooks.map(
          (p) => `- ${p.name} (${p.steps} step${p.steps === 1 ? "" : "s"}) — ${p.goal}\n    params: ${p.paramNames.join(", ") || "(none)"}`,
        );
        return text(`Saved playbooks:\n${lines.join("\n")}${bad}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "run_playbook",
    {
      description:
        'Load a saved playbook and run it. mode:"assisted" (default) registers it as a normal plan — YOU still perform each step\'s action yourself (the step\'s `action` field names exactly what to do), advance() gates as usual. mode:"auto" runs it with ZERO agent involvement until it either completes or hits a step that needs you: a risk:"confirm" step (STOPS BEFORE acting — every run, no exceptions), an assert/visualAssert judgment, a step with no recorded action, or an exhausted retry. On a stop, the response says exactly what to do; after handling it, call run_playbook again with resumePlanId set to continue the SAME run instead of starting over.',
      inputSchema: {
        name: z.string(),
        params: z.record(z.string(), z.unknown()).optional().describe("Concrete values for this run's {{slot}} placeholders; omit when resuming with resumePlanId"),
        paramsFile: z.string().optional().describe("Path to a JSON file holding the same object as `params`. For a book whose input is large (a product with 70+ SKUs runs past 12KB), inlining it into the tool call is what actually breaks — the JSON gets truncated in transit and the run never starts. Mutually exclusive with `params`."),
        mode: z.enum(["assisted", "auto"]).optional().describe('Default "assisted". "auto" = hard-script playback, no agent needed except at risk/judge/no-action checkpoints.'),
        resumePlanId: z.string().optional().describe("Resume an existing paused auto-mode plan instead of loading the playbook again — pass the planId a previous run_playbook(mode:\"auto\") call returned in its pause message."),
      },
    },
    async ({ name, params, paramsFile, mode, resumePlanId }, extra) => {
      try {
        if (params && paramsFile) {
          throw new Error("pass either params or paramsFile, not both — two sources for the same values is a silent-mismatch waiting to happen");
        }
        if (paramsFile) {
          const raw = await readFile(resolve(paramsFile), "utf8");
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error(`${paramsFile} must contain a JSON object of param values, got ${Array.isArray(parsed) ? "an array" : typeof parsed}`);
          }
          params = parsed as Record<string, unknown>;
        }
        let planId: string;
        let steps: PlanStep[] = [];
        let pb: Playbook | undefined;
        let values: ParamMap = params ?? {};
        if (resumePlanId) {
          runner.status(resumePlanId); // throws a clear error if planId is unknown
          planId = resumePlanId;
          // The resumed plan keeps the ORIGINAL instantiated steps — re-running
          // loadPlaybook+instantiateSteps here could resolve {{slot}}s from the
          // resume call's (possibly different) params. runAutoPlayback's failure
          // cleanup needs the list to know which trailing close steps a failed
          // resumed run skipped.
          steps = runner.stepsOf(resumePlanId);
          // Still reload the book for its `deliveries` (the finish event needs
          // them); steps/params stay the original instantiated ones.
          pb = await loadPlaybook(name);
          const frozen = playbackParams.get(resumePlanId);
          if (!frozen) throw new Error(`run context for plan "${resumePlanId}" is unavailable; resume the original MCP session`);
          values = frozen;
        } else {
          const runId = randomUUID();
          planId = `plan_${randomUUID().slice(0, 8)}`;
          pb = await loadPlaybook(name);
          // Book v2 gate: only for books with schemaVersion; recorded playbooks
          // (no schemaVersion) are plain step lists without pages/signals.
          const v2 = pb.schemaVersion != null ? validateBookV2(pb) : undefined;
          values = applyParamDefaults(pb.params, params ?? {}, { bookName: name, runId, planId, uuid: randomUUID() });
          const problems = validatePlaybookParams(pb.params, values);
          if (problems.length) {
            return fail(`run_playbook("${name}") params invalid: ${problems.join("; ")}`);
          }
          steps = instantiateSteps(pb.steps, values);
          const created = await runner.create(pb.goal, steps, undefined, planId, v2?.pages);
          if (created.planId !== planId) throw new Error(`backend created unexpected planId ${created.planId}`);
          playbackParams.set(planId, values);
        }
        if ((mode ?? "assisted") === "assisted") {
          const s = runner.status(planId);
          if (s.done) return text(`Plan ${planId} is already complete — nothing left to do.`);
          return text(
            `Plan ${planId}${resumePlanId ? "" : ` loaded from playbook "${name}"`} — step ${s.index + 1}/${s.total}: ${s.current!.goal}\n` +
              `  action: ${s.current!.action ? `${s.current!.action.method} ${JSON.stringify(s.current!.action.params)}` : "(check-only)"}\n` +
              `  done when: ${describeVerify(s.current!.verify)}\n\n` +
              `Perform it, then advance({planId:"${planId}"}).`,
          );
        }
        // CLAIM-only safety net (the ENGINE already owns run-resource cleanup:
        // runAutoPlayback's trackedCall closes every tab this run opened, and
        // a recorded close step releases the claim through the CloseTab branch
        // of the closure below). What's left for us: a step's action can fail
        // two different ways — its own onFail:"escalate" budget exhausting
        // (runAutoPlayback returns kind:"escalate") or the action itself
        // throwing (e.g. an eval step's own fail-closed `throw`, the way the
        // real doubao-ask submit/watermark failures surface — NOT via
        // escalate). Either way the step sequence never reaches its closing
        // step, so release a claim this run left dangling and close anything
        // still claimed by this session (learn.md 2026-08-21). A "complete"
        // run is unaffected — the book's own last step already released it.
        const closeLeakedClaim = async () => {
          // Same opt-out as the engine's closeTrackedTabs (playback.ts): this is
          // the SECOND path that closes a failed run's window, and honouring the
          // flag in only one of them is worse than not having it — the backend
          // logs "leaving 1 tab open for inspection" and the tab vanishes
          // anyway, which is how a debugging aid becomes a lie.
          const held = getClaimed();
          if (keepFailedTabs()) {
            if (held) console.warn(`[mcp] BCP_KEEP_FAILED_TABS=1 — leaving claimed tab ${held.tabId} open for inspection`);
            setClaimed(null);
            return;
          }
          const tgt = resolvedTarget();
          if (held && held.target?.instanceId === tgt?.instanceId) {
            try {
              await call(RpcMethod.CloseTab, { tabId: held.tabId } as never);
            } catch {
              /* best-effort — the tab/window may already be gone (e.g. a
                 playbook close_window step shut the whole window) */
            } finally {
              // Release the claim no matter what: a failed close leaves a dead
              // tabId behind, and the next claim-based call would act on it.
              setClaimed(null);
            }
          }
        };
        let r: Awaited<ReturnType<typeof runAutoPlayback>>;
        const onFinish = async (info: RunFinishInfo): Promise<void> => {
          // The MCP path does NOT execute deliveries — that's the console
          // layer's job (SQLite-backed durability). Here we only resolve the
          // book's deliveries and broadcast the finish event.
          const deliveries = instantiateDeliveries(pb?.deliveries, values);
          const outputs = extractOutputs(info.results);
          const artifacts = extractArtifacts(info.results);
          const ev: RunFinishedEvent = {
            kind: "run_finished",
            ts: Date.now(),
            planId,
            bookName: name,
            trigger: "mcp",
            status: info.status,
            ranSteps: info.ranSteps,
            totalSteps: info.totalSteps,
            durationMs: info.durationMs,
            error: info.error,
            outputs,
            deliveries,
            runId: `mcp_${planId}`,
            artifacts,
          };
          if (deliverySink) {
            await deliverySink.ingest({
              runId: `mcp_${planId}`,
              planId,
              bookName: name,
              trigger: "mcp",
              mode: (mode ?? "assisted") as "assisted" | "auto",
              status: info.status,
              ranSteps: info.ranSteps,
              totalSteps: info.totalSteps,
              durationMs: info.durationMs,
              error: info.error,
              params: values,
              outputs,
              deliveries,
              artifacts,
            });
          }
          events.emitRunFinished(ev);
        };
        /**
         * Per-step MCP progress. A long book runs SILENT otherwise, and a silent
         * call is indistinguishable from a hung one: the client kills it on its
         * idle timeout ("sent no response or progress for 300s; aborting").
         * 2026-09-03 this cost three full runs of a 20-minute collection book —
         * the run was fine every time, the CALL was what got torn down.
         *
         * The engine already exposes onStep (fires after a step's verify holds);
         * all that was missing was forwarding it. Progress is best-effort: a
         * client that sends no progressToken gets nothing, and a failed
         * notification must never sink a run that is otherwise healthy.
         */
        const progressToken = extra?._meta?.progressToken;
        const totalSteps = steps.length;
        const emitProgress =
          progressToken == null
            ? undefined
            : (info: { index: number; goal: string }): void => {
                void extra
                  .sendNotification({
                    method: "notifications/progress",
                    params: {
                      progressToken,
                      progress: info.index,
                      total: totalSteps,
                      message: `步骤 ${info.index + 1}/${totalSteps}：${info.goal.slice(0, 70)}`,
                    },
                  })
                  .catch(() => {});
              };
        // Kept by planId across pause/resume. The same instance routes both
        // playback actions and PlanRunner's verification evidence.
        const browserContext = playbackContexts.get(planId) ?? new RunBrowserContext();
        playbackContexts.set(planId, browserContext);
        try {
          r = await runAutoPlayback(runner, planId, async (method, p, priorResults) => {
          // call() reaches RpcMethod.Eval directly here, bypassing the eval
          // TOOL's own evalEnabled check (same gap evalCheck already has to
          // guard against above) — enforce policy at this call site too.
          if (method === RpcMethod.Eval && !config.evalEnabled)
            throw new Error(`recorded eval step needs page JS — ${EVAL_DISABLED}`);
          // local.* steps don't route through call() (no browser/RPC involved),
          // so — unlike RpcMethod above — THIS closure is responsible for
          // noteAction()-ing them itself, same as the local_eval/write_file
          // tools do for a live-driven plan.
          if (method === LocalMethod.Eval) {
            if (!config.localEvalEnabled)
              throw new Error(`recorded local.eval step needs backend JS — ${LOCAL_EVAL_DISABLED}`);
            const value = runLocalEval((p as { code: string }).code, priorResults);
            runner.noteAction({ method, params: p }, value);
            return value;
          }
          if (method === LocalMethod.WriteFile) {
            const prev = priorResults.at(-1)?.value;
            const wf = p as { path: string; overwrite?: "overwrite" | "error" | "rename" };
            const abs = await writeLocalFile(wf.path, typeof prev === "string" ? prev : JSON.stringify(prev), { overwrite: wf.overwrite });
            const value = { path: abs };
            runner.noteAction({ method, params: p }, value);
            return value;
          }
          if (method === RpcMethod.CloseTab) {
            // Mirror of the claim below (and of what the close_tab TOOL does):
            // replay reaches call() directly, so without this the claim keeps
            // pointing at the tab we just closed and the NEXT tabId-less call —
            // this step's own verify — gets a dead tab injected into it.
            const tgt = resolvedTarget();
            const target = (p as { tabId?: number }).tabId ?? claimFor(tgt);
            const r = await call(method as RpcMethod, p as never);
            const c = getClaimed();
            if (c && c.tabId === target && c.target?.instanceId === tgt?.instanceId) setClaimed(null);
            return r;
          }
          if (method === RpcMethod.NewTab || method === RpcMethod.NewWindow) {
            // A recorded new_tab/new_window IS this run's workspace. Later steps
            // record no tabId (so they stay portable), and would otherwise default
            // to whatever tab this session already claimed — i.e. the PREVIOUS
            // run's. Claim what we just opened, mirroring what the tool's
            // claim:true does when a human drives the same plan live.
            const tgt = resolvedTarget();
            const opened = (await call(method as RpcMethod, p as never)) as { tabId: number };
            setClaimed({ target: tgt, tabId: opened.tabId });
            return opened;
          }
          return call(method as RpcMethod, p as never);
          },
          steps,
          { context: browserContext, onFinish, onStep: emitProgress });
        } catch (e) {
          playbackContexts.delete(planId);
          playbackParams.delete(planId);
          await closeLeakedClaim();
          throw e;
        }
        if (r.kind === "complete" || r.kind === "escalate") {
          playbackContexts.delete(planId);
          playbackParams.delete(planId);
        }
        // Persist whatever verified steps learned, whatever the run's terminal
        // kind — complete, escalate, or a pause (check-only / confirm / judge)
        // with earlier verified steps already behind it. Writes once, best-effort.
        if (r.kind === "complete") {
          const reads = r.results.filter((x) => RECORDABLE_READS.has(x.method as RpcMethod));
          const readsText = reads.length
            ? "\n\n" +
              reads
                .map((x) => {
                  const body =
                    x.method === RpcMethod.Eval
                      ? JSON.stringify((x.value as { value: unknown }).value)
                      : (x.value as { text: string }).text;
                  return `— step ${x.index + 1} ("${x.goal}"):\n${body}`;
                })
                .join("\n\n")
            : "";
          const written = r.results.filter((x) => x.method === LocalMethod.WriteFile);
          const writtenText = written.length
            ? "\n\n" + written.map((x) => `📄 step ${x.index + 1} wrote ${(x.value as { path: string }).path}`).join("\n")
            : "";
          return text(`✅ Playbook "${name}" complete — ${r.ranSteps} step(s) ran with zero agent involvement.${readsText}${writtenText}`);
        }
        if (r.kind === "needsConfirm")
          return text(
            `⏸ Playbook paused at step ${r.index + 1} ("${r.step.goal}") — marked risk:"confirm" (irreversible). This needs YOUR explicit go-ahead before it executes, every run. ` +
              `To proceed: perform ${JSON.stringify(r.step.action)} yourself with confirm:true, then advance({planId:"${planId}"}), then call run_playbook again with resumePlanId:"${planId}" to resume the rest.`,
          );
        if (r.kind === "needsJudge")
          return text(
            `⏸ Playbook paused at step ${r.index + 1} — needs your judgment: "${r.assert}". Judge it, call advance({planId:"${planId}", confirm:true|false}), then re-call run_playbook with resumePlanId:"${planId}" to resume.`,
          );
        if (r.kind === "noAction")
          return text(
            `⏸ Playbook paused at step ${r.index + 1} ("${r.step.goal}") — this step has no recorded action (check-only or an ambiguous recording), auto mode can't perform it. Do it yourself, advance({planId:"${planId}"}), then re-call run_playbook with resumePlanId:"${planId}" to resume.`,
          );
        // r.kind === "escalate": terminal failure (onFail budget exhausted), no
        // resume expected — same leaked-claim risk as the catch block above,
        // just via advance() returning a result instead of throwing.
        await closeLeakedClaim();
        // 报「在哪一步失败」不够 —— 失败的那一步常常只是【下游受害者】。实测面膜那次：
        // 报的是 step 21(上传规格图)，而真因是 step 19 智能识别连续失败，规格区压根
        // 没生成。用户照着 step 21 去查，方向就错了两步。
        // 所以把上游步骤自己报的 reason 一并带出来：动作返回 ok:false 且给了 reason 的，
        // 就是它自己知道哪里不对却没能阻断流程的地方。
        const reasonOf = (v: unknown): string | null => {
          const pick = (o: unknown): string | null => {
            const x = o as { ok?: unknown; reason?: unknown; hint?: unknown } | null | undefined;
            if (!(x && typeof x === "object" && x.ok === false && typeof x.reason === "string")) return null;
            return `${x.reason}${typeof x.hint === "string" ? ` — ${x.hint}` : ""}`;
          };
          // ⚠️ browser.eval 记下来的是 RPC 信封 `{ value: <真正的返回值> }`，不是裸值。
          // 只在信封上找 ok/reason 永远找不到 —— 而 browser.eval 占全仓 book 步骤的 98%，
          // 也就是说「上游线索」这个功能对绝大多数步骤从来没生效过（2026-09-16 靠
          // .playbook-runs.jsonl 的 trace 才看出来：value 是 {"value":{...ok:false...}}）。
          // 两层都试：只认信封会漏 browser.eval，只认裸值会漏 local.* 那类直接返回值的。
          return pick(v) ?? pick((v as { value?: unknown } | null | undefined)?.value);
        };
        const upstream: string[] = [];
        for (const x of r.results ?? []) {
          if (x.index >= r.index) continue;
          const t = reasonOf(x.value);
          if (t) upstream.push(`  · step ${x.index + 1}: ${t}`);
        }
        // 失败那一步【自己】的 reason。`results` 只在 verify 通过后才 push，所以它从来不在
        // results 里 —— 得靠 escalate 额外带出的 ownValue。没有这一行的后果是实测过的：
        // action 已经算出 'product-not-found' 还附了 hint，外部却只看到 "after timed out"，
        // 于是我把「组件没就绪」读成「这个商品不符合提报要求」，去查了半天商品好评率。
        const ownText = reasonOf(r.ownValue);
        const ownReason = ownText ? `\n本步 action 自己报的原因：${ownText}` : "";
        const upstreamText = upstream.length
          ? `\n上游线索（这些步骤自己报了失败但没阻断流程，真因通常在这里）：\n${upstream.join("\n")}`
          : "";
        const goalBrief = (r.step?.goal ?? "").slice(0, 60);
        return text(
          `⚠ Playbook FAILED at step ${r.index + 1}${goalBrief ? ` (${goalBrief}…)` : ""}: ` +
            `${r.failed.join("; ")}. Auto-recovery exhausted.${ownReason}${upstreamText}`,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );
}
