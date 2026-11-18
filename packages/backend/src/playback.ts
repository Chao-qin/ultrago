import { appendFile } from "node:fs/promises";
import { RpcMethod } from "@bcp/shared";
import type { PlanStep, RpcErrorInfo } from "@bcp/shared";
import type { AdvanceResult, PlanRunner, PlaybackStepResult } from "./orchestrator.js";
import { rpcErrorInfoOf } from "./rpc-bridge.js";
import { RunBrowserContext } from "./run-browser-context.js";
import { envFlag } from "./config.js";

/**
 * Action failures a different way of reaching the element could still fix.
 *
 * Everything else — a timeout, a closed tab, a disconnected extension, an
 * untagged error from an older extension — is NOT in here, and the default for
 * anything unrecognised is "not recoverable". Widening this set is how a
 * disconnected browser would end up being treated as a stale selector.
 *
 * `REF_UNKNOWN` / `REF_STALE` are deliberately excluded: a ref is snapshot-
 * scoped and has no business being in a replayable book at all (the recorder
 * warns at record time), so a stale one is an authoring bug, not page drift.
 */
const RECOVERABLE_ACTION_ERRORS = new Set<RpcErrorInfo["code"]>([
  "LOCATOR_NO_MATCH",
  "LOCATOR_AMBIGUOUS",
  "LOCATOR_NTH_RANGE",
]);

export type { PlaybackStepResult } from "./orchestrator.js";

/** Whatever browser-mcp.ts's `call()` looks like — auto playback reuses it
 * verbatim, the same function the click/type/etc tool handlers already call.
 * `priorResults` is this run's PlaybackStepResult[] so far (from
 * PlanRunner.getResults — the SAME log a live local_eval/write_file tool call
 * reads) — a `local.*` step's backend-side handler reads it to turn earlier
 * browser reads into an artifact; a browser RpcMethod call ignores it. */
export type CallFn = (
  method: string,
  params: Record<string, unknown>,
  priorResults: PlaybackStepResult[],
  opts?: { cleanup?: boolean; page?: string },
) => Promise<unknown>;

export type AutoPlaybackResult =
  | { kind: "complete"; ranSteps: number; results: PlaybackStepResult[] }
  | { kind: "needsConfirm"; index: number; step: PlanStep }
  | { kind: "needsJudge"; index: number; step: PlanStep; assert?: string; dataUrl?: string }
  /** `diagnosis` is present only when the step's ACTION failed to reach an
   *  element (as opposed to a verify that did not hold): it carries which
   *  dimension excluded everything and what the page offered instead. */
  // results 一并带出：失败的那一步常常只是【下游受害者】。实测面膜那次报的是
  // step 21(上传规格图)，真因却是 step 19 智能识别连续失败、规格区压根没生成 ——
  // 用户照着 step 21 查，方向就错了两步。见 browser-mcp 的「上游线索」。
  | {
      kind: "escalate";
      index: number;
      step: PlanStep;
      failed: string[];
      diagnosis?: RpcErrorInfo;
      results?: PlaybackStepResult[];
      /** 失败那一步自己的动作返回值 —— `results` 只装 verify 通过的步骤，见 orchestrator 同名字段。 */
      ownValue?: unknown;
    }
  /** This step has no recorded action (check-only, or an ambiguous recording)
   * — auto mode has nothing to execute and can't guess. */
  | { kind: "noAction"; index: number; step: PlanStep };

/** Terminal outcome of a run — the values a `run_finished` event carries. */
export type RunOutcome = "success" | "escalated" | "failed" | "cancelled";

/** What the engine reports at a run's ONE terminal exit point. `onFinish` is
 * fired exactly once per run (pauses like needsConfirm/needsJudge/noAction are
 * NOT terminal — the client resumes and the run ends in some terminal state
 * later, firing then). */
export interface RunFinishInfo {
  planId: string;
  status: RunOutcome;
  ranSteps: number;
  totalSteps: number;
  durationMs: number;
  error?: string;
  /** This run's collected step values (last local.eval is the produced data). */
  results: PlaybackStepResult[];
}

export interface RunPlaybackOptions {
  /** Engine-level "run finished" hook — the channel assembles a RunFinishedEvent
   * from this and fires deliveries. The engine stays EventStore-agnostic. */
  onFinish?: (info: RunFinishInfo) => void | Promise<void>;
  /** Fired when the run's cursor ADVANCES to a new step (after the verify
   * gate passes) — the channel's live-progress signal (current goal + a
   * monotonic version bump), so observers can sync steps in real time instead
   * of only at terminal exit. */
  onStep?: (info: { index: number; goal: string }) => void;
  /**
   * A step reached its element by one dimension and the page offered others.
   *
   * Fired only AFTER that step's verify held — the element being the right one
   * is the entire premise, and the step's own verify is the only thing that
   * witnesses it. `add` never includes a dimension the author wrote by hand.
   *
   * The engine reports and does not persist: what a book on disk is, and when
   * a channel is willing to rewrite it, is the channel's business.
   */
  /** Shared with the caller's EvidenceReader: the sole target-tab state for this run. */
  context?: RunBrowserContext;
}

/**
 * Run a plan's remaining steps with ZERO agent involvement, until completion
 * or a step that inherently needs a human/agent verdict:
 * - `risk:"confirm"` → STOPS BEFORE executing that step's action. Every run,
 *   no exceptions, no pre-authorization flag — irreversible actions always
 *   need an explicit go-ahead at the moment they'd happen, not before.
 * - `verify` has `assert`/`visualAssert` → the mechanical checks still run
 *   automatically; advance() itself returns "judge"/"judgeVisual", surfaced
 *   here as needsJudge.
 * - `verify` fails and the step's onFail budget exhausts → advance() returns
 *   "escalate", surfaced as-is. A "retry"/"rescan" result is NOT escalated —
 *   this loop redoes the same action itself and tries again, bounded by the
 *   step's own maxRetries (enforced inside advance(), not here).
 *
 * This function never touches PlanRunner's internals directly — it only
 * calls the same public create/status/advance/getResults surface an
 * LLM-driven session would (getResults is what noteAction — invoked by call()
 * — feeds), so PlanRunner's documented "never performs page actions" invariant
 * stays true; the acting is entirely this loop's own doing. `results` is NOT
 * tracked locally — PlanRunner.getResults(planId) is the single source of
 * truth, so a resumed (paused-then-continued) run still sees the results from
 * before the pause, not just what THIS invocation ran.
 */
export async function runAutoPlayback(
  runner: PlanRunner,
  planId: string,
  call: CallFn,
  steps: PlanStep[],
  opts?: RunPlaybackOptions,
): Promise<AutoPlaybackResult> {
  const startedAt = Date.now();
  /**
   * Every run's outcome, appended to `.playbook-runs.jsonl` as it ends.
   *
   * Without this the ONLY record of a failure is the work window, and a window
   * does not survive: the run's own cleanup closes it, the user closes it while
   * watching, a backend restart takes it. The tool result names the failing
   * step but carries none of the step VALUES — so "why did it fail" was costing
   * a full re-run every time, and a re-run of a publishing book is not free.
   * Written before onFinish so a handler that throws cannot swallow it.
   */
  const journal = async (info: Omit<RunFinishInfo, "durationMs">): Promise<void> => {
    try {
      await appendFile(
        ".playbook-runs.jsonl",
        JSON.stringify({
          at: new Date().toISOString(),
          planId: info.planId,
          status: info.status,
          ranSteps: info.ranSteps,
          totalSteps: info.totalSteps,
          error: info.error,
          durationMs: Date.now() - startedAt,
          // The step values are the whole point — a step's own return value is
          // what says WHY it could not satisfy its verify.
          results: (info.results ?? []).map((r) => ({
            step: (r as { index?: number }).index != null ? ((r as { index: number }).index + 1) : null,
            method: (r as { method?: string }).method,
            value: (r as { value?: unknown }).value,
          })),
          // `results` still drops the steps worth reading most: the ones whose
          // verify FAILED. (It used to drop evalCheck-verified steps too — see
          // `verifying` in noteAction, which fixed that.) The trace keeps all.
          trace: (() => {
            try {
              return runner.getTrace(planId);
            } catch {
              return [];
            }
          })(),
        }) + "\n",
        "utf8",
      );
    } catch (e) {
      // Diagnostics must never break the run they are diagnosing.
      console.error("[playback] run journal write failed:", e);
    }
  };
  const finish = async (info: Omit<RunFinishInfo, "durationMs">): Promise<void> => {
    await journal(info);
    if (!opts?.onFinish) return;
    // Exactly-once: resuming an already-terminal plan re-enters this function
    // (status() doesn't throw on a done plan) and would re-fire onFinish —
    // double-delivering. The runner's CAS claim ensures only the first
    // terminal exit actually fires.
    if (!runner.finishClaimed(planId)) return;
    try {
      await opts.onFinish({ ...info, durationMs: Date.now() - startedAt });
    } catch (e) {
      // A delivery/handler bug must never corrupt the run's own outcome.
      console.error("[playback] onFinish handler threw:", e);
    }
  };
  // The ENGINE owns this run's resources, not the channel: track every tab a
  // new_tab/new_window step opens so a terminal failure can still close it even
  // when the book has no trailing close step (the MCP path used to lean on its
  // session claim for this, the console path on its own tracker — both fold
  // into this one tracking, so the two channels share the same behavior).
  const context = opts?.context ?? new RunBrowserContext();
  const trackedCall: CallFn = async (method, params, priorResults, opts) => {
    // Route a TAB_SCOPED step with no explicit tabId to THIS run's own tab —
    // the named page's binding in Book v2, or the last tab it opened for
    // legacy plans. Without this the extension falls back to the user's ACTIVE
    // tab — the console path has no session claim, so a type/click/eval step
    // would silently hit whatever the user is looking at.
    const pageName = opts?.page;
    const p = context.route(method, params, pageName);
    const r = await call(method, p, priorResults, opts);
    context.observe(method, p, r, pageName);
    return r;
  };
  /**
   * Does this plan still exist — i.e. did the run end on its own rather than
   * being cancelled out from under it? `abort()` deletes the plan outright, so
   * a `status()` that throws IS the cancel signal.
   *
   * BOTH terminal paths have to ask, for two separate reasons. The stated one
   * is policy: a user-initiated cancel must not tear down a workspace they may
   * still be looking at (see `plan_abort`, which tells the caller nothing was
   * rolled back). The unstated one is mechanical: `finish` below reads
   * `runner.getResults(planId)`, which THROWS on a plan that is gone — so an
   * ungated terminal path does not merely over-clean, it replaces the run's
   * real outcome with an `unknown planId` error on the way out.
   *
   * Only the throw path used to ask. The escalate path did not, which made the
   * policy true for a step that crashed and false for one whose verify budget
   * ran out — the same cancel, two different behaviours, decided by something
   * the user never chose.
   */
  const planAlive = (): boolean => {
    try {
      runner.status(planId);
      return true;
    } catch {
      return false;
    }
  };
  let result: AutoPlaybackResult;
  try {
    result = await playLoop(runner, planId, trackedCall, opts);
  } catch (e) {
    // A step action threw (terminal failure). Before propagating, best-effort
    // close any work window/tab the remaining steps would have cleaned up —
    // unless the plan is gone (cancelled via abort): a user-initiated cancel
    // shouldn't tear down a workspace they may be looking at.
    if (planAlive()) {
      // Read what the PLAN owns before the cleanup below, not after. Those two
      // calls are real browser round-trips, and a cancel landing during them
      // would make these throw `unknown planId` — out of a catch block, which
      // means replacing the very error being handled and skipping the
      // `throw e` that propagates it. A liveness check spent two round-trips
      // later is a check that has expired.
      const ranSteps = runner.status(planId).index;
      const results = runner.getResults(planId);
      await cleanupStaleTabs(runner, planId, trackedCall, steps);
      await closeTrackedTabs(trackedCall, context);
      await finish({
        planId,
        status: "failed",
        ranSteps,
        totalSteps: steps.length,
        error: e instanceof Error ? e.message : String(e),
        results,
      });
    } else {
      // Cancelled via abort — the plan is gone, no results to report.
      await finish({ planId, status: "cancelled", ranSteps: 0, totalSteps: steps.length, results: [] });
    }
    throw e;
  }
  // Terminal-failure outcomes also skip the trailing cleanup steps — close the
  // work window before returning. `noAction` is NOT one: it's a pause the
  // client resumes via resumePlanId (same as needsConfirm/needsJudge), so its
  // trailing close steps must stay un-executed for the resumed run.
  if (result.kind === "escalate") {
    if (planAlive()) {
      // Same reason as the throw path above: taken BEFORE the cleanup awaits,
      // because this block sits outside every try — an `unknown planId` thrown
      // here escapes `runAutoPlayback` entirely, so the caller never learns why
      // the run ended and `finish` never fires.
      const results = runner.getResults(planId);
      await cleanupStaleTabs(runner, planId, trackedCall, steps);
      await closeTrackedTabs(trackedCall, context);
      await finish({
        planId,
        status: "escalated",
        ranSteps: result.index,
        totalSteps: steps.length,
        error: result.failed.join("; "),
        results,
      });
    } else {
      // Cancelled after the loop had already decided to escalate. `ranSteps`
      // is reported from `result` rather than the 0 the throw path uses,
      // because here it is actually known — the plan being gone costs us the
      // results, not the cursor.
      await finish({ planId, status: "cancelled", ranSteps: result.index, totalSteps: steps.length, results: [] });
    }
  } else if (result.kind === "complete") {
    await finish({
      planId,
      status: "success",
      ranSteps: result.ranSteps,
      totalSteps: steps.length,
      results: result.results,
    });
  }
  return result;
}

/** Run the step loop until completion or a step that needs a verdict. */
async function playLoop(runner: PlanRunner, planId: string, call: CallFn, opts?: RunPlaybackOptions): Promise<AutoPlaybackResult> {
  let ranSteps = 0;
  for (;;) {
    const status = runner.status(planId);
    if (status.done) return { kind: "complete", ranSteps, results: runner.getResults(planId) };
    const step = status.current!;

    if (step.risk === "confirm") return { kind: "needsConfirm", index: status.index, step };
    // Book v2 check-only step: a signal wait with no action — wait the gate,
    // then advance. Only a step with NEITHER action nor gate keeps noAction.
    if (!step.action) {
      if (step.gate) {
        const g = await runner.waitGate(planId);
        if (!g.ok) return { kind: "escalate", index: status.index, step, failed: g.failed };
        const rg: AdvanceResult = await runner.advance(planId);
        if (rg.kind === "advanced" || rg.kind === "complete") {
          ranSteps++;
          if (rg.kind === "advanced") opts?.onStep?.({ index: rg.index, goal: rg.next.goal });
          continue;
        }
        if (rg.kind === "retry") {
          // Check-only step: there is no action to redo — re-verifying would
          // read the same state. Escalate with the verify diagnostics.
          return { kind: "escalate", index: status.index, step, failed: rg.failed };
        }
        if (rg.kind === "judge") return { kind: "needsJudge", index: rg.index, step: rg.step, assert: rg.assert };
        if (rg.kind === "judgeVisual") return { kind: "needsJudge", index: rg.index, step: rg.step, assert: rg.claim, dataUrl: rg.dataUrl };
        return { kind: "escalate", index: rg.index, step: rg.step, failed: rg.failed };
      }
      return { kind: "noAction", index: status.index, step };
    }

    // Enter the step: await its readiness gate before the action runs. A gate
    // timeout is a distinct outcome (never an action retry) — escalate with the
    // gate diagnostics, the action is not executed.
    if (step.gate) {
      const g = await runner.waitGate(planId);
      if (!g.ok) return { kind: "escalate", index: status.index, step, failed: g.failed };
    }
    // call() is responsible for noteAction()-ing whatever it resolved to
    // (mirroring what a live click/type/local_eval/write_file tool call
    // does) — that's what lands this step's value in getResults() below.
    //
    // A locator miss comes back as `escalate` carrying its diagnosis (which
    // names the failing dimension and lists the candidates the page did offer),
    // instead of propagating as a bare throw that `onFail`/`maxRetries` never
    // sees. It is NOT retried with a relaxed locator: relaxing a locator makes
    // it match MORE things, so a "recovery" can silently drive the step into a
    // different element than the author named — a wrong click reported as
    // success. Failing loudly with the candidates is strictly better than
    // guessing; adding a dimension (AND) is safe, swapping one out is not.
    try {
      await call(step.action.method, step.action.params, runner.getResults(planId), { page: step.page });
    } catch (e) {
      const diagnosis = rpcErrorInfoOf(e);
      if (!diagnosis || !RECOVERABLE_ACTION_ERRORS.has(diagnosis.code)) {
        // 语义不变（非可恢复错误一律上抛，不进 onFail/重试），只把【是哪一步】补进去。
        //
        // 原来抛的是裸 error。同一条链路上，verify 失败会报
        // 「⚠ Playbook FAILED at step 3 (上传主图…)」——步号、goal 都在；而动作本身
        // 抛出的错只剩一句 `eval timed out after 90000ms`，35 步的书里既不知道是哪一步，
        // 也不知道那一步在干什么。2026-09-07 实测代价：为定位一次 eval 超时落在哪一步，
        // 连跑三轮、靠页面残留状态反推。
        //
        // 改消息而不是包一层 Error：上游（browser-mcp / rpcErrorInfoOf）会读这个错误
        // 对象上挂的字段，包一层会把它们藏进 cause，等于用一个新盲区换一个旧盲区。
        if (e instanceof Error) {
          e.message = `step ${status.index + 1}/${status.total} (${step.goal.slice(0, 60)}): ${e.message}`;
        }
        throw e;
      }
      return {
        kind: "escalate",
        index: status.index,
        step,
        failed: [e instanceof Error ? e.message : String(e)],
        diagnosis,
      };
    }
    const r: AdvanceResult = await runner.advance(planId);

    if (r.kind === "advanced") {
      ranSteps++;
      // Live progress: the run moved PAST this step; tell the channel which
      // step is current now (the next one) so observers can update in real
      // time rather than only at the terminal exit.
      opts?.onStep?.({ index: r.index, goal: r.next.goal });
      continue;
    }
    if (r.kind === "complete") {
      ranSteps++;
      continue;
    }
    if (r.kind === "retry") continue; // redo the same action next loop iteration
    if (r.kind === "judge") return { kind: "needsJudge", index: r.index, step: r.step, assert: r.assert };
    if (r.kind === "judgeVisual") return { kind: "needsJudge", index: r.index, step: r.step, assert: r.claim, dataUrl: r.dataUrl };
    // r.kind === "escalate"
    return {
      kind: "escalate",
      index: r.index,
      step: r.step,
      failed: r.failed,
      results: runner.getResults(planId),
      ownValue: r.ownValue,
    };
  }
}

/**
 * On a terminal failure, we stop before the trailing steps — so the steps that
 * close the run's work window/tab never run as normal steps. Fire any
 * un-executed `browser.closeTab`/`browser.closeWindow` best-effort (each wrapped;
 * a stuck/irrelevant close must never crash or block the finalize). `needsConfirm`
 * / `needsJudge` / `noAction` are pauses (resumable via resumePlanId), NOT
 * failures, so they deliberately skip this.
 */
/** 失败后是否保留现场（窗口/tab 不关）。
 *
 * 一次 run 收尾时有三条会关掉 tab 的路径，职责各不相同：
 *   cleanupStaleTabs   补执行 book 自己写的尾部 closeTab（失败时没轮到执行）
 *   closeTrackedTabs   兜底扫掉本次 run 开过的所有 tab（book 没写关窗时的安全网）
 *   closeLeakedClaim   释放 MCP 会话的 claim（browser-mcp.ts，另一个层级的账）
 *
 * 它们不该合并 —— 职责真的不同。但「要不要保留现场」这个决定必须只有一处：
 * 三处各判一次 env 的结构，等于「加第四条路径时必然漏一条」。实测就漏过 ——
 * cleanupStaleTabs 不认这个开关，于是开着它也看不到现场，而另外两条还在如实
 * 打印「保留 N 个 tab 供检查」。closeTrackedTabs 的注释早写着这种半边生效
 * 「比没有更糟…调试辅助就变成了谎言」，结果自己也没躲过。 */
export function keepFailedTabs(): boolean {
  return envFlag(process.env.BCP_KEEP_FAILED_TABS);
}

async function cleanupStaleTabs(
  runner: PlanRunner,
  planId: string,
  call: CallFn,
  steps: PlanStep[],
): Promise<void> {
  // 第三条会关掉失败现场的路径，同样要认 BCP_KEEP_FAILED_TABS。
  // closeTrackedTabs 的注释早就写着「只在一边认，比没有更糟 —— 后端打印『保留 N 个
  // tab 供检查』然后 tab 照样消失，调试辅助就变成了谎言」。实测比那还糟：这条路
  // 连日志都不打，窗口直接没了，而两条兄弟路径都在如实报告保留。
  // 补这一条之前，开着开关也看不到现场 —— 为了看一眼品牌控件长什么样白跑了三轮发布。
  if (keepFailedTabs()) {
    console.warn("[playback] BCP_KEEP_FAILED_TABS=1 — skipping trailing close_tab/close_window replay");
    return;
  }
  let cursor: number;
  try {
    cursor = runner.status(planId).index;
  } catch {
    // Plan already gone (e.g. cancelled via abort) — no cursor to scan from,
    // and a user-initiated cancel shouldn't touch the workspace anyway. Skip
    // cleanup and let the original failure propagate untouched.
    console.warn(`[playback] plan ${planId} is gone — skipping stale-tab cleanup entirely`);
    return;
  }
  for (let i = cursor; i < steps.length; i++) {
    const act = steps[i].action;
    if (act && (act.method === RpcMethod.CloseTab || act.method === RpcMethod.CloseWindow)) {
      try {
        // `page` travels with the step here for the same reason it does on the
        // normal path (`playLoop`): a v2 step addresses its tab through the
        // logical page it is bound to. Dropping it sent every replayed close
        // down RunBrowserContext's legacy `activeTabId` branch instead —
        // indistinguishable while every book has a single page, and the wrong
        // tab the moment one has two.
        await call(act.method, act.params, [], { cleanup: true, page: steps[i].page });
      } catch (e) {
        // Still best-effort: a missing or already-closed tab must not block the
        // failure this is cleaning up after. But it is no longer SILENT — an
        // empty catch here made "the cleanup ran and could not close it" look
        // exactly like "the cleanup closed it", which is how a leaked tab
        // survives a fallback that reports nothing. The step index and method
        // are what identify it; the tab is inside `e`, since routing is the
        // most likely thing to have failed and it fails BEFORE a tab is picked.
        console.error(`[playback] cleanup step ${i} (${act.method}) failed:`, e);
      }
    }
  }
}

/**
 * Close every tab THIS run opened that a book close step didn't already close —
 * the run-resource fallback for a book with no trailing close step. Best-effort
 * per tab (an already-closed/gone tab must never block the failure it's
 * cleaning up after). Iterates a snapshot: a successful tracked CloseTab prunes
 * `tabs`, and pruning the array we're iterating would skip elements.
 */
async function closeTrackedTabs(call: CallFn, context: RunBrowserContext): Promise<void> {
  // Opt-out for debugging a book: on a terminal failure the run's window is the
  // ONLY record of where it actually stopped — the tool result names the failing
  // step, but not the page state that made it fail. Closing it forces a full
  // re-run just to look, and a re-run of a publishing book is not free. Off by
  // default: leaked windows pile up fast when nobody is watching.
  if (keepFailedTabs()) {
    const kept = context.ownedTabIds();
    if (kept.length) console.warn(`[playback] BCP_KEEP_FAILED_TABS=1 — leaving ${kept.length} tab(s) open for inspection: ${kept.join(", ")}`);
    return;
  }
  for (const tabId of [...context.ownedTabIds()]) {
    try {
      await call(RpcMethod.CloseTab, { tabId }, [], { cleanup: true });
    } catch (e) {
      // Best-effort, but reported — see the sibling catch in `cleanupStaleTabs`.
      // This is the LAST line of defence for a run's tabs: if it swallows the
      // reason, a tab that outlived its run leaves no trace at all.
      console.error(`[playback] tracked tab ${tabId} did not close:`, e);
    }
  }
}
