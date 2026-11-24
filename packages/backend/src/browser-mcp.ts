import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LocalMethod, RPC_TRAITS, RpcMethod, browserLabel, isAgentHiddenEvent, isTopologyEvent, type ActionDelta, type BrowserEvent, type BrowserStatus, type BrowserTarget, type PageState, type ParamMap, type Playbook, type PlanStep, type RpcContracts, type SnapshotElement, type StepVerify, type TabInfo } from "@bcp/shared";
import { MCP_TOOL_INSTRUCTIONS, validateBookV2, EVAL_TIMEOUT_MS } from "@bcp/shared";
import { config, domainAllowed, EVAL_DISABLED } from "./config.js";
import { PlanRunner, type RecordingNote } from "./orchestrator.js";
import { applyParamDefaults, instantiateSteps, listPlaybooks, loadPlaybook, savePlaybook, validatePlaybookParams } from "./playbook.js";
import { materializePlaybookUpload } from "./playbook-upload.js";
import { keepFailedTabs, runAutoPlayback, type RunFinishInfo } from "./playback.js";
import { RunBrowserContext } from "./run-browser-context.js";
import { runLocalEval, writeLocalFile } from "./local-actions.js";
import { resolveUploadSources } from "./upload-source.js";
import { MUTATING, RECORDABLE_READS, TAB_SCOPED } from "./recordable-methods.js";
import { extractArtifacts, extractOutputs, instantiateDeliveries } from "./delivery-executor.js";
import type { DeliverySink } from "./console-delivery-client.js";
import type { EventStore, RunFinishedEvent } from "./event-store.js";
import { EventInbox, type CallWindow } from "./event-inbox.js";
import type { BrowserDispatcher } from "./browser-dispatcher.js";
import type { BrowserSetupService } from "./browser-setup-service.js";
import type { BrowserCall, BrowserLifecycle, BrowserRegistry, RawBrowserCall, ReadSnapshot } from "./browser-mcp-types.js";
export type { BrowserCall, BrowserLifecycle, BrowserRegistry, RawBrowserCall } from "./browser-mcp-types.js";
import { BROWSER_INSTRUCTIONS } from "./browser-mcp-instructions.js";
import { deltaGate, mergeDeltas, describeRecording, describeVerify, fail, gateNote, renderDelta, renderHistoryNav, renderPageState, renderSnapshot, renderShownDelta, renderSnapshotView, renderTabsByWindow, text } from "./browser-mcp-render.js";
import { looseBool, stepShape, tabId, verifyShape } from "./browser-mcp-shapes.js";
import { registerPlanTools } from "./browser-mcp-tools-plan.js";
import { registerDomTools } from "./browser-mcp-tools-dom.js";
import { registerCaptureTools } from "./browser-mcp-tools-capture.js";
import { registerLifecycleTools } from "./browser-mcp-tools-lifecycle.js";
import { registerTabsTools } from "./browser-mcp-tools-tabs.js";
import { registerIoTools } from "./browser-mcp-tools-io.js";
import { registerBatchTools } from "./browser-mcp-tools-batch.js";
import { registerPlaybookTools } from "./browser-mcp-tools-playbook.js";
import { captureBrowserScreenshot, withForegroundLease } from './browser-screenshot.js';
import { PageReadDumpStore } from "./browser-read-dump.js";
import { ShownLedger } from "./snapshot-ledger.js";

/** Monotonic per-MCP-session id, used to scope page_state's change baseline to
 * the observing session (so two sessions sharing a tab keep independent deltas).
 * Prefixed with a per-PROCESS id: the baseline lives in the page's isolated
 * world and outlives a backend restart, so a bare "s1" would collide with a
 * previous run's leftover baseline. */
let sessionSeq = 0;
const PROCESS_KEY = randomUUID().slice(0, 8);

export function createBrowserMcpServer(
  rawCall: RawBrowserCall,
  events: EventStore,
  browsers?: BrowserRegistry,
  deliverySink?: DeliverySink,
  lifecycle?: BrowserLifecycle,
): McpServer {
  const server = new McpServer({ name: "browser", version: "0.1.0" }, { instructions: BROWSER_INSTRUCTIONS });
  const readDumps = new PageReadDumpStore();

  // Which events this session has been shown, and the context of each tool
  // call. Every tool registered below runs through this wrapper, so "since
  // your previous call" and "the tab this call acted on" have one meaning in
  // every reply and in wait_for_event. The context rides AsyncLocalStorage, so
  // tool calls that overlap in one session never read each other's.
  const inbox = new EventInbox(events);
  const toolCall = new AsyncLocalStorage<{ window: CallWindow; actedTab?: number }>();
  // One session's tool calls run in the order they arrived. A client sends several calls in one turn (click +
  // snapshot, navigate + snapshot, click + click) and the transport delivers them concurrently: the snapshot read
  // the page before the click landed, and two clicks interleaved — with a claimed tab or an explicit tabId nothing
  // else ordered them. Every call that is not declared read-only runs after the previous one finished; a read runs
  // after every such call that arrived before it, so it sees what they did. An action does not wait for reads that
  // arrived earlier, so "wait_for_event, then click what fires it" in one turn does not block on itself.
  let lastAction: Promise<unknown> = Promise.resolve();
  const inArrivalOrder = (readOnly: boolean, run: () => unknown): Promise<unknown> => {
    const p = lastAction.then(run);
    if (!readOnly) lastAction = p.catch(() => {});
    return p;
  };
  const registerTool = server.registerTool.bind(server);
  server.registerTool = ((name: string, toolConfig: unknown, cb: (...args: unknown[]) => unknown) => {
    const readOnly = (toolConfig as { annotations?: { readOnlyHint?: boolean } } | undefined)?.annotations?.readOnlyHint === true;
    return registerTool(name, toolConfig as never, ((...args: unknown[]) =>
      inArrivalOrder(readOnly, () => toolCall.run({ window: inbox.beginCall() }, () => cb(...args)))) as never);
  }) as typeof server.registerTool;

  // ── Per-MCP-session routing state (this closure IS the session) ──────────
  /** Target this session drives; null = follow the backend's global default. */
  let sessionTarget: BrowserTarget | null = null;
  /** Tab claimed as this session's default workspace, BOUND to the target it
   * was claimed in — tab ids are per-instance small integers, so a claim must
   * never be injected into a different instance's calls (id collision would
   * silently drive an unrelated page there). */
  let claimed: { target: BrowserTarget | null; tabId: number } | null = null;
  /** This session's plan runner (assigned below when constructed). BCP_FORCE_PLAN
   * checks it in `call` to refuse mutations when there's no active plan. */
  let planRunner: PlanRunner | null = null;

  /** Stable per-session key so page_state's change baseline is observer-scoped.
   * Process-prefixed so a backend restart never reads a stale in-page baseline. */
  const deltaKey = `${PROCESS_KEY}.s${++sessionSeq}`;

  /** What this session last perceived: the browser and tab of its latest delivered snapshot, and the documents each
   *  tab's frames held at its latest delivered read. Refs are numbered per document and only mean something where
   *  they were read, so an action by ref goes to the tab it was read in — not to whatever tab is active by then —
   *  and only while that tab still holds the same document. */
  let lastRead: { instanceId?: string; tabId: number } | null = null;
  const readDocs = new Map<string, Record<string, string>>();

  /** The target this session's calls actually land on right now. */
  const resolvedTarget = (): BrowserTarget | null => sessionTarget ?? browsers?.current() ?? null;

  /** The claim's tabId, only when it belongs to `target`. */
  const claimFor = (target: BrowserTarget | null): number | undefined =>
    claimed && claimed.target?.instanceId === target?.instanceId ? claimed.tabId : undefined;

  /** Set/clear the claim AND mirror it into the shared cross-session registry,
   * so the two never drift and peers can see this session's claim. */
  const setClaimed = (next: { target: BrowserTarget | null; tabId: number } | null): void => {
    claimed = next;
    if (!browsers) return;
    if (next && next.target) browsers.setClaim(deltaKey, next.target, next.tabId, Date.now());
    else browsers.clearClaim(deltaKey);
  };
  // Session death (transport closed) → drop this session's claim from the registry.
  server.server.onclose = () => {
    browsers?.clearClaim(deltaKey);
    void readDumps.dispose();
  };

  /** Manual mode normally refuses a TAB_SCOPED call with no tabId, so nothing
   * can silently default onto the user's tab. These four are the exception the
   * MUTATING guard below already assumes ("Reads are allowed"): they only
   * observe, so the worst case is reading the user's own page. Without this a
   * plan whose LAST step closes its own tab can never finish — verify runs
   * after the action, the claim is gone with the tab, and page_state has
   * nothing left to address. Eval and Screenshot stay OUT on purpose: eval can
   * mutate, and a screenshot of the user's tab leaks what they're looking at. */
  const MANUAL_READ_FALLBACK = new Set<RpcMethod>([
    RpcMethod.PageState, RpcMethod.Snapshot, RpcMethod.ReadContent, RpcMethod.ReadNetwork,
  ]);

  /** True when `tabId` is the tab the user is actually looking at (the active
   * tab of the OS-focused window) on `target`. One ListWindows round-trip; used
   * only on the rare manual-mode mutating path. */
  const isUserVisibleTab = async (target: BrowserTarget, tabId: number): Promise<boolean> => {
    try {
      const { windows } = await rawCall(RpcMethod.ListWindows, {}, target);
      const focused = windows.find((w) => w.focused);
      return !!focused && focused.activeTabId === tabId;
    } catch {
      return false; // can't tell → don't over-block
    }
  };

  /** Single choke point every tool handler goes through. At ENTRY it freezes
   * this call's routing (target resolved once — a concurrent use_browser or a
   * backend failover mid-flight must not reroute a call already dispatched),
   * defaults omitted tabIds to the claimed tab (same-target claims only),
   * enforces manual mode, and queues foreground-touching calls on the
   * per-instance lease so they can't land mid-screenshot-switch. Every call
   * routes through the injected rawCall which is the DISPATCHER — the readiness
   * gate (authenticated session + probe) is non-negotiable. */
  const call: BrowserCall = async (method, params, targetOverride) => {
    // A new browser operation marks the end of the previous perceive/act
    // round. Delete its dump before dispatching anything else; the agent has
    // already had a chance to read the manifest/chunks through its file tool.
    await readDumps.cleanup();
    const target = targetOverride ?? resolvedTarget();
    const resolved = target ?? null;
    let p = params as Record<string, unknown> & { tabId?: number | null };
    // BCP_FORCE_PLAN: turn the opt-in gate into a hard rule — a mutating action
    // needs an active plan (declare a verifiable plan before you can change the page).
    if (config.forcePlan && MUTATING.has(method) && !planRunner?.hasActivePlan()) {
      throw new Error(
        `BCP_FORCE_PLAN is on — a mutating action (${method}) needs an active plan. Call plan() first (declare the step + its verify), then act, then advance().`,
      );
    }
    const claimTab = claimFor(resolved);
    if (!resolved) {
      throw new Error("no browser target — call launch_browser / use_browser first (or wait for one to connect)");
    }
    // The session's browser changed under it (the claimed browser went offline and the default moved on): a call
    // that would have gone to the claimed tab must not land on another browser's active tab instead.
    if (claimed && claimed.target && claimed.target.instanceId !== resolved.instanceId && TAB_SCOPED.has(method) && p?.tabId == null) {
      throw new Error(
        `this session's claimed tab ${claimed.tabId} is in browser "${browserLabel(claimed.target)}", but calls now go to "${browserLabel(resolved)}" (the claimed browser went offline or another became the default). Nothing was done. use_browser to go back to it, or claim_tab / new_tab here.`,
      );
    }
    // An action by [ref] acts where that ref was read.
    const ref = typeof p?.ref === "string" ? p.ref : undefined;
    if (ref && RPC_TRAITS[method].domOp && !RPC_TRAITS[method].readOnly) {
      if (p.tabId == null && claimTab == null && lastRead) {
        if (lastRead.instanceId !== resolved.instanceId)
          throw new Error(
            `[${ref}] was read in another browser than the one this session now drives ("${browserLabel(resolved)}"). Nothing was done. Take a snapshot here for its refs, or use_browser to go back.`,
          );
        p = { ...p, tabId: lastRead.tabId };
      }
      const docs = readDocs.get(`${resolved.instanceId}:${p.tabId ?? claimTab}`);
      const frame = /^(\d+)_/.exec(ref)?.[1] ?? "0";
      if (docs?.[frame]) p = { ...p, expectDoc: docs[frame] };
    }
    if (claimTab != null && TAB_SCOPED.has(method) && p?.tabId == null) {
      p = { ...p, tabId: claimTab };
    }
    const mode = resolved ? browsers?.getMode(resolved.instanceId) : undefined;
    if (browsers && resolved && mode === "manual") {
      const label = browserLabel(resolved);
      if (method === RpcMethod.SwitchTab) {
        throw new Error(
          `browser "${label}" is in manual mode (the user is driving it) — switching tabs would change what they see. Work in a claimed background tab, or ask the user / set_browser_mode auto.`,
        );
      }
      if (TAB_SCOPED.has(method) && p?.tabId == null && !MANUAL_READ_FALLBACK.has(method)) {
        throw new Error(
          `browser "${label}" is in manual mode — every operation needs an explicit tabId (new_tab with claim, or claim_tab) so the user's current tab is never touched.`,
        );
      }
      // A resolved tabId (explicit OR injected-claim) that IS the user's visible
      // tab must not be MUTATED — manual mode's whole point. Reads are allowed.
      // …unless the target is THIS session's claimed tab. claim_tab already
      // refuses to claim the user's visible tab in manual mode, so a claimed tab
      // is by construction our own workspace. Chrome can still focus it against
      // our wishes — windows.create({focused:false}) is advisory on some
      // platforms — and then this guard would strand the run by refusing to
      // drive (or close) a tab the user never asked for.
      if (MUTATING.has(method) && p.tabId != null && p.tabId !== claimTab && (await isUserVisibleTab(resolved, p.tabId))) {
        throw new Error(
          `browser "${label}" is in manual mode — tab ${p.tabId} is the user's currently-visible tab (focused window). Refusing to modify it. Work in a background/claimed tab, or set_browser_mode auto.`,
        );
      }
      if (method === RpcMethod.NewTab && (p as { active?: boolean }).active !== false) {
        // Open in the background: don't yank the user's view to the new tab.
        p = { ...p, active: false };
      }
      if (method === RpcMethod.NewWindow && (p as { focused?: boolean }).focused === true) {
        // Never raise a window in the user's face while they're driving.
        p = { ...p, focused: false };
      }
      if (method === RpcMethod.CloseWindow && (p as { windowId?: number }).windowId == null) {
        throw new Error(
          `browser "${label}" is in manual mode — close_window without a windowId would close the USER's window. Pass the explicit windowId of a window this session created.`,
        );
      }
    }
    // Calls that change — or read via — the window's visible tab share the
    // foreground lease, so none of them lands inside another session's
    // switch→shoot→restore critical section (or vice versa).
    // Route on the frozen `resolved` (not the dynamic `target`): a default-
    // following session's call must land on the browser it resolved to at
    // entry, even if the global default fails over microseconds later.
    const route = resolved;
    const touchesForeground =
      method === RpcMethod.SwitchTab ||
      (method === RpcMethod.NewTab && (p as { active?: boolean }).active === true) ||
      (TAB_SCOPED.has(method) && p?.tabId == null);
    // Self-heal a dangling claim: if THIS call defaulted to the claimed tab and
    // that tab is gone (another agent or the user closed it), the claim would
    // otherwise poison every future defaulted call. Drop it and report once.
    const injectedClaim = claimTab != null && p.tabId === claimTab && claimed?.tabId === claimTab && claimed.target?.instanceId === resolved?.instanceId;
    const leaseKey = route?.instanceId ?? "";
    // 书里的上传步骤写的是 `attachmentFrom` / `attachmentsFrom`（canonical 的图片对象，
    // 带 url + localPath），必须先物化成真实字节才能发给扩展。internal-runner 走的是
    // 自己那条路，早就调了这个函数；**MCP 的 run_playbook 这条路没调**，于是
    // `attachmentFrom` 原样透传，扩展那边 `params.dataBase64` 是 undefined，
    // 于是 `new File([], "upload", {type:"application/octet-stream"})` —— 一个空的、
    // 名叫 upload 的八位字节流。抖店当场弹「上传图片仅支持JPG、JPEG、PNG格式」，
    // 而书这边看到的是 verify 的 `no 200 response for /product/img/batchupload`，
    // 与真因隔着整条链路（2026-09-07 实测：同一张图用 upload_file 工具直接传，200 通过）。
    //
    // 放在这里而不是各调用点：这是【所有】Upload 派发的必经之处，rawCall 之前的最后
    // 一站。对不带 attachmentFrom/attachmentsFrom 的入参（upload_file 工具的
    // url / localPath / attachments 三种形态）它原样返回，所以既有行为逐字节不变。
    if (method === RpcMethod.Upload) p = materializePlaybookUpload(p) as typeof p;
    const sourceAttachments = method === RpcMethod.Upload && Array.isArray((p as { attachments?: unknown }).attachments)
      ? (p as { attachments: Array<Record<string, unknown>> }).attachments
      : null;
    const uploadBatchSize = method === RpcMethod.Upload && Number.isInteger((p as { batchSize?: unknown }).batchSize)
      ? Math.max(1, (p as { batchSize: number }).batchSize)
      : null;
    const run = async () => {
      if (!sourceAttachments) return rawCall(method, p as never, route);
      if (!sourceAttachments.length) return { ok: true, files: [], skipped: true } as never;
      const { attachments: _attachments, batchSize: _batchSize, ...base } = p;
      const files: string[] = [];
      let delta: ActionDelta | undefined;
      for (let offset = 0; offset < sourceAttachments.length; offset += uploadBatchSize ?? sourceAttachments.length) {
        const sources = await resolveUploadSources(sourceAttachments.slice(offset, offset + (uploadBatchSize ?? sourceAttachments.length)));
        if ((base as { batchUpload?: boolean }).batchUpload) {
          const uploaded = await rawCall(RpcMethod.Upload, {
            ...base,
            filename: sources[0]?.filename,
            mimeType: sources[0]?.mimeType,
            dataBase64s: sources.map((source) => source.dataBase64),
          } as never, route);
          files.push(...uploaded.files);
          delta = mergeDeltas(delta, uploaded.delta);
        } else {
          for (const source of sources) {
            const uploaded = await rawCall(RpcMethod.Upload, {
              ...base,
              filename: source.filename,
              mimeType: source.mimeType,
              dataBase64: source.dataBase64,
            } as never, route);
            files.push(...uploaded.files);
            delta = mergeDeltas(delta, uploaded.delta);
          }
        }
      }
      return { ok: true, files, delta } as never;
    };
    const exec = touchesForeground
      ? () => withForegroundLease(leaseKey, run)
      : run;
    const result = injectedClaim ? healDeadClaim(claimTab!, exec()) : exec();
    // The tab this call ran in — what the extension resolved when no tabId was
    // sent — is the tab this tool call's reply reports events for.
    const ctx = toolCall.getStore();
    if (ctx && TAB_SCOPED.has(method)) {
      result.then(
        (value) => {
          const ran = (value as { tabId?: unknown } | null | undefined)?.tabId;
          if (typeof ran === "number") ctx.actedTab = ran;
          else if (typeof p.tabId === "number") ctx.actedTab = p.tabId;
        },
        () => {},
      );
    }
    if (MUTATING.has(method) || RECORDABLE_READS.has(method)) {
      // Record the ORIGINAL params (pre claim-injection) — a playbook step
      // that omitted tabId should stay omitted, so replay in a different
      // session lands on ITS OWN claimed/active tab, not this recording
      // session's specific tab id baked in.
      result.then(
        (value) => planRunner?.noteAction({ method, params: params as Record<string, unknown> }, value),
        () => {},
      );
    }
    return result;
  };

  /** If `promise` fails because the claimed tab is gone, drop the claim and
   * report once — shared by call() and captureWithLease so BOTH self-heal (not
   * just the call() path), keeping the behavior symmetric. */
  const healDeadClaim = <T>(claimTab: number, promise: Promise<T>): Promise<T> =>
    promise.catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no tab with id|no tab found|tab .* (closed|gone)/i.test(msg) && claimed?.tabId === claimTab) {
        setClaimed(null);
        throw new Error(`claimed tab ${claimTab} is gone (closed by the user or another agent) — claim released; re-claim or pass an explicit tabId. [${msg}]`);
      }
      throw e;
    });

  /** Screenshot under the foreground lease: switch (tab-only, NO OS focus) →
   * settle → verify the switch stuck → shoot → restore the previously visible
   * tab. Routing is frozen at entry (`route`), so a mid-flight failover or a
   * concurrent use_browser cannot split the critical section across browsers;
   * inner calls use rawCall — parameters are all explicit and mode was checked
   * here, and going through `call` would deadlock on our own lease. */
  const captureWithLease = async (
    tabIdParam: number | undefined,
  ): Promise<RpcContracts[typeof RpcMethod.Screenshot]["result"]> => {
    await readDumps.cleanup();
    const tgt = resolvedTarget();
    if (!tgt) throw new Error("no browser target — call launch_browser / use_browser first");
    const route = tgt;
    const fromClaim = tabIdParam == null ? claimFor(tgt) : undefined;
    const target = tabIdParam ?? fromClaim;
    const mode = (instanceId: string) => browsers?.getMode(instanceId) ?? 'auto';
    // The agent asked for this picture; in auto mode it may bring an unreadable background window forward.
    // Manual mode promises never to re-foreground anything in the user's face.
    const run = captureBrowserScreenshot(rawCall, route, { tabId: target, activate: mode(route.instanceId) !== 'manual' }, mode);
    // When the screenshot targeted the claimed tab and it's gone, release the
    // claim just like the call() path (symmetric self-heal).
    return fromClaim != null ? healDeadClaim(fromClaim, run) : run;
  };

  // Events can come from any connected browser — prefix the instance so lines
  // from a non-target browser are attributable.
  const evLine = (e: BrowserEvent): string => (e.browser ? `[${e.browser}] ${e.summary}` : e.summary);

  /** The events this session may see at all. Page events are scoped to this
   * session's browser; topology events are global coordination signals —
   * every agent should see them. One definition for replies, read_events and
   * wait_for_event, so the three never disagree about what exists. */
  const sessionSees = (): ((e: BrowserEvent) => boolean) => {
    const tgt = resolvedTarget();
    return (e) =>
      !isAgentHiddenEvent(e.kind) &&
      (isTopologyEvent(e.kind) || tgt == null || e.browser == null || e.browser === tgt.instanceId);
  };
  /** The unseen events this tool call's reply carries, marked seen: the
   * events of the tab the call acted on, plus tab-less (-1, worker-level) and
   * topology events. Narrowed to that tab: filtering by browser alone meant
   * every unrelated tab in the same Chrome poured its navigations into every
   * reply (a measured session carried 21-22 events per page_state, all from a
   * scratchpad file in another tab). When the call acted on no known tab,
   * only the tab-less ones. Other tabs' events stay unseen until a reply about
   * their tab, read_events or wait_for_event. */
  const drainEvents = (): string => {
    const ctx = toolCall.getStore();
    const tab = ctx?.actedTab;
    const sees = sessionSees();
    const mine = inbox.take((e) => sees(e) && (isTopologyEvent(e.kind) || e.tabId < 0 || (tab != null && e.tabId === tab)));
    if (!mine.length) return "";
    const now = Date.now();
    const line = (e: BrowserEvent) =>
      `  • ${evLine(e)}${ctx && inbox.isEarlier(e, ctx.window) ? ` (earlier, ${Math.max(0, Math.round((now - e.ts) / 1000))}s ago)` : ""}`;
    return `\n⚠ ${mine.length} unseen event(s):\n${mine.map(line).join("\n")}`;
  };

  registerLifecycleTools({
    server, call, rawCall, browsers, lifecycle, deltaKey, resolvedTarget, isUserVisibleTab,
    getSessionTarget: () => sessionTarget,
    setSessionTarget: (next) => { sessionTarget = next; },
    getClaimed: () => claimed, setClaimed,
  });

  registerTabsTools({ server, call, resolvedTarget, claimFor, setClaimed, getClaimed: () => claimed, drainEvents });

  // What this session has been shown of each tab, so a reply can name what is new to it. Keyed by the browser and
  // the tab actually read: with no tabId the read lands on whichever tab is active, and tab ids repeat across
  // browsers. Backend-internal reads (pick_option, plan runners) never touch it.
  const shownLedger = new ShownLedger();
  const readSnapshot: ReadSnapshot = async (tabId, view) => {
    const target = resolvedTarget() ?? undefined;
    const r = await call(RpcMethod.Snapshot, { tabId }, target);
    const rendered = renderSnapshotView(r.elements, view);
    // A `full` read of the whole page starts the record over: on its first page only, or paging through it would
    // keep just the last; and not when narrowed, or the record would shrink to what one search matched.
    const reset = !!view.full && !view.after && !view.query && !view.within && !view.viewportOnly;
    const seen = shownLedger.read(`${target?.instanceId}:${r.tabId}`, r.docs, r.elements, rendered.shown, { reset });
    const commit = (): void => {
      seen.commit();
      lastRead = { instanceId: target?.instanceId, tabId: r.tabId };
      if (r.docs) readDocs.set(`${target?.instanceId}:${r.tabId}`, r.docs);
    };
    return { ...r, text: rendered.text + renderShownDelta(seen.diff, { continuation: rendered.continued }), commit };
  };
  registerDomTools({ server, call, deltaKey, drainEvents, readDumps, readSnapshot });
  registerCaptureTools({ server, call, deltaKey, drainEvents, captureWithLease, readDumps, readSnapshot });
  registerIoTools({
    server, call, events, evLine, inbox, sessionSees, callWindow: () => toolCall.getStore()?.window,
    recordAsOne: (action, run) => (planRunner ? planRunner.asOneAction(action, run) : run()),
  });

  registerBatchTools({ server, call, drainEvents });

  // ── Orchestration: verifiable step-plan runner (P0 thin runner) ──────────
  // The runner gathers evidence through THIS session's `call`, so verification
  // targets the same claimed/target tab and obeys manual-mode like every tool.
  // A separate deltaKey keeps the runner's page_state reads from disturbing the
  // agent's own "changed since I looked" baseline.
  const playbackContexts = new Map<string, RunBrowserContext>();
  /** Frozen parameter snapshots for paused auto-playback. A resume must not
   * re-render dynamic defaults or accept a second params map. */
  const playbackParams = new Map<string, ParamMap>();
  const routePlaybackEvidence = (planId: string, method: RpcMethod, params: Record<string, unknown>, page?: string) => {
    const context = playbackContexts.get(planId);
    return context ? context.route(method, params, page) : params;
  };
  const runner = new PlanRunner({
    pageState: (planId, page) => call(RpcMethod.PageState, routePlaybackEvidence(planId, RpcMethod.PageState, { deltaKey: `${deltaKey}.rnr` }, page)),
    readContent: (planId, page) => call(RpcMethod.ReadContent, routePlaybackEvidence(planId, RpcMethod.ReadContent, { full: true }, page)),
    readNetwork: (planId, page) => call(RpcMethod.ReadNetwork, routePlaybackEvidence(planId, RpcMethod.ReadNetwork, {}, page)),
    snapshot: (planId, page) => call(RpcMethod.Snapshot, routePlaybackEvidence(planId, RpcMethod.Snapshot, {}, page)),
    evalJs: (planId, code, readOnly, page) => {
      // Gate the runner's own eval on policy — call() reaches RpcMethod.Eval
      // directly, bypassing the eval TOOL's evalEnabled check, so enforce it here.
      if (!config.evalEnabled) throw new Error(`${readOnly ? "evalCheck" : "evalUntil"} needs page JS — ${EVAL_DISABLED}`);
      return call(RpcMethod.Eval, routePlaybackEvidence(planId, RpcMethod.Eval, { code, readOnly }, page) as unknown as RpcContracts[typeof RpcMethod.Eval]["params"]);
    },
    setNetworkCapture: (planId, enabled, page) => call(RpcMethod.SetNetworkCapture, routePlaybackEvidence(planId, RpcMethod.SetNetworkCapture, { enabled }, page) as unknown as RpcContracts[typeof RpcMethod.SetNetworkCapture]["params"]).then(() => undefined),
    networkBodies: (planId, sinceSeq, page) => {
      // The bodies of the tab this plan works in, in this session's browser. A live plan has no playback context,
      // and with no tab the store hands back every tab's, every browser's and every session's bodies — another
      // session's success then confirmed this one's save.
      const tgt = resolvedTarget();
      const tab = playbackContexts.get(planId)?.currentTabId(page)
        ?? claimFor(tgt)
        ?? (lastRead && lastRead.instanceId === tgt?.instanceId ? lastRead.tabId : undefined);
      const { events: evs, maxSeq } = events.since(sinceSeq, tab);
      const sees = sessionSees();
      const bodies = evs
        .filter((e) => e.kind === "network_body" && sees(e))
        .map((e) => {
          const d = (e.detail ?? {}) as { url?: string; status?: number; body?: string };
          return { url: String(d.url ?? ""), status: Number(d.status ?? 0), body: String(d.body ?? "") };
        });
      return { bodies, maxSeq };
    },
    screenshot: (planId, page) => call(RpcMethod.Screenshot, routePlaybackEvidence(planId, RpcMethod.Screenshot, {}, page)),
    targetAvailable: (planId, page) => playbackContexts.get(planId)?.targetAvailable(page) ?? true,
    waitSignal: (planId, page, condition, timeoutMs) =>
      call(RpcMethod.WaitSignal, routePlaybackEvidence(planId, RpcMethod.WaitSignal, { condition, timeoutMs }, page) as unknown as RpcContracts[typeof RpcMethod.WaitSignal]["params"]),
  });
  planRunner = runner;

  registerPlanTools({ server, runner });
  registerPlaybookTools({
    server, call, events, runner, deliverySink,
    resolvedTarget, claimFor, setClaimed, getClaimed: () => claimed,
    playbackContexts, playbackParams,
  });

  return server;
}
