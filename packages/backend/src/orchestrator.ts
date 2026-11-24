import { randomUUID } from "node:crypto";
import type { BookPageDefinition, NetworkRequest, PageState, PlanStep, PlaybookStepAction, SignalCondition, SignalGate, SnapshotElement, StepVerify } from "@bcp/shared";
import { matchGrade, resolveSignalRef, validateGate } from "@bcp/shared";
import { extractSlots } from "./playbook.js";

/**
 * The structured reads the runner uses to PROVE a step. Injected by the MCP
 * session so evidence is gathered against THAT session's current target tab —
 * same routing / claim / manual-mode enforcement as every other tool. Each is
 * called lazily (only when a predicate needs it), so a cheap check stays cheap.
 *
 * Book v2: every read takes an optional `page` — the logical page the current
 * step routes to. Evidence is gathered against that page's bound tab, never
 * the user's active tab. Omitted (legacy non-v2 plans) = the run's active tab.
 */
export interface EvidenceReader {
  pageState(planId: string, page?: string): Promise<PageState>;
  readContent(planId: string, page?: string): Promise<{ text: string }>;
  readNetwork(planId: string, page?: string): Promise<{ requests: NetworkRequest[] }>;
  snapshot(planId: string, page?: string): Promise<{ elements: SnapshotElement[] }>;
  /** Run a page JS expression for `evalCheck` (readOnly: true — run under the
   * page-side read-only guard) or `evalUntil` (readOnly: false — may act).
   * Throws if eval is disabled by policy (BCP_EVAL) — the runner then
   * fail-closes the check. */
  evalJs(planId: string, code: string, readOnly: boolean, page?: string): Promise<{ value: unknown }>;
  /** Toggle MAIN-world response-BODY capture for the target tab (for a
   * `networkOk.bodyIncludes` step: on at step entry, off once verified). */
  setNetworkCapture(planId: string, enabled: boolean, page?: string): Promise<void>;
  /** Captured response bodies newer than `sinceSeq` (from the EventStore's
   * network_body events), plus the current max seq for the next baseline. */
  networkBodies(planId: string, sinceSeq: number, page?: string): { bodies: Array<{ url: string; status: number; body: string }>; maxSeq: number };
  /** Capture the target tab's viewport (for `visualAssert`) — the runner hands
   * the image to the agent to judge; the backend never judges the pixels. */
  screenshot(planId: string, page?: string): Promise<{ dataUrl: string }>;
  /** Whether the run still has a live page target. A successful terminal
   * close_tab intentionally leaves no page to inspect. */
  targetAvailable(planId: string, page?: string): boolean;
  /** Book v2: wait for one page's signal condition in its bound tab, resolving
   * satisfied/timedOut/blocked with diagnostics. Used by step gates. */
  waitSignal(planId: string, page: string, condition: SignalCondition, timeoutMs: number): Promise<{
    satisfied: boolean;
    timedOut?: boolean;
    failedPaths?: string[];
    blocked?: string;
    url?: string;
    pageState?: { readyState: string; loading: boolean; errorCount: number };
    evidence?: unknown;
  }>;
}

/** Normalize rendered page text before a substring comparison.
 *
 * Rendered text is NOT a faithful copy of what was typed: rich editors
 * (editor-kit / ProseMirror-style contenteditable) store line breaks as
 * zero-width characters rather than "\n", and browsers collapse runs of
 * whitespace. Comparing raw strings therefore fails on content that IS
 * on the page — `doudian-image-text-publish` step 12 pasted its body
 * successfully and then failed its own `textPresent` check, every single
 * run, for any body containing a newline. Two other steps in that same
 * book already stripped \u200b by hand; this makes the predicate agree
 * with them instead of leaving each step to rediscover it.
 *
 * Zero-width chars become spaces (they stand in for the breaks the author
 * wrote), then all whitespace collapses, so "a\n\nb" and "a\u200b\u200bb"
 * both normalize to "a b". */
export function normalizeRenderedText(s: string): string {
  return s.replace(/[\u200b-\u200d\ufeff]/g, " ").replace(/\s+/g, " ").trim();
}

/** True if a verify declares at least one CHECKABLE predicate. Empty objects and
 * empty-string predicates (`""` → `includes("")` is always true) are vacuous and
 * would auto-pass — a silent "✓ verified" that proves nothing. Rejected at create. */
export function hasCheckablePredicate(v: StepVerify): boolean {
  const s = (x?: string) => !!x && x.trim().length > 0;
  return (
    v.actionSucceeded === true ||
    s(v.urlIncludes) ||
    s(v.textPresent) ||
    s(v.textAbsent) ||
    s(v.elementName) ||
    s(v.elementChecked) ||
    s(v.elementEnabled) ||
    (v.elementValue != null && s(v.elementValue.name)) ||
    (v.networkOk != null && s(v.networkOk.urlIncludes)) ||
    (v.evalCheck != null && s(v.evalCheck.code)) ||
    (v.evalUntil != null && s(v.evalUntil.code)) ||
    s(v.assert) ||
    s(v.visualAssert) ||
    v.noErrors === true ||
    v.settled === true ||
    v.dialogOpen === true ||
    v.formSubmittable === true
  );
}

/** One step's resolved value once its cursor advances — from a browser RPC
 * read/mutation, or a `local.*` backend action. Logged for EVERY active plan
 * regardless of whether it's being recorded (see noteAction), so a `local.*`
 * step — live-driven or replayed — can read what earlier steps produced. */
export interface PlaybackStepResult {
  index: number;
  goal: string;
  method: string;
  value: unknown;
}

interface PlanRecord {
  planId: string;
  goal: string;
  steps: PlanStep[];
  /** Book v2: the book's logical page definitions (signals), used to resolve
   * step gates. Absent for plain non-v2 plans. */
  pages?: Record<string, BookPageDefinition>;
  /** Index of the current, not-yet-verified step. */
  cursor: number;
  /** Failed advance() calls on the CURRENT step (reset on step entry). */
  attempts: number;
  done: boolean;
  /** Set the first time this plan's terminal onFinish hook is claimed (see
   * finishClaimed). Engine-level exactly-once guard: a plan that already
   * reached a terminal outcome can still be resumed (status() doesn't throw on
   * a done plan), and resume re-runs runAutoPlayback which would otherwise
   * re-fire onFinish and double-deliver (webhook twice, wechat twice). */
  finishFired: boolean;
  /** Browser-clock high-water mark (max NetworkRequest.ts seen when the current
   * step BEGAN). `networkOk` only accepts requests newer than this, so a stale
   * prior 2xx to the same URL can't false-pass. Browser-clock vs browser-clock
   * (both from read_network) — no backend/browser clock-skew, which matters
   * because the browser may run on a different machine than this backend.
   * null = the baseline read FAILED to capture (transient disconnect / manual
   * mode without a claim); verify then fail-closes networkOk instead of using a
   * 0 baseline, which would accept every (incl. stale) request. */
  netBaseline: number | null;
  /** EventStore seq captured at step entry — `networkOk.bodyIncludes` only reads
   * response bodies newer than this, so a stale prior body can't false-pass. */
  bodySeqBaseline: number;
  /** Per-plan serialization: advance() chains on this so two concurrent calls
   * can't both verify the same step and double-increment the cursor (skipping a
   * step's verification — the one thing the gate exists to prevent). */
  chain: Promise<unknown>;
  /** Set when this plan was created with recording on, and kept afterwards:
   * stopRecording() only READS it, so saving the same run twice just rewrites
   * the same playbook file rather than failing the second time.
   * actions[i] holds step i's captured action once recorded — undefined until
   * then, and left undefined (check-only) if that step recorded 0 or >1
   * mutating calls (ambiguous — see noteAction). */
  recording?: { paramNames: string[]; paramValues: Record<string, string>; actions: (PlaybookStepAction | undefined)[] };
  /** Mutating RPC calls observed (via noteAction) since the current step began.
   * Reset on enterStep() and consumed into recording.actions on advance. */
  pendingActions: PlaybookStepAction[];
  /** Resolved values paired 1:1 with pendingActions (same push/reset points) —
   * consumed into `results` on advance, same ambiguity rule as recording.actions. */
  pendingValues: unknown[];
  /** This run's {index, goal, method, value} log, one entry per step that
   * advanced with exactly one observed action (see noteAction) — ALWAYS kept,
   * not gated on `recording`, so a `local.*` step can read prior steps' data
   * whether this plan is being recorded or just driven live. */
  results: PlaybackStepResult[];
  /** Unconditional action trace for post-mortems — see noteAction. */
  trace: Array<{ step: number; method: string; value: unknown; phase?: "verify" }>;
  /** True while this plan's `verify()` is running. An `evalCheck` verify issues
   * a real `browser.eval` RPC, which noteAction would otherwise count as a
   * SECOND action for the step — and `results` only keeps steps with exactly
   * one. That silently dropped every evalCheck-verified step from `results`,
   * including a book's FINAL output step, so run_playbook reported some
   * mid-run step as the last result and the book's declared outputSchema
   * value never reached the caller. Verification is observation, not action.
   *
   * LIMIT: this is per-plan, but noteAction broadcasts to EVERY live plan (it
   * is not told which plan issued the RPC). So with two concurrent plans, A's
   * verify eval still lands in B's pendingActions. That mis-attribution is
   * pre-existing — it applies to ordinary actions too, not just verifies — and
   * fixing it means threading planId through noteAction's callers. Playback
   * runs one plan at a time today, so this flag is correct in practice. */
  verifying: boolean;
}

/** Result of evaluating a step's MECHANICAL verify predicates. */
interface VerifyOutcome {
  pass: boolean;
  /** Human-readable checks that failed (empty when pass). */
  failed: string[];
  /** Facts about how checks that passed were satisfied, when that was weaker than they read (a name matched only as
   *  part of a longer one). Shown with the step's result. */
  notes?: string[];
}

/** What a RECORDING plan captured for the step that just advanced. Surfaced by
 * advance() so the agent learns AT THAT BEAT whether the step is replayable —
 * the same rules stopRecording() applies at save time, reported one step at a
 * time instead of as a pile of warnings after the run is over and can no longer
 * be redone. Absent on a plain (non-recording) plan. */
export interface RecordingNote {
  /** The single unambiguous action captured, or null (0 or >1 observed → this
   * step saves check-only). */
  method: string | null;
  /** How many recordable calls were observed during this step. */
  observed: number;
  /** What makes this step un-replayable, phrased for the agent. Empty = clean. */
  issues: string[];
}

/** Recording feedback for one advanced step — see RecordingNote. */
function recordingNote(acts: PlaybookStepAction[]): RecordingNote {
  const issues: string[] = [];
  const one = acts.length === 1 ? acts[0] : null;
  // 0 actions is NOT flagged: a check-only step (verify something without
  // touching the page) is a legitimate plan step, and PlanStep.action is
  // optional by design. The consequence is stated in the headline instead, so a
  // deliberate check step doesn't read as a defect. >1 IS a defect — the step
  // becomes un-replayable and the agent can still redo it at this beat.
  if (acts.length > 1)
    issues.push(
      `${acts.length} actions observed (${acts.map((a) => a.method).join(", ")}) — ambiguous, saves as check-only; keep ONE mutating action per step while recording`,
    );
  if (one && typeof one.params.ref === "string")
    issues.push(
      `targets ref "${one.params.ref}" — refs are snapshot-scoped and WILL fail on auto replay ("unknown ref"); redo this step targeting the element by text/css/role/name`,
    );
  return { method: one?.method ?? null, observed: acts.length, issues };
}

export type AdvanceResult =
  | { kind: "advanced"; index: number; total: number; next: PlanStep; recording?: RecordingNote; notes?: string[] }
  | { kind: "complete"; total: number; recording?: RecordingNote; notes?: string[] }
  | { kind: "retry"; strategy: "retry" | "rescan"; remaining: number; step: PlanStep; failed: string[] }
  // results 一并带出：失败的那一步常常只是下游受害者，真因在上游某个 ok:false 的
  // 步骤自己报的 reason 里（见 browser-mcp 的「上游线索」）。
  | {
      kind: "escalate";
      index: number;
      total: number;
      step: PlanStep;
      failed: string[];
      results: PlaybackStepResult[];
      /** 失败那一步【自己】的动作返回值。`results` 只在 verify 通过后才 push，所以失败步骤
       *  的返回值从来不在里面 —— 而 action 往往已经算出了精确的 reason（'product-not-found'
       *  还是 'search-never-applied'），外部却只看得到一行原始 evalCheck 代码或 "after timed
       *  out"。2026-09-16 实测代价：把「组件没就绪」读成了「这个商品不符合提报要求」。
       *  这里带的是【最后一次尝试】的值（重试时 pendingValues 会被清掉再由 redo 重填）。 */
      ownValue?: unknown;
    }
  /** Mechanical checks passed but the step carries an agent-judged `assert`:
   * the runner refuses to advance until the AGENT confirms it (advance confirm). */
  | { kind: "judge"; index: number; total: number; step: PlanStep; assert: string }
  /** Like judge, but VISUAL: the runner took a screenshot (`dataUrl`) for the
   * agent to look at and confirm — the backend does not judge it. */
  | { kind: "judgeVisual"; index: number; total: number; step: PlanStep; claim: string; dataUrl: string };

/** Cap on live plans per session, so a long session that creates many plans
 * can't grow the Map without bound (oldest evicted first). */
/** 验证失败消息里只放一段【能认出是哪个判据】的代码，不放全文。
 *
 * verify.evalCheck 的 code 里内联了整个 {{product}} —— 一件 10 SKU 的商品就有 5000+
 * 字符。原来把它整段塞进失败消息，结果是：用户看到一屏代码和商品 JSON，真正的失败
 * 原因反而没地方看。实测面膜那次，报错通篇是代码，而真因「抖店智能识别连续失败
 * (系统处理异常)」在两步之前的 step 19 返回值里，用户根本翻不到。
 *
 * 保留首尾各一段：开头能认出判据在查什么，结尾能看到返回的是什么。 */
function briefCode(code: string): string {
  const flat = code.replace(/\s+/g, " ").trim();
  if (flat.length <= 220) return flat;
  return `${flat.slice(0, 140)} … [略 ${flat.length - 220} 字] … ${flat.slice(-80)}`;
}

const PLAN_CAP = 50;

/**
 * Per-MCP-session plan runner. Registers verifiable step plans and gates
 * advancement on the runner's OWN structured verification (not the agent's
 * self-report). Thin: it NEVER performs page actions — the agent does — it only
 * proves each step and refuses to move on until proven.
 *
 * SCOPE / HONESTY (P0 + P1a):
 * - OPT-IN, not enforced: nothing routes click/type/etc. through a plan, so the
 *   gate only helps a client that voluntarily plans multi-step tasks and gives
 *   each step a real verify. It is not a guarantee against a client that skips it.
 * - EPHEMERAL: state is per-session, in this backend process's memory. It
 *   survives an extension service-worker recycle (state was never in the SW) but
 *   is LOST on a backend restart or when the MCP session closes — not durable.
 * - VERIFICATION STRENGTH: the structured predicates (url/text/element name+
 *   checked+enabled+value/network-2xx/errors/dialog/form) are runner-verified 🟢.
 *   `assert` is an agent-JUDGED half-gate (🟡): after the mechanical checks pass,
 *   the runner forces the agent to explicitly confirm a natural-language claim
 *   (incl. a visual one, via screenshot) — it prevents a silent skip but the
 *   judgment is self-reported, weaker than the structured predicates. Response-
 *   body results (P1-b) and a truly independent visual gate (P1-d) are later.
 */
export class PlanRunner {
  private readonly plans = new Map<string, PlanRecord>();
  /** >0 while a composite action (pick_option) is running its inner RPCs. */
  private compositeDepth = 0;

  /** True while a composite's inner RPCs run — their noteAction calls are not step actions. */
  get inComposite(): boolean {
    return this.compositeDepth > 0;
  }

  constructor(private readonly evidence: EvidenceReader) {}

  async create(
    goal: string,
    steps: PlanStep[],
    record?: { paramNames: string[]; paramValues: Record<string, string> },
    requestedPlanId?: string,
    pages?: Record<string, BookPageDefinition>,
  ): Promise<{ planId: string; total: number; first: PlanStep }> {
    if (!steps.length) throw new Error("a plan needs at least one step");
    steps.forEach((s, i) => {
      if (!hasCheckablePredicate(s.verify))
        throw new Error(
          `step ${i + 1} ("${s.goal}") has no checkable verify — every step must declare at least one non-empty predicate (empty object or "" strings prove nothing and would silently auto-pass)`,
        );
      // Book v2: a step with a gate (or a page) requires the book's pages, and
      // every gate reference must resolve against them. A gate on a page-less
      // plan, or a v2 page that doesn't exist in the book, is a hard schema error.
      if (s.gate || s.page) {
        if (!pages) {
          throw new Error(
            `step ${i + 1} ("${s.goal}") declares ${s.gate ? "a gate" : "a page"} but no book pages were provided — run_playbook validates v2 books before creating the plan`,
          );
        }
        if (s.page !== undefined && !pages[s.page]) {
          throw new Error(`step ${i + 1} ("${s.goal}") targets unknown page "${s.page}"`);
        }
        if (s.gate) validateGate(s.gate, pages, s.page);
      }
    });
    if (this.plans.size >= PLAN_CAP) {
      const oldest = this.plans.keys().next().value;
      if (oldest !== undefined) this.plans.delete(oldest);
    }
    const planId = requestedPlanId ?? `plan_${randomUUID().slice(0, 8)}`;
    if (this.plans.has(planId)) throw new Error(`plan "${planId}" already exists`);
    const rec: PlanRecord = {
      planId,
      goal,
      steps,
      pages,
      cursor: 0,
      attempts: 0,
      done: false,
      finishFired: false,
      netBaseline: null,
      bodySeqBaseline: 0,
      chain: Promise.resolve(),
      pendingActions: [],
      pendingValues: [],
      results: [],
      trace: [],
      verifying: false,
      recording: record ? { ...record, actions: steps.map(() => undefined) } : undefined,
    };
    this.plans.set(planId, rec);
    await this.enterStep(rec);
    return { planId, total: steps.length, first: steps[0] };
  }

  /** browser-mcp.ts's call() invokes this right after a successful MUTATING RPC
   * call resolves (passing what it resolved to); local_eval/write_file do the
   * same after running. Broadcasts to every ACTIVE (not done) plan — no planId
   * needed from the call site, same "just iterate" pattern as hasActivePlan().
   * In practice at most one plan is live in a session at a time, but this
   * doesn't assume it. Always tracked (not just while p.recording) — `results`
   * is this run's data log for local.* steps to read, independent of whether
   * the plan is ALSO being recorded into a reusable playbook. */
  noteAction(action: PlaybookStepAction, value: unknown): void {
    for (const p of this.plans.values()) {
      if (p.done) continue;
      if (!p.verifying && this.compositeDepth === 0) {
        p.pendingActions.push(action);
        p.pendingValues.push(value);
      }
      // Unconditional debug trace, separate from `results` on purpose.
      // `results` is the RECORDING data log: it keeps a step only when the step
      // advanced with exactly one observed action, so it still drops every step
      // whose verify FAILED — precisely the ones worth reading. (It used to also
      // drop every evalCheck-verified step, because that verify is itself a
      // browser.eval; `verifying` above fixes that.) Diagnosing a failed run
      // needs the opposite rule: keep everything, and mark which entries came
      // from a verify. Bounded so a long run cannot grow without limit.
      p.trace.push({ step: p.cursor + 1, method: action.method, value, ...(p.verifying ? { phase: "verify" as const } : {}) });
      if (p.trace.length > 500) p.trace.shift();
    }
  }

  /** Run a composite action (several RPCs that together are ONE step action,
   *  e.g. pick_option's open-then-choose) so the step records exactly that one
   *  action. Inner calls still reach the debug trace but not the step's
   *  pending actions — otherwise the step would count 2+ actions and save as
   *  check-only, unreplayable. */
  async asOneAction<T>(action: PlaybookStepAction, run: () => Promise<T>): Promise<T> {
    this.compositeDepth++;
    let value: T;
    try {
      value = await run();
    } finally {
      this.compositeDepth--;
    }
    this.noteAction(action, value);
    return value;
  }

  /** Every action this run observed, with its value — see `trace` in
   * noteAction. Unlike getResults this keeps failed and multi-action steps,
   * which is what a post-mortem actually needs. Returns a copy. */
  getTrace(planId: string): Array<{ step: number; method: string; value: unknown; phase?: "verify" }> {
    return [...this.record(planId).trace];
  }

  /** This run's collected step values so far — see PlaybackStepResult. A
   * `local.*` step (live or replayed) reads this to turn earlier steps' data
   * into an artifact. Returns a copy. */
  getResults(planId: string): PlaybackStepResult[] {
    return [...this.record(planId).results];
  }

  /** Finalize a recording plan into playbook step data (NOT written to disk —
   * that's playbook.ts's job, see savePlaybook). Refuses an incomplete plan: a
   * half-finished run isn't a usable playbook. A step that recorded 0 or >1
   * actions is kept as check-only (no `action`), surfaced as a warning for the
   * caller to review/hand-fix rather than guessed at. */
  stopRecording(planId: string): { steps: PlanStep[]; paramNames: string[]; warnings: string[] } {
    const p = this.record(planId);
    if (!p.recording) throw new Error(`plan "${planId}" was not created with recording on`);
    if (!p.done)
      throw new Error(
        `plan "${planId}" is not complete (step ${p.cursor + 1}/${p.steps.length}) — a partial run isn't a usable playbook. Finish the remaining steps, or plan_abort({planId:"${planId}"}) to throw the recording away.`,
      );
    const { paramValues, paramNames, actions } = p.recording;
    const warnings: string[] = [];
    const steps = p.steps.map((step, i) => {
      // verify carries this run's literals too (the typed title, the URL it
      // landed on) — slot them like the action, or replay checks run-1's data.
      const s = { ...step, verify: extractSlots(step.verify as unknown as Record<string, unknown>, paramValues) as unknown as PlanStep["verify"] };
      const raw = actions[i];
      if (raw === undefined) {
        warnings.push(`step ${i + 1} ("${s.goal}") recorded 0 or >1 actions — saved as check-only, add action manually if needed`);
        return s;
      }
      if (typeof raw.params.ref === "string") {
        warnings.push(
          `step ${i + 1} ("${s.goal}") action targets ref "${raw.params.ref}" — refs are snapshot-scoped and WILL fail on auto-replay ("unknown ref") since auto mode never snapshots first; re-record this step targeting the element by text/css/role/name instead`,
        );
      }
      return { ...s, action: { method: raw.method, params: extractSlots(raw.params, paramValues) } };
    });
    return { steps, paramNames, warnings };
  }

  /** True while any registered plan is not yet complete. BCP_FORCE_PLAN gates
   * mutating browser actions on this — no active plan → mutations refused. */
  hasActivePlan(): boolean {
    for (const p of this.plans.values()) if (!p.done) return true;
    return false;
  }

  private record(planId: string): PlanRecord {
    const p = this.plans.get(planId);
    if (!p)
      throw new Error(
        `unknown planId "${planId}" — call plan() first (plans are per MCP session, in-memory, and lost on a backend restart or session close)`,
      );
    return p;
  }

  /** Exactly-once claim of a plan's terminal onFinish: true the first time,
   * false on every later call (a synchronous check-and-set — no await inside,
   * so it's atomic within one tick). Guards against a plan that already reached
   * a terminal outcome being resumed: resume re-runs runAutoPlayback, whose
   * finish() would otherwise re-fire onFinish and double-deliver. A plan that's
   * gone (aborted) returns true — there's nothing to mark, but resume would
   * throw on an unknown planId, so a single fire can't be duplicated. */
  finishClaimed(planId: string): boolean {
    const p = this.plans.get(planId);
    if (!p) return true;
    if (p.finishFired) return false;
    p.finishFired = true;
    return true;
  }

  status(planId: string): {
    goal: string;
    index: number;
    total: number;
    done: boolean;
    current?: PlanStep;
    /** Present only while this plan is recording — "am I still recording, and
     * is it capturing anything" is otherwise invisible after plan()'s one-time
     * mention, which is exactly what a long run forgets. */
    recording?: { captured: number; checkOnly: number; paramNames: string[] };
  } {
    const p = this.record(planId);
    const rec = p.recording;
    return {
      goal: p.goal,
      index: p.cursor,
      total: p.steps.length,
      done: p.done,
      current: p.done ? undefined : p.steps[p.cursor],
      recording: rec
        ? {
            // Only steps BEFORE the cursor have been judged; the current one is
            // still open, so don't count it either way.
            captured: rec.actions.slice(0, p.cursor).filter((a) => a !== undefined).length,
            checkOnly: rec.actions.slice(0, p.cursor).filter((a) => a === undefined).length,
            paramNames: rec.paramNames,
          }
        : undefined,
    };
  }

  /** The plan's full step list, as created. Read-only snapshot — the auto
   * playback failure path needs it to know which trailing close steps a FAILED
   * run skipped (a resumed run doesn't re-instantiate the playbook, so it can't
   * rebuild the list from params). */
  stepsOf(planId: string): PlanStep[] {
    return [...this.record(planId).steps];
  }

  /** Drop a plan outright — the exit stopRecording() refuses to be (it needs a
   * COMPLETE run, by design: a half-finished run isn't a usable playbook). Also
   * the only way to end an auto-playback run that went wrong: hasActivePlan()
   * counts live plans, so an abandoned one would otherwise hold the
   * BCP_FORCE_PLAN gate open until the PLAN_CAP LRU eventually evicted it.
   * Discards any recording — nothing is written to disk. */
  abort(planId: string): { goal: string; index: number; total: number; wasRecording: boolean } {
    const p = this.record(planId);
    this.plans.delete(planId);
    return { goal: p.goal, index: p.cursor, total: p.steps.length, wasRecording: p.recording != null };
  }

  /** Verify the current step; advance only if it passes. Never runs the action.
   * `confirm` supplies the agent's verdict for a step with an `assert` half-gate.
   * Serialized per plan so concurrent calls can't skip a step's verification. */
  async advance(planId: string, confirm?: boolean): Promise<AdvanceResult> {
    const p = this.record(planId);
    const run = p.chain.then(
      () => this.advanceOnce(p, confirm),
      () => this.advanceOnce(p, confirm),
    );
    p.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Book v2: await the CURRENT step's readiness gate. Local refs resolve
   * against the step's page; cross-page refs wait concurrently in their own
   * bound tabs. A gate timeout is a DISTINCT runner outcome: it returns
   * { ok: false, failed } with diagnostics and NEVER touches the step's
   * onFail/maxRetries budget — readiness is not an action failure, so the
   * action is simply not executed. A blocked signal (script leaf refused by
   * policy/CSP) also fails closed. An unbound page throws (hard stop). */
  async waitGate(planId: string): Promise<{ ok: boolean; failed: string[] }> {
    const p = this.record(planId);
    return this.awaitSignalGate(p, p.steps[p.cursor].gate, "gate");
  }

  /** Await a step's CONSEQUENCE gate — `after`, between the action and verify.
   * Split from waitGate only by WHEN it runs and what a timeout means: see the
   * `after` field docs (a gate timeout is "not ready to start", this one is "the
   * action did not land", an ordinary step failure). */
  private async waitAfter(p: PlanRecord): Promise<{ ok: boolean; failed: string[] }> {
    return this.awaitSignalGate(p, p.steps[p.cursor].after, "after");
  }

  private async awaitSignalGate(
    p: PlanRecord,
    gate: SignalGate | undefined,
    label: "gate" | "after",
  ): Promise<{ ok: boolean; failed: string[] }> {
    const step = p.steps[p.cursor];
    if (!gate) return { ok: true, failed: [] };
    if (!p.pages) throw new Error(`step "${step.goal}" declares a ${label} but this plan has no book pages`);
    const refs = "all" in gate ? gate.all : gate.any;
    const combineAll = "all" in gate;
    const results = await Promise.all(
      refs.map(async (ref) => {
        const { page, signal, definition } = resolveSignalRef(p.pages!, ref, step.page);
        const timeoutMs = definition.timeoutMs ?? 30_000;
        const r = await this.evidence.waitSignal(p.planId, page, definition.condition, timeoutMs);
        return { page, signal, r };
      }),
    );
    const ok = combineAll ? results.every((x) => x.r.satisfied) : results.some((x) => x.r.satisfied);
    if (ok) return { ok: true, failed: [] };
    // Only the signals that actually failed. Mapping ALL of them rendered a
    // SATISFIED signal as "timed out after evaluation" (it has no `timedOut`
    // and no `failedPaths`, so it fell through to the timeout branch) — on run
    // 597a0cad that put a healthy `createReady` at the FRONT of the message and
    // the real cause, a blocked leaf, behind a semicolon. A gate report must
    // name only what went wrong.
    const failed = results.filter((x) => !x.r.satisfied).map((x) => {
      const where = x.r.url ? ` url=${x.r.url}` : "";
      const state = x.r.pageState ? ` pageState=${JSON.stringify(x.r.pageState)}` : "";
      return x.r.blocked
        ? `${label} ${x.page}.${x.signal} blocked: ${x.r.blocked}`
        : `${label} ${x.page}.${x.signal} timed out after ${x.r.timedOut ? "its deadline" : "evaluation"}${x.r.failedPaths?.length ? ` (${x.r.failedPaths.join(", ")})` : ""}${where}${state}`;
    });
    return { ok: false, failed };
  }

  private async advanceOnce(p: PlanRecord, confirm?: boolean): Promise<AdvanceResult> {
    if (p.done) return { kind: "complete", total: p.steps.length };

    const step = p.steps[p.cursor];
    const page = step.page;
    const targetClosedByAction =
      p.pendingActions.length === 1 &&
      p.pendingActions[0].method === "browser.closeTab" &&
      !this.evidence.targetAvailable(p.planId, page);

    // The action has already run (the agent performed it, or playback drove it);
    // `after` is where this step waits for its consequence before verify gets to
    // look. Keyed on the DECLARED action, not on pendingActions: the latter is
    // only populated by noteAction on the live MCP path, so keying on it would
    // silently skip the wait during auto playback — the very mode books run in.
    // Skipped when the action closed the target: no document left to observe.
    if (step.after && !targetClosedByAction && step.action) {
      const consequence = await this.waitAfter(p);
      if (!consequence.ok) return this.failStep(p, step, consequence.failed);
    }

    const outcome = targetClosedByAction
      ? { pass: true, failed: [] }
      : await (async () => {
          p.verifying = true;
          try {
            return await this.verify(p, step.verify, p.netBaseline, p.bodySeqBaseline, p.pendingActions.length > 0);
          } finally {
            p.verifying = false;
          }
        })();
    if (!outcome.pass) return this.failStep(p, step, outcome.failed);

    // Mechanical checks passed. If the step carries an agent-judged assert, the
    // runner won't advance until the agent explicitly confirms it.
    // Agent-judged gates (after mechanical checks pass): visual first (a
    // screenshot handed to the agent), then a plain-text assert. `confirm`
    // resolves whichever this step declares.
    const visual = step.verify.visualAssert?.trim();
    const assert = step.verify.assert?.trim();
    if (visual) {
      // A step may declare both: one confirm answers both, so the agent is
      // asked about both (the text assert used to be skipped silently).
      const claim = assert ? `${visual}" AND "${assert}` : visual;
      if (confirm === undefined) {
        let dataUrl = "";
        try {
          ({ dataUrl } = await this.evidence.screenshot(p.planId, page));
        } catch {
          /* no screenshot — the agent still judges from the claim text */
        }
        return { kind: "judgeVisual", index: p.cursor, total: p.steps.length, step, claim, dataUrl };
      }
      if (confirm === false) return this.failStep(p, step, [`you judged the claim false: "${claim}"`]);
      // confirm === true → fall through to advance.
    } else if (assert) {
      if (confirm === undefined) return { kind: "judge", index: p.cursor, total: p.steps.length, step, assert };
      if (confirm === false) return this.failStep(p, step, [`you judged the assertion false: "${assert}"`]);
      // confirm === true → fall through to advance.
    }

    // Verified — turn this step's body capture back off (on at entry → off now).
    if (step.verify.networkOk?.bodyIncludes) {
      try {
        await this.evidence.setNetworkCapture(p.planId, false, page);
      } catch {
        /* best-effort off */
      }
    }

    let note: RecordingNote | undefined;
    if (p.recording) {
      const acts = p.pendingActions;
      // 1 action → unambiguous, keep it. 0 (check-only step) or >1 (can't tell
      // which one this step "is") both stay undefined — stopRecording() warns.
      p.recording.actions[p.cursor] = acts.length === 1 ? acts[0] : undefined;
      // Report the SAME judgment now, while the run can still be corrected.
      note = recordingNote(acts);
    }
    // Same unambiguous-only rule as recording.actions above, but ALWAYS (not
    // just while recording) — this is the data log, not the reusable-playbook
    // capture.
    if (p.pendingActions.length === 1) {
      p.results.push({ index: p.cursor, goal: step.goal, method: p.pendingActions[0].method, value: p.pendingValues[0] });
    }
    p.pendingActions = [];
    p.pendingValues = [];

    p.cursor++;
    if (p.cursor >= p.steps.length) {
      p.done = true;
      return { kind: "complete", total: p.steps.length, recording: note, notes: outcome.notes };
    }
    await this.enterStep(p);
    return { kind: "advanced", index: p.cursor, total: p.steps.length, next: p.steps[p.cursor], recording: note, notes: outcome.notes };
  }

  private async failStep(p: PlanRecord, step: PlanStep, failed: string[]): Promise<AdvanceResult> {
    const onFail = step.onFail ?? "escalate";
    const maxRetries = step.maxRetries ?? 1;
    if (onFail !== "escalate" && p.attempts < maxRetries) {
      p.attempts++;
      // Re-capture the baseline so the retry's redo is measured from now, and so a
      // baseline that FAILED to capture at step entry (transient disconnect) is
      // re-attempted — a networkOk retry can actually recover instead of looping
      // on a stuck null baseline.
      await this.captureBaseline(p);
      // Drop the failed attempt's action(s) — if recording, only the redo that
      // FINALLY passes verify should be captured, not the one that didn't work.
      // Both arrays reset together: they are paired 1:1 by index, so clearing
      // only one leaves the redo's action reading the failed attempt's value.
      p.pendingActions = [];
      p.pendingValues = [];
      return { kind: "retry", strategy: onFail, remaining: maxRetries - p.attempts, step, failed };
    }
    return {
      kind: "escalate",
      index: p.cursor,
      total: p.steps.length,
      step,
      failed,
      results: p.results,
      ownValue: p.pendingValues.length === 1 ? p.pendingValues[0] : undefined,
    };
  }

  /** Capture the browser-clock network watermark for the CURRENT step (null if
   * the read fails → verify fail-closes networkOk). Does NOT touch attempts, so
   * it can also run on a retry to re-measure without resetting the retry budget. */
  private async captureBaseline(p: PlanRecord): Promise<void> {
    p.netBaseline = null;
    p.bodySeqBaseline = this.evidence.networkBodies(p.planId, Number.MAX_SAFE_INTEGER, p.steps[p.cursor].page).maxSeq;
    const net = p.steps[p.cursor].verify.networkOk;
    if (net) {
      try {
        const { requests } = await this.evidence.readNetwork(p.planId, p.steps[p.cursor].page);
        // 0 when the buffer is legitimately empty (no stale to exclude). A FAILED
        // read must NOT fall back to 0 — that accepts every request; it stays
        // null so verify() fail-closes networkOk instead of false-passing.
        p.netBaseline = requests.reduce((m, r) => Math.max(m, r.ts), 0);
      } catch {
        p.netBaseline = null;
      }
      // A bodyIncludes step needs the MAIN-world body capture ON before the
      // request — enable it now (turned back off once the step verifies).
      if (net.bodyIncludes) {
        try {
          await this.evidence.setNetworkCapture(p.planId, true, p.steps[p.cursor].page);
        } catch {
          /* toggle failed (e.g. manual mode w/o claim) — verify fail-closes on the body */
        }
      }
    }
  }

  /** Called when a step becomes current (at create and on each advance): reset
   * the retry counter and capture a fresh baseline. */
  private async enterStep(p: PlanRecord): Promise<void> {
    if (p.done) return;
    p.attempts = 0;
    await this.captureBaseline(p);
  }

  /** Evaluate the MECHANICAL predicates against fresh structured reads. All
   * present checks are ANDed; only the reads a predicate needs are performed.
   * `assert` is NOT evaluated here — it is agent-judged in advanceOnce. Every
   * evidence read routes to the current step's logical page (`p.steps[p.cursor].page`). */
  private async verify(
    p: PlanRecord,
    v: StepVerify,
    netBaseline: number | null,
    bodySeqBaseline: number,
    actionSucceeded: boolean,
  ): Promise<VerifyOutcome> {
    const planId = p.planId;
    const page = p.steps[p.cursor].page;
    const failed: string[] = [];
    const notes: string[] = [];

    if (v.actionSucceeded && !actionSucceeded) failed.push("no successful action was recorded for this step");

    const needsSnapshot =
      v.elementName != null || v.elementChecked != null || v.elementEnabled != null || v.elementValue != null;

    // Any DOM-derived check needs page_state — both to evaluate page-state
    // predicates AND to gate DOM/content/element checks on hydration.
    const needsPageState =
      v.urlIncludes != null ||
      v.noErrors ||
      v.settled ||
      v.dialogOpen ||
      v.formSubmittable ||
      v.textPresent != null ||
      v.textAbsent != null ||
      needsSnapshot;

    if (needsPageState) {
      const s = await this.evidence.pageState(planId, page);
      // Hydration gate: on an un-hydrated page the DOM is empty, so textAbsent
      // "passes" (nothing rendered), element checks false-fail, formSubmittable is
      // meaningless. Refuse to verify DOM/content predicates until settled.
      const contentSensitive =
        v.textPresent != null ||
        v.textAbsent != null ||
        needsSnapshot ||
        v.formSubmittable === true ||
        v.noErrors === true ||
        v.dialogOpen === true;
      if (s.loading && contentSensitive) {
        return {
          pass: false,
          failed: ["page not settled/hydrated yet — DOM predicates can't be trusted (add a `settled` step earlier, or wait before advancing)"],
        };
      }
      if (v.urlIncludes != null && !s.url.includes(v.urlIncludes))
        failed.push(`url does not contain "${v.urlIncludes}" (is ${s.url})`);
      if (v.noErrors && s.errorCount > 0) failed.push(`page shows ${s.errorCount} error(s)`);
      if (v.settled && s.loading) failed.push("page still loading / not hydrated");
      if (v.dialogOpen && s.dialogs === 0) failed.push("no dialog/modal is open");
      if (v.formSubmittable && !(s.forms.controls > 0 && s.forms.emptyRequired === 0 && s.forms.invalid === 0))
        failed.push(`form not submittable (${s.forms.emptyRequired} required-empty, ${s.forms.invalid} invalid)`);
    }

    if (v.textPresent != null || v.textAbsent != null) {
      const { text } = await this.evidence.readContent(planId, page);
      const haystack = normalizeRenderedText(text);
      if (v.textPresent != null) {
        const needle = normalizeRenderedText(v.textPresent);
        // All-whitespace/zero-width expectations survive create()'s trim check
        // but normalize to "" — and includes("") is always true. Fail instead.
        if (needle.length === 0) failed.push(`textPresent "${v.textPresent}" is only whitespace — it would match anything`);
        else if (!haystack.includes(needle)) failed.push(`text "${v.textPresent}" not present`);
      }
      if (v.textAbsent != null) {
        const needle = normalizeRenderedText(v.textAbsent);
        // Same rule as textPresent: an expectation that normalizes to nothing says nothing about the page, and
        // skipping it passed the check unconditionally.
        if (needle.length === 0) failed.push(`textAbsent "${v.textAbsent}" is only whitespace — it would pass on any page`);
        else if (haystack.includes(needle)) failed.push(`text "${v.textAbsent}" still present`);
      }
    }

    if (needsSnapshot) {
      const { elements } = await this.evidence.snapshot(planId, page);
      // A hidden group is the container of a closed menu, named by all the text it holds: not an element anyone
      // could interact with, and its name would match any one of its items' names.
      // An element named exactly what was asked holds the check. One whose name only CONTAINS it still does —
      // recorded books rely on that — but the step then says which element it was, so "同意" held by a checked
      // "不同意并退出" is in the result instead of passing silently. Names compare the way query and pick_option
      // compare them (see text-match.ts).
      const holds = (what: string, q: string, pred: (e: SnapshotElement) => boolean): boolean => {
        const graded = elements
          .filter((e) => !e.hiddenGroup && pred(e))
          .map((e) => ({ e, g: matchGrade(e.name, q) }))
          .filter((x) => x.g);
        if (graded.some((x) => x.g === "exact")) return true;
        if (!graded.length) return false;
        notes.push(
          `${what} "${q}" held only through ${graded.map((x) => `[${x.e.ref}] "${x.e.name}"`).slice(0, 3).join(", ")} — no element is named exactly "${q}"`,
        );
        return true;
      };
      if (v.elementName != null && !holds("elementName", v.elementName, () => true))
        failed.push(`no interactable element named "${v.elementName}" (plain-text banners aren't in the snapshot — use textPresent for status text)`);
      if (v.elementChecked != null && !holds("elementChecked", v.elementChecked, (e) => e.checked === true))
        failed.push(`no checked element named "${v.elementChecked}"`);
      if (v.elementEnabled != null && !holds("elementEnabled", v.elementEnabled, (e) => e.disabled !== true))
        failed.push(`no enabled element named "${v.elementEnabled}"`);
      if (v.elementValue != null) {
        const { name, equals, includes } = v.elementValue;
        const hit = holds(
          "elementValue",
          name,
          (e) =>
            e.value != null &&
            (equals != null ? e.value === equals : includes != null ? e.value.includes(includes) : true),
        );
        if (!hit)
          failed.push(
            `no element named "${name}" with value ${equals != null ? `= "${equals}"` : includes != null ? `containing "${includes}"` : "(set)"}`,
          );
      }
    }

    if (v.networkOk != null) {
      if (netBaseline === null) {
        // Baseline never captured (evidence read failed at step entry). Using 0
        // would accept every request incl. a stale prior 2xx — fail-closed instead.
        failed.push(
          `could not establish a network baseline for this step (an evidence read failed — transient disconnect, or manual mode without a claimed tab); refusing to confirm networkOk rather than accept a possibly-stale response. Retrying re-captures the baseline; if you're in manual mode, claim a tab first`,
        );
      } else {
        const want = v.networkOk;
        const { requests } = await this.evidence.readNetwork(planId, page);
        // Only requests since this step began (netBaseline), so a stale prior 2xx
        // to the same URL can't false-pass.
        const matched = requests.filter((r) => r.url.includes(want.urlIncludes) && r.ts > netBaseline);
        // One meaning of "succeeded" for the request and for its body: a body is evidence only when the response it
        // came with succeeded — a GET 200 to the same address plus a POST 500's body is not a successful save.
        const succeeded = (status: number | null | undefined): boolean =>
          want.status != null ? status === want.status : status != null && status >= 200 && status < 300;
        const ok = matched.find((r) => succeeded(r.status));
        if (!ok) {
          const seen = matched.length
            ? `saw status ${matched.map((r) => r.status ?? "pending").join(", ")}`
            : "no matching request since this step began";
          failed.push(`no ${want.status ?? "2xx"} response for "${want.urlIncludes}" (${seen})`);
        } else if (want.bodyIncludes != null) {
          // Status OK — now check the captured response BODY (MAIN-world capture,
          // enabled at step entry). Only bodies since the step began (seq baseline).
          const { bodies } = this.evidence.networkBodies(planId, bodySeqBaseline, page);
          const hit = bodies.some((b) => b.url.includes(want.urlIncludes) && succeeded(b.status) && b.body.includes(want.bodyIncludes!));
          if (!hit) {
            const n = bodies.filter((b) => b.url.includes(want.urlIncludes)).length;
            failed.push(
              `response body for "${want.urlIncludes}" does not contain "${want.bodyIncludes}" (${n} matching body/bodies captured since step began — is capture on, and the body text under 8KB?)`,
            );
          }
        }
      }
    }

    // evalCheck reads (enforced page-side); evalUntil may act, so it runs
    // last — every other predicate has already read the page it was given.
    for (const [field, check, readOnly] of [
      ["evalCheck", v.evalCheck, true],
      ["evalUntil", v.evalUntil, false],
    ] as const) {
      if (check == null) continue;
      const { code, equals } = check;
      try {
        const { value } = await this.evidence.evalJs(planId, code, readOnly, page);
        const ok = equals != null ? String(value) === equals : !!value;
        if (!ok)
          failed.push(
            `${field} failed: \`${briefCode(code)}\` → ${JSON.stringify(value)} (wanted ${equals != null ? `= "${equals}"` : "truthy"})`,
          );
      } catch (e) {
        failed.push(`${field} could not run \`${briefCode(code)}\`: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return { pass: failed.length === 0, failed, ...(notes.length ? { notes } : {}) };
  }
}
