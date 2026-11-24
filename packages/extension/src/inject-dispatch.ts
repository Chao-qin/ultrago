/**
 * Running one DOM op in the page, and deciding what its disappearance means.
 *
 * The hard part is not the injection — it is the navigation barrier around it.
 * An interaction can navigate, and if the response comes back while the old
 * document is tearing down, the NEXT rpc races the new one; that is exactly
 * where "DOM target frame is gone" came from.
 *
 * Three things are deliberately NOT used as evidence that the action landed:
 *   - The announcement alone. A cancelled navigation announces too.
 *   - url-before vs url-after. A reload, or a POST back to the same address,
 *     navigates WITHOUT changing the url; reading that as "did not navigate"
 *     turned a submit which HAD landed into a reported failure — and the way an
 *     agent answers a failed submit is by submitting a second time.
 *   - `tab.status`. It is a WHOLE-TAB property any actor can set, so another
 *     session navigating this shared tab makes it read "loading" too. It may
 *     only cause us to WAIT; it can never be evidence that OUR action succeeded.
 *
 * What remains is the frame-scoped commit. Only that turns "the injection
 * vanished" into the OUTCOME of the action rather than an unrelated failure —
 * and unrelated failures must fail closed, because Click/Type are MUTATING and
 * a wrong success gets cached and replayed on every resend of that RPC id.
 *
 * Split out of background.ts so those decisions can be asserted against fake
 * scripting/webNavigation APIs.
 */
import { isPageAction, type ActionDelta, type RpcErrorInfo, type RpcMethod } from "@bcp/shared";
import { domOpError } from "./rpc-errors";
import { mergeFrameReads, mergeFrameSnapshots } from "./snapshot-merge";

export interface InjectionResultLike {
    frameId: number;
    result?: unknown;
}

type NavListener = (d: { tabId: number; frameId: number; url: string }) => void;
type TabCreatedListener = (t: { id?: number; openerTabId?: number; pendingUrl?: string; url?: string }) => void;
type PageDialog = NonNullable<ActionDelta["pageDialogs"]>[number];

export interface InjectDeps {
    scripting: { executeScript(o: unknown): Promise<InjectionResultLike[]> };
    webNavigation: {
      onBeforeNavigate: { addListener(l: NavListener): void; removeListener(l: NavListener): void };
      onCommitted: { addListener(l: NavListener): void; removeListener(l: NavListener): void };
    };
    tabs: { get(tabId: number): Promise<{ status?: string }> };
    /** Tabs created while an action runs — the ones this tab opened are part of what the action did. */
    tabCreated?: { addListener(l: TabCreatedListener): void; removeListener(l: TabCreatedListener): void };
    resolveTab(tabId?: number): Promise<{ id?: number }>;
    /** Readiness before a read; falls through instantly when the view is unknown. */
    waitNetworkIdle(tabId: number): Promise<void>;
    waitTabComplete(tabId: number, timeoutMs: number, ignoreCurrentStatus: boolean): Promise<void>;
    liveFrames(tabId: number): Promise<{ ids: number[]; listing: string } | null>;
    /** "Install on perceive" — fire-and-forget, never blocks the snapshot. */
    injectEventProbes(tabId: number): void;
    isMutating(method: RpcMethod): boolean;
    /** The self-contained functions serialised into the page. */
    runtime: { dom: unknown; dialogShim: unknown; dialogRestore: unknown };
    /** RpcMethod -> the injected runtime's op name. */
    domOp: Partial<Record<RpcMethod, string>>;
    barrierMs?: number;
}

/** The RPC params minus the routing fields the dispatcher consumes itself. */
function withoutRouting(params: unknown): Record<string, unknown> {
  const { tabId: _tab, ...rest } = (params ?? {}) as Record<string, unknown>;
  return rest;
}

export function createInjectDispatch(deps: InjectDeps) {
    const {
      scripting, webNavigation, tabs, resolveTab, waitNetworkIdle, waitTabComplete,
      liveFrames, injectEventProbes, isMutating, runtime,
    } = deps;
    const DOM_OP = deps.domOp;
    const NAV_BARRIER_TIMEOUT_MS = deps.barrierMs ?? 15000;

  async function dispatch(method: RpcMethod, params: unknown): Promise<unknown> {
    const op = DOM_OP[method];
    if (!op) throw new Error(`no DOM op for ${method}`);
    const p = params as {
      tabId?: number; ref?: string; text?: string; submit?: boolean; maxChars?: number; offset?: number; full?: boolean; ms?: number;
      humanize?: boolean; values?: string[]; key?: string; deltaY?: number; toBottom?: boolean;
      selector?: string; state?: "visible" | "hidden"; confirm?: boolean;
      toRef?: string; dragMethod?: "html5" | "pointer"; filename?: string; mimeType?: string; dataBase64?: string; dataBase64s?: string[];
      exact?: boolean; nth?: number;
      role?: string; name?: string; css?: string; near?: string; x?: number; y?: number;
    };
    const tabId = (await resolveTab(p.tabId)).id!;

    // A read should see settled data. Network idle answers "has the data
    // arrived" far better than DOM quiescence can — falls through instantly when
    // the in-flight view is unknown, leaving settleDom as the fallback.
    if (op === "snapshot" || op === "read") await waitNetworkIdle(tabId);

    // Snapshot pierces iframes: inject into ALL frames, merge, and prefix sub-frame
    // refs with their frameId ("42_e3") so click/type/etc. can route back to that frame.
    if (op === "snapshot") {
      const results = await scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "ISOLATED",
        func: runtime.dom as never,
        // Forward what the caller sent (minus routing): a hand-built argument list silently drops every field
        // added later, which is how drag's method never reached the page.
        args: ["snapshot", withoutRouting(params)],
      });
      // "Install on perceive": a snapshot also (re)installs resident page-event
      // probes. Fire-and-forget so it never blocks or fails the snapshot itself.
      void injectEventProbes(tabId);
      return mergeFrameSnapshots(tabId, results);
    }

    // A whole-page read covers every frame, as the snapshot does — verification reads the page through it, and a
    // message shown inside an iframe was invisible to textPresent / textAbsent. A paged read stays in the top frame.
    if (op === "read" && p.full) {
      const results = await scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "ISOLATED",
        func: runtime.dom as never,
        args: ["read", withoutRouting(params)],
      });
      const topError = (results.find((r) => r.frameId === 0)?.result as { error?: string; errorInfo?: RpcErrorInfo } | undefined);
      if (topError?.error) throw domOpError(topError);
      const merged = mergeFrameReads(results);
      if (!merged) throw new Error(`read: the top frame of tab ${tabId} returned no result — take a snapshot to see what the tab holds now.`);
      return { ...merged, tabId };
    }

    // Route a ref-bearing op to the frame its ref came from ("42_e3" -> frame 42, ref "e3").
    const stripFrame = (r: string): { frameId: number; ref: string } => {
      if (/^\d+_/.test(r)) {
        const i = r.indexOf("_");
        return { frameId: Number(r.slice(0, i)), ref: r.slice(i + 1) };
      }
      return { frameId: 0, ref: r };
    };
    let frameId = 0;
    let ref = p.ref;
    if (ref) ({ frameId, ref } = stripFrame(ref));
    // drag's second ref must resolve in the SAME frame as the first (cross-frame DnD unsupported). Refs are only
    // unique within a frame, so a different frame's "e2" looked up here would name some other element.
    let toRef: string | undefined;
    if (p.toRef) {
      const to = stripFrame(p.toRef);
      if (to.frameId !== frameId) throw new Error(`drag: "${p.ref}" and "${p.toRef}" are in different frames — both ends must be in the same frame`);
      toRef = to.ref;
    }
    // Dialog handling: a page confirm()/alert() fired from a click handler would block
    // our synthetic dispatch. Install a MAIN-world shim tied to the caller's confirm
    // intent (fail-safe cancel by default), and restore native dialogs afterwards.
    // Every in-page action gets this and the navigation barrier below — a double
    // click, a paste or a drag navigates and opens dialogs as readily as a click.
    const interaction = isPageAction(method);
    if (interaction) {
      try {
        await scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: "MAIN", func: runtime.dialogShim as never, args: [!!p.confirm] });
      } catch {
        /* non-scriptable frame */
      }
    }
    // Navigation barrier. An interaction can navigate; if it does, the response
    // must not come back while the old document is tearing down, or the NEXT rpc
    // races the new one — that is exactly where "DOM target frame is gone" comes
    // from. Announced-navigation is watched rather than polled, so this costs
    // nothing when nothing navigates. (Playwright's SignalBarrier, minus CDP.)
    let navAnnounced = false;
    /** Whether the navigation was announced by the time the injection returned — the part attributable to us. */
    let navAnnouncedAtReturn = false;
    // The url the browser COMMITTED in this frame, if it navigated. Announcement
    // alone cannot be the evidence (a cancelled navigation announces too), and
    // neither can url-before vs url-after: a reload, or a POST back to the same
    // address, navigates WITHOUT changing the url — see the barrier below.
    let navCommittedUrl: string | undefined;
    const onBeforeNav = (d: { tabId: number; frameId: number }) => {
      if (d.tabId === tabId && d.frameId === frameId) navAnnounced = true;
    };
    const onCommitNav = (d: { tabId: number; frameId: number; url: string }) => {
      if (d.tabId === tabId && d.frameId === frameId) navCommittedUrl = d.url;
    };
    // Tabs this tab opens while the action runs (target=_blank, window.open).
    const tabsOpened: { tabId: number; url?: string }[] = [];
    const onTabCreated: TabCreatedListener = (t) => {
      if (t.openerTabId === tabId && t.id != null) tabsOpened.push({ tabId: t.id, url: t.pendingUrl || t.url || undefined });
    };
    if (interaction) {
      webNavigation.onBeforeNavigate.addListener(onBeforeNav);
      webNavigation.onCommitted.addListener(onCommitNav);
      deps.tabCreated?.addListener(onTabCreated);
    }
    let pageDialogs: PageDialog[] = [];

    let res: InjectionResultLike | undefined;
    let execErr: unknown;
    try {
      [res] = await scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        world: "ISOLATED",
        func: runtime.dom as never,
        // Every field the caller sent reaches the runtime; only the frame-prefixed refs are rewritten for the
        // frame they route to. A whitelist here silently dropped any field added later (drag's method did).
        args: [op, { ...withoutRouting(params), ref, toRef, waitText: p.text }],
      });
    } catch (e) {
      // Don't rethrow yet: if the frame went away because the action NAVIGATED,
      // that is the outcome, not a failure. Decided below.
      execErr = e;
    } finally {
      if (interaction) {
        // Awaited: what it hands back (the dialogs the page opened) is part of the reply. A frame that navigated
        // away has nothing to restore, and nothing to report from the old document.
        const restored = await scripting
          .executeScript({ target: { tabId, frameIds: [frameId] }, world: "MAIN", func: runtime.dialogRestore as never })
          .catch(() => undefined);
        const seen = restored?.[0]?.result;
        if (Array.isArray(seen)) pageDialogs = seen as PageDialog[];
      }
    }

    if (interaction) {
      // Yield once: a navigation the action just kicked off is announced
      // asynchronously relative to the injection returning.
      await new Promise((r) => setTimeout(r, 0));
      // Snapshot the announce NOW. Keeping the listeners alive through the barrier
      // below is required to SEE the commit, but it also means a redirect the page
      // starts seconds later would otherwise be credited to this action. What was
      // announced by the time the injection returned is the part attributable to us.
      const announcedDuringAction = navAnnounced;
      navAnnouncedAtReturn = announcedDuringAction;
      // `tab.status` is a WHOLE-TAB property that any actor can set — another
      // session navigating this shared tab makes it read "loading" too. It may
      // therefore only cause us to WAIT; it must never be evidence that OUR action
      // succeeded. Only the frame-scoped listeners can be that.
      const mightBeNavigating =
        announcedDuringAction || (await tabs.get(tabId).catch(() => undefined))?.status === "loading";
      if (mightBeNavigating) await waitTabComplete(tabId, NAV_BARRIER_TIMEOUT_MS, announcedDuringAction);
      // Unregister only now: the commit for a navigation announced during the
      // injection arrives WHILE the barrier waits, not before it starts. The old
      // code removed the listener first, so that evidence was unobservable by
      // construction.
      webNavigation.onBeforeNavigate.removeListener(onBeforeNav);
      webNavigation.onCommitted.removeListener(onCommitNav);
      deps.tabCreated?.removeListener(onTabCreated);
      // Synthesize a success only when a NEW DOCUMENT actually took over THIS frame.
      // A url diff cannot be that test: a reload, or a POST back to the same address,
      // navigates WITHOUT changing the url — read as "did not navigate", that turned
      // a submit which had LANDED into a reported failure, and the way an agent
      // answers a failed submit is by submitting a second time. The commit is what
      // makes "the injection vanished" the OUTCOME of the action rather than an
      // unrelated failure (frame removed by the page, chrome-error://, "cannot
      // access contents") that has to fail closed: Click/Type are MUTATING, so a
      // wrong success is cached by persistResult and replayed on every resend of
      // this RPC id.
      if ((execErr || !res) && announcedDuringAction && navCommittedUrl) {
        return { ok: true, delta: observed({}), tabId };
      }
    }

    if (execErr) throw execErr;
    if (!res) {
      // Was a dead end: "the page navigated?" named a possible cause and left the
      // agent nowhere to go. What it needs is which frames the tab has NOW — a
      // missing one invalidates every ref carrying its prefix (snapshot again), a
      // present one means the document was swapped mid-call.
      const live = await liveFrames(tabId);
      if (!live)
        throw new Error(`${op}: tab ${tabId} no longer exists. Call list_windows to pick another tab, or new_tab to open one.`);
      const gone = !live.ids.includes(frameId);
      throw new Error(
        `${op}: frame ${frameId} of tab ${tabId} returned no result. Frames live now:\n${live.listing}\n` +
          (gone
            ? `That frame is gone, so every ref prefixed "${frameId}_" is dead — take a snapshot for current refs.`
            : `That frame exists, so its document was replaced while this call was in flight — take a snapshot for current refs.`) +
          (isMutating(method)
            ? ` This ${op} may already have landed: read page_state and compare before repeating it, or you will do it twice.`
            : ` Then repeat this ${op}.`),
      );
    }
    const r = res.result as
      | { value?: unknown; error?: string; errorInfo?: RpcErrorInfo; resolved?: Record<string, string> }
      | undefined;
    if (r?.error) throw domOpError(r);
    // `resolved` rides alongside the op's own result rather than in a new
    // protocol field: the alternative is widening RpcResponseMessage, which
    // means widening what `p.resolve()` hands back — and that is every RPC
    // caller's return type, for a fact only replay cares about. It sits next to
    // `delta`, which is metadata of the same kind.
    // `tabId` rides along the same way: it is the tab this op actually ran in
    // — the one resolveTab picked when the caller sent none — so the backend
    // can tell which tab a reply is about without guessing.
    const v = r?.value;
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const own = (v as { delta?: ActionDelta }).delta;
    const seen = interaction ? observed(own ?? {}) : undefined;
    const withDelta = seen && (own || Object.keys(seen).length) ? { ...v, delta: seen } : v;
    return { ...withDelta, ...(r?.resolved ? { resolved: r.resolved } : {}), tabId: (v as { tabId?: number }).tabId ?? tabId };

    /** What the browser saw this action do, folded into what the page reported. The commit is authoritative over
     *  the runtime's own url check: the runtime reads location ~50ms after the event, before a link's or a
     *  submit's new document has committed, so it reports no navigation for most of them. */
    function observed(delta: ActionDelta): ActionDelta {
      const out: ActionDelta = { ...delta };
      if (navAnnouncedAtReturn && navCommittedUrl) out.urlChanged = navCommittedUrl;
      if (pageDialogs.length) out.pageDialogs = pageDialogs;
      if (tabsOpened.length) out.tabsOpened = tabsOpened;
      return out;
    }
}

    return dispatch;
}
