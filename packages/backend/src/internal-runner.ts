/**
 * internal-runner.ts — loopback-only HTTP endpoints that let the @bcp/console
 * nestjs process drive a saved playbook WITHOUT going through the public MCP
 * /mcp surface. Same PlanRunner + same playback engine the MCP `run_playbook`
 * tool uses, just under a different transport so the console can poll, cancel,
 * and observe progress with plain HTTP.
 *
 * Why not MCP? Embedding a full MCP client just to call `run_playbook` is
 * overkill — and the console's poll/cancel UI doesn't speak SSE/streamable
 * well. A tiny JSON API is simpler, gives the console a stable observation
 * surface, and keeps MCP as the SSOT for any external agent.
 *
 * Trust boundary: 127.0.0.1 bind, no auth. Anything reachable on loopback can
 * drive the connected browser — the same trust posture as the MCP endpoint
 * (also loopback).
 */
import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import {
  isParamMap,
  isValidInstanceId,
  LocalMethod,
  normalizeBookCode,
  RpcMethod,
  validateBookV2,
  type BookV2,
  type BrowserTarget,
  type Delivery,
  type PageState,
  type ParamMap,
  type PickOptionParams,
  type PlanStep,
  type Playbook,
  type ResolvedDelivery,
} from "@bcp/shared";
import { config, EVAL_DISABLED, LOCAL_EVAL_DISABLED } from "./config.js";
import { isTrustedDesktopBook } from './desktop-books.js';
import { desktopHttpGuard, runtimePort } from '@bcp/shared';
import { PlanRunner, type EvidenceReader, type PlaybackStepResult } from "./orchestrator.js";
import { applyParamDefaults, instantiateSteps, loadPlaybook, savePlaybook, validatePlaybookParams } from "./playbook.js";
import { resolveUploadSources } from "./upload-source.js";
import { pickOption, pickOptionDeltaKey } from "./pick-option.js";
import { materializePlaybookUpload } from "./playbook-upload.js";
import { runAutoPlayback, type AutoPlaybackResult, type RunFinishInfo } from "./playback.js";
import { RunBrowserContext } from "./run-browser-context.js";
import { runLocalEval, writePreviousStepValue } from "./local-actions.js";
import { MUTATING, RECORDABLE_READS } from "./recordable-methods.js";
import { extractArtifacts, extractOutputs, instantiateDeliveries } from "./delivery-executor.js";
import type { DeliverySink } from "./console-delivery-client.js";
import type { WsServer } from "./ws-server.js";
import type { EventStore, RunFinishedEvent } from "./event-store.js";
import type { BrowserDispatcher } from "./browser-dispatcher.js";

/** One run the internal-runner is currently executing. console polls this
 *  until the run terminates. */
interface InternalRun {
  trustedBundledBook?: boolean;
  runId: string;
  planId: string;
  name: string;
  mode: "assisted" | "auto";
  trigger: "manual" | "schedule" | "mcp";
  params: ParamMap;
  status: "pending" | "running" | "success" | "failed" | "escalated" | "cancelled" | "needsConfirm" | "needsJudge" | "noAction";
  ranSteps: number;
  totalSteps: number;
  currentGoal: string | null;
  startedAt: number;
  finishedAt: number | null;
  error?: string;
  /** PlanRunner results snapshot — appended on each completed step. */
  results: Array<{ index: number; goal: string; method: string; value: unknown }>;
  /** The promise of the auto-playback loop, so cancel() can wait for clean exit. */
  execPromise?: Promise<AutoPlaybackResult>;
  /** Captured value strings for the last few steps (console uses to render). */
  stepHistory: Array<InternalStepEntry>;
  /** Monotonic bump on every step cursor advance (running → next step) — the
   * console's cheap change signal for live step sync. */
  stepVersion: number;
  /** Bookkeeping for the book the run is based on (so error reports include it). */
  playbookGoal: string;
  /** The book's declared deliveries (for the run_finished event + executor). */
  playbookDeliveries?: Delivery[];
  /** Deliveries resolved for THIS run ({{slot}} filled, defaults applied), set
   * at the terminal exit and surfaced in the snapshot so the CONSOLE layer —
   * not this backend — executes them against its SQLite-backed delivery queue. */
  resolvedDeliveries?: ResolvedDelivery[];
  /** The book's produced data (last local.eval value), surfaced for delivery. */
  outputs?: unknown;
  /** Files written by this run. Console polling persists these before delivery
   * ownership checks run. */
  artifacts?: Array<{ path: string; kind: "report"; size: number }>;
  /** Shared with playback and EvidenceReader; the only target-tab state for this run. */
  browserContext: RunBrowserContext;
  /** Fixed at run creation (spec §11.3): every browser RPC of this run routes
   * to this target; it does NOT drift with the global default mid-run. Absent
   * = resolved once at start from the backend default. */
  target?: BrowserTarget;
}

interface InternalStepEntry {
  stepIndex: number;
  goal: string;
  method: string;
  status: "running" | "success" | "failed";
  startedAt: number;
  finishedAt?: number;
  valuePreview?: string;
  resultId?: string;
  resultChars?: number;
  upstreamTruncated?: boolean;
  resultBody?: { raw: string; upstreamTruncated: boolean };
  error?: string;
}

const INTERNAL_PORT = Number(process.env.BCP_INTERNAL_PORT) || 8789;

export class InternalRunner {
  private app: express.Express;
  private server?: import("node:http").Server;
  /** planId -> live run state. Entries are kept AFTER completion for late
   *  pollers, and garbage-collected by `gc()` every minute (10min TTL). */
  private runs = new Map<string, InternalRun>();
  /** Per-run PlanRunner so each internal run has its own isolated plan set
   *  (no interference with the MCP session's runner). */
  private runners = new Map<string, PlanRunner>();

  constructor(
    private readonly ws: WsServer,
    private readonly events: EventStore,
    private readonly dispatcher: BrowserDispatcher,
    private readonly deliverySink?: DeliverySink,
    extraRouter?: Router,
  ) {
    this.app = express();
    this.app.use(desktopHttpGuard);
    this.app.use(express.json({ limit: "1mb" }));
    this.wireRoutes();
    if (extraRouter) this.app.use("/internal/browsers", extraRouter);
  }

  /** Spin up the HTTP listener. Returns the bound port (for log). */
  async listen(port = runtimePort(process.env.BCP_INTERNAL_PORT, INTERNAL_PORT)): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, "127.0.0.1", () => {
        const addr = this.server!.address();
        const p = typeof addr === "object" && addr ? addr.port : port;
        console.log(`[internal-runner] listening on http://127.0.0.1:${p}`);
        // GC terminal-state runs after 10 min — late pollers can still hit
        // them, but they don't leak forever.
        setInterval(() => this.gc(), 60_000).unref();
        resolve(p);
      });
      this.server.once("error", reject);
    });
  }

  async close(_timeoutMs = 5_000): Promise<void> {
    if (!this.server) return;
    for (const r of this.runs.values()) {
      if (r.execPromise) await Promise.race([r.execPromise.catch(() => undefined), new Promise((r) => setTimeout(r, 1000))]);
    }
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) =>
      this.server!.close(() => resolve()),
    );
  }

  private gc(): void {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of this.runs) {
      if (v.finishedAt && v.finishedAt < cutoff) this.runs.delete(k);
    }
  }

  private wireRoutes(): void {
    this.app.get("/internal/health", (_req, res) => {
      res.json({ ok: true, plans: this.runs.size, version: config.serverVersion });
    });

    this.app.post("/internal/run", (req, res) => {
      this.handleStart(req, res).catch((e) => {
        console.error("[internal-runner] handleStart crashed", e);
        if (!res.headersSent) res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
      });
    });
    this.app.get("/internal/run/:planId", (req, res) => this.handleStatus(req, res));
    this.app.get('/internal/run/:planId/results/:resultId', (req, res) => this.handleStepResult(req, res));
    this.app.post("/internal/run/:planId/cancel", (req, res) => this.handleCancel(req, res));
  }

  private async handleStart(req: Request, res: Response): Promise<void> {
    const { name, params, mode, trigger, playbookJson, runId: requestedRunId, planId: requestedPlanId, timezone, target } = req.body ?? {};
    if (typeof name !== "string" || !name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (mode && mode !== "assisted" && mode !== "auto") {
      res.status(400).json({ error: `mode must be "assisted" or "auto", got ${JSON.stringify(mode)}` });
      return;
    }
    const m: "assisted" | "auto" = mode ?? "auto";
    if (params !== undefined && !isParamMap(params)) {
      res.status(400).json({ error: "params must be a plain object map" });
      return;
    }
    // Optional fixed run target (spec §11.3): kind + instanceId. Validated so
    // an invalid target can never reach routing. Absent = resolved at run
    // start from the backend default and frozen for the run's lifetime.
    let runTarget: BrowserTarget | undefined;
    if (target !== undefined) {
      const t = target as Partial<BrowserTarget>;
      if (t.kind !== "chrome" && t.kind !== "firefox") {
        res.status(400).json({ error: `target.kind must be "chrome" or "firefox", got ${JSON.stringify(t.kind)}` });
        return;
      }
      if (typeof t.instanceId !== "string" || !isValidInstanceId(t.instanceId)) {
        res.status(400).json({ error: `target.instanceId must be a valid instance id` });
        return;
      }
      runTarget = { kind: t.kind, instanceId: t.instanceId };
    }
    const p: ParamMap = params ?? {};
    const runId = typeof requestedRunId === "string" && requestedRunId ? requestedRunId : randomUUID();
    const planId = typeof requestedPlanId === "string" && requestedPlanId ? requestedPlanId : `plan_${runId}`;
    const existing = this.runs.get(planId) ?? [...this.runs.values()].find((candidate) => candidate.runId === runId);
    if (existing) {
      res.status(202).json({
        planId: existing.planId,
        status: existing.status,
        totalSteps: existing.totalSteps,
        currentGoal: existing.currentGoal,
      });
      return;
    }
    const runTrigger: "manual" | "schedule" | "mcp" = trigger === "schedule" ? "schedule" : trigger === "mcp" ? "mcp" : "manual";

    let playbook: Playbook;
    let steps: PlanStep[];
    let values: ParamMap = p;
    let v2: BookV2 | undefined;
    let trustedBundledBook = false;
    try {
      // If the caller provided the full playbook JSON (console path), parse
      // it directly. Otherwise fall back to reading from disk (MCP path).
      if (typeof playbookJson === "string") {
        playbook = JSON.parse(playbookJson) as Playbook;
        // 内联 JS 的行数组合回字符串（same as loadPlaybook）——console 这条路不经过
        // loadPlaybook，漏了这一句，行数组会原样带到页面上。
        normalizeBookCode(playbook);
        // Normalize legacy paramNames → params (same as loadPlaybook)
        if (!Array.isArray(playbook.params) && Array.isArray(playbook.paramNames)) {
          playbook.params = playbook.paramNames.map((n) => ({ name: n, required: true, schema: { type: "string" } }));
        }
      } else {
        playbook = await loadPlaybook(name);
      }
      values = applyParamDefaults(playbook.params, p, {
        bookName: name,
        runId,
        planId,
        uuid: randomUUID(),
        timezone: typeof timezone === "string" ? timezone : undefined,
      });
      const problems = validatePlaybookParams(playbook.params, values);
      if (problems.length) {
        res.status(400).json({ error: `params invalid: ${problems.join("; ")}` });
        return;
      }
      steps = instantiateSteps(playbook.steps, values);
      // Book v2 gate: only for books with schemaVersion; recorded playbooks
      // (no schemaVersion) are plain step lists without pages/signals.
      if (playbook.schemaVersion != null) {
        v2 = validateBookV2(playbook);
      }
      trustedBundledBook = await isTrustedDesktopBook(playbook, { desktop: process.env.BCP_DESKTOP === '1', directory: process.env.BCP_DESKTOP_BOOKS_DIR });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      return;
    }

    const run: InternalRun = {
      trustedBundledBook,
      runId,
      planId,
      name,
      mode: m,
      trigger: runTrigger,
      params: values,
      status: "pending",
      ranSteps: 0,
      totalSteps: steps.length,
      currentGoal: steps[0]?.goal ?? null,
      startedAt: Date.now(),
      finishedAt: null,
      results: [],
      stepHistory: [],
      stepVersion: 0,
      playbookGoal: playbook.goal,
      playbookDeliveries: playbook.deliveries,
      browserContext: new RunBrowserContext(),
      target: runTarget,
    };
    this.runs.set(planId, run);

    const runner = this.buildRunner(run);
    try {
      const created = await runner.create(playbook.goal, steps, undefined, planId, v2?.pages);
      if (created.planId !== planId) throw new Error(`backend created unexpected planId ${created.planId}`);
    } catch (e) {
      this.runs.delete(planId);
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.runners.set(planId, runner);

    if (m === "auto") {
      run.status = "running";
      run.execPromise = (async (): Promise<AutoPlaybackResult> => {
        try {
          const r = await runAutoPlayback(
            runner,
            planId,
            (method, params, priorResults, opts) => this.call(planId, method, params, priorResults, opts),
            steps,
            {
              context: run.browserContext,
              onFinish: (info) => this.onRunFinished(planId, info),
              // Live progress: bump stepVersion + currentGoal on every cursor
              // advance so the console can sync steps in real time (not only
              // at terminal).
              onStep: (info) => {
                const live = this.runs.get(planId);
                if (!live) return;
                live.stepVersion++;
                live.ranSteps = info.index;
                live.currentGoal = info.goal;
              },
            },
          );
          // Same guard as the catch below, and for the same reason: a run the
          // user cancelled has its terminal fields set by `handleCancel`, and
          // whatever the playback loop decided on its way out must not replace
          // them. This only started mattering when playback stopped THROWING on
          // a cancelled plan — until then the exception carried every such run
          // into the catch, where the guard already stood.
          if (run.status !== "cancelled") this.applyResult(planId, r);
          return r;
        } catch (e) {
          // Don't overwrite "cancelled" — handleCancel set it already.
          if (run.status !== "cancelled") {
            run.status = "failed";
          }
          run.error = e instanceof Error ? e.message : String(e);
          run.finishedAt = Date.now();
          throw e;
        } finally {
          if (!["needsConfirm", "needsJudge", "noAction"].includes(run.status)) {
            run.finishedAt ??= Date.now();
          }
        }
      })();
      // The failure is already recorded on the run above (status/error/
      // finishedAt). This is a fire-and-forget background task — nothing else
      // awaits it (execPromise is only raced in close()). Attach a swallow
      // handler NOW so a business-level exception in a step action (e.g. a
      // playbook's local_eval refusing to write a partial report) can't become
      // an unhandled rejection that takes down this whole process — which hosts
      // MCP + WS, not just this one run.
      run.execPromise.catch(() => undefined);
    }

    res.status(202).json({
      planId,
      status: run.status,
      totalSteps: run.totalSteps,
      currentGoal: run.currentGoal,
    });
  }

  private buildRunner(run: InternalRun): PlanRunner {
    const events = this.events;
    const runs = this.runs;
    /** Route a browser RPC for THIS run: fixed target (run creation) wins,
     * else the backend default resolved at call time. All evidence + actions
     * go through the dispatcher's readiness gate. */
    const browserCall = <T = unknown>(method: string, params: Record<string, unknown>): Promise<T> => {
      const target = run.target ?? this.dispatcher.resolveTarget(undefined, null);
      return this.dispatcher.dispatch<T>(target, method as RpcMethod, params);
    };
    const evidence: EvidenceReader = {
      async pageState(_planId, page) { return browserCall<PageState>(RpcMethod.PageState, run.browserContext.route(RpcMethod.PageState, {}, page)); },
      async readContent(_planId, page) { return browserCall(RpcMethod.ReadContent, run.browserContext.route(RpcMethod.ReadContent, { full: true }, page)); },
      async readNetwork(_planId, page) { return browserCall(RpcMethod.ReadNetwork, run.browserContext.route(RpcMethod.ReadNetwork, {}, page)); },
      async snapshot(_planId, page) { return browserCall(RpcMethod.Snapshot, run.browserContext.route(RpcMethod.Snapshot, {}, page)); },
      async evalJs(_planId, code, page) {
        if (!config.evalEnabled && !run.trustedBundledBook) throw new Error(`evalCheck needs page JS — ${EVAL_DISABLED}`);
        return browserCall(RpcMethod.Eval, run.browserContext.route(RpcMethod.Eval, { code }, page));
      },
      async setNetworkCapture(_planId, enabled, page) {
        await browserCall(RpcMethod.SetNetworkCapture, run.browserContext.route(RpcMethod.SetNetworkCapture, { enabled }, page));
      },
      networkBodies(_planId, sinceSeq, page) {
        const { events: evs, maxSeq } = events.since(sinceSeq, run.browserContext.currentTabId(page));
        const bodies = evs
          .filter((e) => e.kind === "network_body")
          .map((e) => {
            const d = (e.detail ?? {}) as { url?: string; status?: number; body?: string };
            return { url: String(d.url ?? ""), status: Number(d.status ?? 0), body: String(d.body ?? "") };
          });
        return { bodies, maxSeq };
      },
      async screenshot(_planId, page) { return browserCall(RpcMethod.Screenshot, run.browserContext.route(RpcMethod.Screenshot, {}, page)); },
      targetAvailable(_planId, page) { return run.browserContext.targetAvailable(page); },
      waitSignal(_planId, page, condition, timeoutMs) {
        return browserCall(RpcMethod.WaitSignal, run.browserContext.route(RpcMethod.WaitSignal, { condition, timeoutMs }, page));
      },
    };
    const runner = new PlanRunner(evidence);
    // Wrap noteAction to ALSO append to our run.results so a step's mutation
    // gets captured for the console. PlanRunner's own noteAction still gets
    // called (it writes to the per-plan pendingActions/pendingValues).
    const original = runner.noteAction.bind(runner);
    runner.noteAction = (action, value) => {
      original(action, value);
      // A composite (pick_option) is ONE console result: asOneAction notes it
      // once its inner clicks are done, so skip those inner notes here too.
      if (runner.inComposite) return;
      const s = runs.get(run.planId);
      if (!s) return;
      s.results.push({
        index: s.results.length,
        goal: s.currentGoal ?? "",
        method: action.method,
        value,
      });
    };
    return runner;
  }

  private async call(
    planId: string,
    method: string,
    params: Record<string, unknown>,
    priorResults: Array<{ index: number; goal: string; method: string; value: unknown }>,
    opts?: { cleanup?: boolean; page?: string },
  ): Promise<unknown> {
    const run = this.runs.get(planId);
    if (!run) throw new Error(`internal run ${planId} disappeared`);

    if (method === LocalMethod.Eval) {
      if (!config.localEvalEnabled && !run.trustedBundledBook) throw new Error(LOCAL_EVAL_DISABLED);
      const value = runLocalEval((params as { code: string }).code, priorResults as never);
      // Mirror browser-mcp's call(): a local.* step must noteAction its value
      // too, or it never lands in run.results — extractOutputs reads the LAST
      // local.eval from there, so without this the book's outputs stay empty.
      this.runners.get(planId)?.noteAction({ method: method as LocalMethod, params: params as Record<string, unknown> }, value);
      return value;
    }
    if (method === LocalMethod.WriteFile) {
      const wf = params as { path: string; overwrite?: "overwrite" | "error" | "rename" };
      const stepIndex = this.runners.get(planId)?.status(planId).index ?? priorResults.length;
      const abs = await writePreviousStepValue(wf.path, priorResults as PlaybackStepResult[], stepIndex, { overwrite: wf.overwrite });
      const value = { path: abs };
      this.runners.get(planId)?.noteAction({ method: method as LocalMethod, params: params as Record<string, unknown> }, value);
      return value;
    }

    if (method === LocalMethod.PickOption) {
      // One step action made of several RPCs: the inner calls go through this
      // same call() (dispatcher, step history, run tab) but the runner records
      // only the composite, so the step stays replayable.
      const runner = this.runners.get(planId);
      const inner = (m: RpcMethod, p: Record<string, unknown>) => this.call(planId, m, p, priorResults, opts);
      const pick = () => pickOption(inner, params as unknown as PickOptionParams, pickOptionDeltaKey(`run:${planId}`));
      return runner ? runner.asOneAction({ method: LocalMethod.PickOption, params }, pick) : pick();
    }

    // Browser RPC — routed through the dispatcher (readiness gate + fixed run
    // target). A FAILURE-cleanup call (engine's cleanupStaleTabs/
    // closeTrackedTabs) is bookkeeping, not a step: it must not appear in
    // stepHistory (it would overwrite the real step's row and confuse the
    // console) nor noteAction (no advance will ever consume it).
    const isCleanup = opts?.cleanup === true;
    const stepIndex = isCleanup ? -1 : (this.runners.get(planId)?.status(planId).index ?? run.ranSteps);
    const stepEntry: InternalStepEntry = {
      stepIndex,
      goal: run.currentGoal ?? "",
      method,
      status: "running",
      startedAt: Date.now(),
    };
    if (!isCleanup) run.stepHistory.push(stepEntry);

    try {
      const target = run.target ?? this.dispatcher.resolveTarget(undefined, null);
      const uploadParams = method === RpcMethod.Upload
        ? materializePlaybookUpload(params as Record<string, unknown>)
        : params;
      const sourceAttachments = method === RpcMethod.Upload && Array.isArray((uploadParams as { attachments?: unknown }).attachments)
        ? (uploadParams as { attachments: Array<Record<string, unknown>> }).attachments
        : null;
      const uploadBatchSize = method === RpcMethod.Upload && Number.isInteger((uploadParams as { batchSize?: unknown }).batchSize)
        ? Math.max(1, (uploadParams as { batchSize: number }).batchSize)
        : null;
      let result: unknown;
      if (!sourceAttachments) {
        result = await this.dispatcher.dispatch(target, method as RpcMethod, uploadParams);
      } else if (!sourceAttachments.length) {
        result = { ok: true, files: [], skipped: true };
      } else {
        const { attachments: _attachments, batchSize: _batchSize, ...base } = uploadParams;
        const files: string[] = [];
        let delta: unknown;
        for (let offset = 0; offset < sourceAttachments.length; offset += uploadBatchSize ?? sourceAttachments.length) {
          const sources = await resolveUploadSources(sourceAttachments.slice(offset, offset + (uploadBatchSize ?? sourceAttachments.length)));
          if ((base as { batchUpload?: boolean }).batchUpload) {
            const uploaded = await this.dispatcher.dispatchRpc(target, RpcMethod.Upload, {
              ...base,
              filename: sources[0]?.filename,
              mimeType: sources[0]?.mimeType,
              dataBase64s: sources.map((source) => source.dataBase64),
            } as never);
            files.push(...uploaded.files);
            delta = uploaded.delta ?? delta;
          } else {
            for (const source of sources) {
              const uploaded = await this.dispatcher.dispatchRpc(target, RpcMethod.Upload, {
                ...base,
                filename: source.filename,
                mimeType: source.mimeType,
                dataBase64: source.dataBase64,
              } as never);
              files.push(...uploaded.files);
              delta = uploaded.delta ?? delta;
            }
          }
        }
        result = { ok: true, files, delta };
      }
      run.browserContext.observe(method, params, result, opts?.page);
      // Mirror of browser-mcp's call(): a successful RECORDABLE RPC lands in
      // the runner's results log (noteAction → pendingActions → advance's
      // results), so a later local.* step can read earlier browser steps' data
      // and a recording plan captures the action. Without this the console
      // path's getResults() stays empty and fail-closed books (a local.eval
      // that refuses to write a partial report) ALWAYS fail — learn.md
      // 2026-08-21, "side effects call() does but the channel doesn't".
      if (!isCleanup && (MUTATING.has(method as RpcMethod) || RECORDABLE_READS.has(method as RpcMethod))) {
        // Safe: we're in the browser-RPC branch, LocalMethod returned above.
        this.runners.get(planId)?.noteAction({ method: method as RpcMethod, params: params as Record<string, unknown> }, result);
      }
      if (!isCleanup) {
        stepEntry.status = "success";
        stepEntry.finishedAt = Date.now();
        captureStepResult(stepEntry, result);
      }
      return result;
    } catch (e) {
      if (!isCleanup) {
        stepEntry.status = "failed";
        stepEntry.finishedAt = Date.now();
        stepEntry.error = e instanceof Error ? e.message : String(e);
      }
      throw e;
    }
  }

  /** The engine's single terminal exit point: resolve the book's deliveries for
   * this run, stash them (plus the produced outputs) on the run so the snapshot
   * exposes them to the CONSOLE layer, and broadcast the run_finished event.
   * Delivery EXECUTION is the console's job (it has SQLite-backed durability) —
   * this backend only reports, it does not deliver. */
  private async onRunFinished(planId: string, info: RunFinishInfo): Promise<void> {
    const run = this.runs.get(planId);
    if (!run) return;
    if (run.status !== 'cancelled' && info.status !== 'cancelled') run.ranSteps = info.ranSteps;
    const deliveries = instantiateDeliveries(run.playbookDeliveries, run.params);
    const outputs = extractOutputs(info.results);
    const artifacts = extractArtifacts(info.results);
    run.resolvedDeliveries = deliveries;
    run.outputs = outputs;
    run.artifacts = artifacts;
    const ev: RunFinishedEvent = {
      kind: "run_finished",
      ts: Date.now(),
      planId,
      bookName: run.name,
      trigger: run.trigger,
      status: info.status,
      ranSteps: info.ranSteps,
      totalSteps: info.totalSteps,
      durationMs: info.durationMs,
      error: info.error,
      outputs,
      deliveries,
      runId: run.runId,
      artifacts,
    };
    if (this.deliverySink) {
      await this.deliverySink.ingest({
        runId: run.runId,
        planId,
        bookName: run.name,
        trigger: run.trigger,
        mode: run.mode,
        status: info.status,
        ranSteps: info.ranSteps,
        totalSteps: info.totalSteps,
        durationMs: info.durationMs,
        error: info.error,
        params: run.params,
        outputs,
        deliveries,
        artifacts,
      });
    }
    this.events.emitRunFinished(ev);
  }

  private applyResult(planId: string, r: AutoPlaybackResult): void {
    const run = this.runs.get(planId);
    if (!run) return;
    switch (r.kind) {
      case "complete":
        run.status = "success";
        run.ranSteps = r.ranSteps;
        run.finishedAt = Date.now();
        run.currentGoal = null;
        break;
      case "needsConfirm":
        run.status = "needsConfirm";
        run.ranSteps = r.index;
        run.currentGoal = r.step.goal;
        run.error = `step ${r.index + 1} requires confirmation (risk:"confirm")`;
        break;
      case "needsJudge":
        run.status = "needsJudge";
        run.ranSteps = r.index;
        run.currentGoal = r.step.goal;
        run.error = `step ${r.index + 1} needs judgment: ${r.assert ?? ""}`;
        break;
      case "noAction":
        run.status = "noAction";
        run.ranSteps = r.index;
        run.currentGoal = r.step.goal;
        run.error = `step ${r.index + 1} has no recorded action`;
        break;
      case "escalate":
        run.status = "escalated";
        run.ranSteps = r.index;
        run.finishedAt = Date.now();
        run.error = r.failed.join("; ");
        break;
    }
  }

  private handleStatus(req: Request, res: Response): void {
    const planId = String(req.params.planId);
    const run = this.runs.get(planId);
    if (!run) {
      res.status(404).json({ error: `run ${planId} not found (it may have completed and been GC'd)` });
      return;
    }
    res.json(this.snapshotRun(run));
  }

  private handleCancel(req: Request, res: Response): void {
    const planId = String(req.params.planId);
    const run = this.runs.get(planId);
    if (!run) {
      res.status(404).json({ error: `run ${planId} not found` });
      return;
    }
    if (run.finishedAt) {
      res.status(409).json({ error: `run ${planId} already finished (${run.status})` });
      return;
    }
    run.status = "cancelled";
    run.finishedAt = Date.now();
    run.error = "cancelled by user";

    // Abort the PlanRunner so the auto-playback loop stops.
    // The execPromise's catch block checks `status !== "cancelled"` before
    // overwriting it to "failed", so the cancelled status survives.
    const runner = this.runners.get(planId);
    if (runner) {
      try { runner.abort(planId); } catch { /* ignore */ }
    }

    res.json({ ok: true, planId: run.planId, status: run.status });
  }

  private snapshotRun(run: InternalRun): object {
    return {
      planId: run.planId,
      name: run.name,
      mode: run.mode,
      params: run.params,
      status: run.status,
      ranSteps: run.ranSteps,
      totalSteps: run.totalSteps,
      currentGoal: run.currentGoal,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.finishedAt ? run.finishedAt - run.startedAt : Date.now() - run.startedAt,
      error: run.error,
      stepHistory: run.stepHistory.map(({ resultBody: _resultBody, ...entry }) => entry),
      /** Monotonic step cursor version — the console's live-sync change signal. */
      stepVersion: run.stepVersion,
      target: run.target,
      deliveries: run.resolvedDeliveries ?? [],
      outputs: run.outputs,
      artifacts: run.artifacts ?? [],
      results: run.results.map((r) => ({
        index: r.index,
        goal: r.goal,
        method: r.method,
        valuePreview: previewValue(r.value),
      })),
    };
  }

  private handleStepResult(req: Request, res: Response): void {
    const run = this.runs.get(String(req.params.planId));
    const result = run?.stepHistory.find(entry => entry.resultId === String(req.params.resultId))?.resultBody;
    if (!result) {
      res.status(404).json({ error: 'step result not found or expired' });
      return;
    }
    res.json(result);
  }
}

function captureStepResult(entry: InternalStepEntry, value: unknown): void {
  let raw: string;
  try { raw = JSON.stringify(value) ?? 'null'; } catch { raw = String(value); }
  const upstreamTruncated = !!value && typeof value === 'object' && (value as { truncated?: unknown }).truncated === true;
  entry.resultId = randomUUID();
  entry.resultBody = { raw, upstreamTruncated };
  entry.resultChars = raw.length;
  entry.upstreamTruncated = upstreamTruncated;
  entry.valuePreview = raw.slice(0, 4096);
}

function previewValue(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 4096);
  } catch {
    return String(v).slice(0, 4096);
  }
}
