/**
 * Wire protocol shared by the backend (Node) and the extension (Chrome).
 *
 * A single WebSocket carries one logical channel between the extension's
 * service worker and the backend: backend-initiated browser tool calls
 * (RPC request/response). The extension is a pure browser executor — the agent
 * lives in whatever MCP client drives the backend's /mcp endpoint, not here.
 *
 * This module is the Single Source of Truth for every message shape. It is
 * a types-only + constants module: safe to import from both a browser bundle
 * and a Node process (no runtime deps).
 */

/** v2: NewTab.active / SwitchTab.focusWindow / TabInfo.windowId carry the
 * manual-mode and foreground-lease safety guarantees — an extension that
 * silently ignores them would break "never touch the user's view", so the
 * mismatch must fail closed (old extensions are rejected, not degraded).
 *
 * v3: SetNetworkCapture returns { enabled, armedFrames } instead of
 * { ok, enabled }. An un-reloaded v2 extension sends no armedFrames, which the
 * new renderer would read as zero and report a working capture as "could not be
 * enabled" — a fresh lie of exactly the kind this change removes. Rejecting the
 * stale extension is the whole point of the version being checked.
 *
 * v4: GoBack/GoForward/Reload return HistoryNavResult and Download returns a
 * terminal `state`. A v3 extension sends neither, so `navigated` reads as
 * undefined and every history move would be reported as "nothing committed" —
 * the same class of fresh lie v3 was cut for.
 *
 * v5: Instance-identity handshake. hello carries `browser` + `instanceId` +
 * `clientInfo.artifactHash`; welcome echoes the target + protocolVersion; the
 * extension then sends `ready`, and only THEN does the backend treat the
 * session as authenticated/connected. A v4 extension sends no instanceId and
 * no ready — it would be treated as connected on hello alone, which the
 * readiness gate (dispatch → ensureBrowserReady → probe) would silently route
 * around. The mismatch must fail closed: old extensions are rejected with
 * protocol_incompatible.
 *
 * v6: Book v2 signal gates add `browser.waitSignal` (event-driven condition
 * waits in one tab). Every saved playbook is now schemaVersion 2, so an older
 * extension without waitSignal would pass the handshake and then fail every
 * book run midway with an obscure "unhandled RPC method" — the same class of
 * stale-extension lie this version check exists to reject. The mismatch must
 * fail closed: old extensions are rejected at the handshake.
 *
 * v7: `browser.eval` now injects `bcpWait` (waiting primitives built by
 * bcpWaitFactory in the extension's dom-runtime). Books call it directly —
 * `await bcpWait.until(...)` — so an extension built before it exists passes
 * the handshake, runs, and then dies inside eval with a bare
 * "bcpWait is not defined", possibly swallowed by the book's own try/catch.
 * The RPC shape did not change, so nothing else could have caught this: the
 * capability lives entirely inside the injected function. Same class of
 * stale-extension lie as v6, so the same answer — reject at the handshake.
 *
 * v8: `browser.eval` now also injects `bcpDom` (DOM primitives built by
 * bcpDomHelpersFactory — `visible` / `innermost` / `press`). Exactly the v7
 * situation: books call `bcpDom.visible(el)` directly, the RPC shape is
 * unchanged, and an older extension would pass the handshake and then die
 * inside eval with "bcpDom is not defined" — swallowed by the book's own
 * try/catch, which is how a step reports a clean `{ok:false, reason:...}` for
 * something that was never about the page at all.
 *
 * The same bump also carries a SEMANTIC change with no new RPC either: what
 * counts as a visible element. Seven copies of that predicate disagreed on up
 * to 10 of the 22 ways CSS/HTML can hide something; they now all answer what
 * `checkVisibility()` answers. A stale extension would keep reporting the old
 * verdicts — `content-visibility` and closed `<details>` read as visible,
 * `opacity:0` read as hidden — through snapshot `[hidden]` flags and locator
 * misses that look like ordinary "element not found". Nothing in the wire
 * format would reveal it, so the handshake is again the only place to catch
 * it.
 *
 * v9: `bcpDom` is now injected into signal `script` leaves too, not only into
 * `browser.eval`. v8 converted the books' hand-copied visibility predicates to
 * `bcpDom.visible` everywhere — including inside signal conditions, which are
 * evaluated by a DIFFERENT injected function (bcpSignalWait) that handed them
 * nothing. Six gates in doudian-publish-canonical went permanently `blocked:
 * bcpDom is not defined`; the book had passed 33/33 an hour earlier. Third time
 * for the same shape — a capability that lives inside an injected function,
 * an unchanged RPC shape, and a stale extension that would pass the handshake
 * and then fail only on the pages that use it — so the same answer: reject at
 * the handshake.
 *
 * v10: `bcpDom` gains `setValue` / `setFiles`. Same shape as v7/v8/v9 — a
 * capability that lives inside the injected function, an unchanged RPC shape —
 * with one difference worth naming: a stale extension fails here as
 * `bcpDom.setFiles is not a function`, INSIDE a book's own try/catch, on the
 * step that uploads a CSV to a live shop. That reads as "抖店 rejected the
 * file", not as "your extension is old". Reject at the handshake. */
export const PROTOCOL_VERSION = 10;
export const DEFAULT_PORT = 8787;

/** JSON-compatible value used by cross-package event contracts. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Client role announced during the handshake. */
export type ClientRole = "extension";

import { RpcMethod, LocalMethod } from "./methods.js";
import { EVAL_TIMEOUT_MS } from "./limits.js";
import type { BookParamSchema } from "./generated/schema.js";
import type { Delivery } from "./deliveries.js";
import type { BrowserKind } from "./browser-lifecycle.js";
import type { SignalCondition, SignalGate, BookPageDefinition } from "./book-signals.js";
export { RpcMethod, LocalMethod } from "./methods.js";

/* ------------------------------------------------------------------ *
 * Browser RPC surface — the methods Claude can invoke via MCP tools.  *
 * Keep this list == the tools registered in backend/browser-mcp.ts.   *
 * (Defined in methods.ts — a leaf module so codegen/mcp-instructions  *
 *  can import it without a module cycle.)                             *
 * ------------------------------------------------------------------ */

/** Optional target tab for an operation; omitted = the active tab. Lets a task
 * pin every action to its own (possibly background) tab/window. */
interface TabTarget {
  tabId?: number;
}

/** How an action names its target: either a `ref` minted by the latest snapshot,
 * or a DESCRIPTION resolved at action time.
 *
 * A ref names the element as it was when the snapshot was taken — after a
 * re-render, a portal or a virtual list recycling its rows it is stale, and the
 * agent must re-snapshot only to name the thing again. A description survives
 * all of that, which is the main reason Playwright's locators feel seamless.
 *
 * Deliberately not accessibility-centric: `role` is one filter among several,
 * while `text` and `css` need no ARIA at all. Filters combine with AND.
 * Resolution is STRICT — several matches is an error listing the candidates,
 * because silently taking the first is how the wrong row gets clicked. */
export interface Locator {
  /** Ref from the latest snapshot. Takes precedence over every field below. */
  ref?: string;
  /** Visible text of the element; matches the innermost element containing it. */
  text?: string;
  /** ARIA role, explicit or implicit (a <button> is "button" without markup). */
  role?: string;
  /** Accessible name — aria-label, associated <label>, placeholder, alt, title. */
  name?: string;
  /** Raw CSS selector, for markup carrying no usable semantics at all. */
  css?: string;
  /** Disambiguate by proximity: keep only candidates within ~200px of the
   *  nearest element whose text matches this, closest first. */
  near?: string;
  /** Viewport coordinates, typically read off a screenshot. Resolves to whatever
   *  is actually painted at that point, then climbs to its nearest interactive
   *  ancestor so the risk gate and the accessible name apply to the real control
   *  rather than to a decorative glyph inside it.
   *
   *  This is the bridge from SEEING to ACTING: an agent can recognise a control
   *  in a screenshot long before the snapshot can name it — icon-only toolbars,
   *  canvas hot-spots, custom-drawn widgets. Without coordinates that recognition
   *  had nowhere to go. Pair with SnapshotElement.rect for the reverse direction. */
  x?: number;
  y?: number;
  /** Match `text`/`name` exactly rather than as a substring. */
  exact?: boolean;
  /** 0-based pick among matches, ordered by document position (or by distance
   *  when `near` is used). The explicit escape hatch from strictness. */
  nth?: number;
}

/** pick_option: open a custom dropdown via its trigger, then choose the option
 *  whose visible text matches. The trigger is located like any element. */
export interface PickOptionParams extends Locator {
  /** Visible text of the option to choose (exact match preferred, then substring). */
  option: string;
  tabId?: number;
}

/** Hard cap on one uploaded file, enforced everywhere bytes enter the system
 * (backend URL/localPath resolution, console attachment uploads). */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export { EVAL_TIMEOUT_MS, WAIT_FOR_DEFAULT_MS, WAIT_FOR_MAX_MS, NETWORK_LOG_PER_TAB, READ_DUMP_TTL_MS } from "./limits.js";

/** The deadline handed to evaluated code as `bcpDeadline` (an absolute epoch
 * ms, computed at injection time). Deliberately below EVAL_TIMEOUT_MS: a loop
 * checks its stop BEFORE the last sleep, so it can overshoot by one poll
 * interval, and the result still has to serialize afterwards.
 *
 * This exists so a book never restates a budget. Book code writes
 * `const DL = bcpDeadline;` — no literal to drift from the cap above.
 * `scripts/check-books.mjs` reads this constant instead of recomputing it. */
export const EVAL_SAFE_BUDGET_MS = Math.round(EVAL_TIMEOUT_MS * 0.8);

/** Declarative file source accepted by a playbook. The backend resolves it to
 * bytes before the extension receives an upload RPC. */
export interface UploadSource {
  url?: string;
  localPath?: string;
  filename?: string;
  mimeType?: string;
}

/** Param/result shapes per RPC method. Executors + tools both reference these. */
/** History navigation reports whether a document actually COMMITTED, not whether
 *  the API call was accepted. `tabs.goBack()` resolves as soon as Chrome takes
 *  the request — at the end of history, or when a beforeunload handler cancels
 *  the move, it resolves exactly the same way, and the old `{ ok: true }` said
 *  "done" to a navigation that never happened. */
export type HistoryNavResult = {
  ok: true;
  /** True only when a real document commit was observed for this tab. */
  navigated: boolean;
  url?: string;
  title?: string;
  /** Chrome's transitionType for the commit ("reload", "back_forward", …). */
  transition?: string;
};

export interface RpcContracts {
  [RpcMethod.Navigate]: {
    params: TabTarget & { url: string };
    result: { tabId: number; url: string; title: string };
  };
  [RpcMethod.NewTab]: {
    /** active=false opens the tab in the background — the user's current view
     * is untouched. Default false so opening a tab never steals the user's view. */
    params: { url?: string; active?: boolean };
    result: { tabId: number; url: string };
  };
  [RpcMethod.CloseTab]: {
    params: { tabId?: number };
    /** `tabId` = the tab actually closed, so a defaulted close can say which. */
    result: { closed: true; tabId: number };
  };
  [RpcMethod.NewWindow]: {
    /** focused defaults to false so the task window doesn't steal foreground.
     * minimized optionally hides the task window after creation — but note a
     * MINIMIZED window stops rendering entirely (Chrome drops its compositor),
     * and pages whose send path rides the render pipeline (doubao's composer)
     * stop accepting input there. Off-screen bounds don't buy real invisibility
     * either: Chrome refuses window bounds that leave less than ~50% of the
     * window's area within the display (an anti-abuse guard, not a config gap —
     * a fully off-screen "normal" window would otherwise be a fully-interactive
     * window a user can never see, i.e. free clickjacking infrastructure), so
     * some of it always shows. restoreFocus is what actually keeps the task
     * window out of the user's way: it snapshots whichever window has OS focus
     * right before this create, then re-raises THAT window afterward — the new
     * window still opens normal/rendering, just behind, not merely unfocused
     * (2026-08-21: focused:false alone does not reliably stop the new window
     * from front-and-center stealing the OS foreground on this platform). */
    params: {
      url?: string;
      focused?: boolean;
      minimized?: boolean;
      left?: number;
      top?: number;
      width?: number;
      height?: number;
      restoreFocus?: boolean;
    };
    /** bounds = where the window ACTUALLY landed. Chrome may clamp off-screen
     * coordinates back onto a display, and the caller can only tell by reading
     * this back rather than by trusting what it asked for. */
    result: { windowId: number; tabId: number; url: string; bounds?: { left?: number; top?: number; width?: number; height?: number; state?: string } };
  };
  [RpcMethod.CloseWindow]: {
    params: { windowId?: number };
    /** `windowId` = the window actually closed. */
    result: { closed: true; windowId: number };
  };
  [RpcMethod.SetWindowState]: {
    /** Toggle a task window's state mid-run, e.g. minimize it once its
     * interactive part (typing/submit) is done and only a rendering-independent
     * wait/poll is left — normal while you need input to land, minimized once
     * you don't, without recreating the window. tabId defaults to the claimed
     * tab, same as other TAB_SCOPED methods. */
    params: TabTarget & { minimized: boolean };
    result: { windowId: number; state: string };
  };
  [RpcMethod.ListTabs]: {
    params: Record<string, never>;
    result: { tabs: TabInfo[] };
  };
  [RpcMethod.Screenshot]: {
    /** activate: the caller allows bringing a window Chrome cannot read back in the background to the front
     *  for one retry. Only an agent's own screenshot in auto mode passes it; webhook and evidence captures do not. */
    params: TabTarget & { compress?: boolean; activate?: boolean };
    /** PNG by default; compress produces a JPEG with longest edge <= 1280px.
     * warning is set when
     * the requested tab is NOT its window's active tab — captureVisibleTab can
     * only shoot the visible one, so the image shows a different page.
     * activated is set when Chrome could not read the window back in the background, so it was brought
     * forward for one retry and the previously focused window restored. keptInFront: no window of this
     * browser had focus before, so focus could not be handed back and the captured window stays in front. */
    result: { dataUrl: string; warning?: string; activated?: boolean; keptInFront?: boolean };
  };
  [RpcMethod.Snapshot]: {
    /** deltaKey scopes `changed` to the observer exactly as page_state's does; the backend fills it for the
     *  agent's own reads, and a backend-internal read leaves it out so it never moves the agent's baseline. */
    params: TabTarget & { deltaKey?: string; resetDelta?: boolean };
    /** Compact interactable-element tree with stable refs for this snapshot.
     * `moreBelow` flags that the page can still scroll down (content below the
     * fold / lazy-loaded) so the agent knows to scroll rather than assume it saw all. */
    /** `changed` = what moved since the SAME observer's previous snapshot of this
     *  tab. Refs are reused for elements that survive, so `added` names exactly
     *  the controls that are new — the caller can go straight to them instead of
     *  re-reading a page it has already read. Absent on the first snapshot. */
    /** tabId: the tab actually read — with no tabId given, that is whichever tab was active at that moment. */
    result: {
      tabId: number; url: string; title: string; elements: SnapshotElement[]; moreBelow: boolean;
      changed?: { added: string[]; removed: number };
    };
  };
  [RpcMethod.Click]: {
    /** humanize defaults to FALSE for click/type: the events are synthetic
     *  (isTrusted:false) either way, so the jitter buys no cover while costing
     *  150-350ms a click. Pass true when a human is watching. NOTE scroll is the
     *  exception — it still defaults to true, because there the pacing is
     *  functional (it drives lazy-load), not disguise. */
    params: TabTarget & Locator & { humanize?: boolean; confirm?: boolean; ms?: number };
    result: { ok: true; delta?: ActionDelta };
  };
  [RpcMethod.Type]: {
    /** `text` is the value to type, so unlike click it cannot double as a
     *  locator — describe the field by name/role/css/near instead.
     *  `x`/`y` are excluded too: this op resolves through the description path
     *  only, and declaring coordinates it silently ignores made the contract
     *  itself the liar (a caller passing them got "nothing matches (no criteria)"). */
    params: TabTarget & Omit<Locator, "text" | "x" | "y"> & {
      text: string; submit?: boolean; humanize?: boolean; confirm?: boolean;
    };
    result: { ok: true; delta?: ActionDelta };
  };
  [RpcMethod.ReadContent]: {
    /** Rendered visible text is read in exact, lossless chunks. The default
     * chunk is intentionally large enough for most pages; callers can use
     * `nextOffset` to continue without guessing from a marker in the text. */
    params: TabTarget & { maxChars?: number; offset?: number; full?: boolean };
    result: {
      url: string;
      title: string;
      text: string;
      /** Offset of this chunk in the normalized page text. */
      offset: number;
      /** Total length of the normalized page text. */
      totalChars: number;
      /** True when another chunk is available after this result. */
      truncated: boolean;
      /** Exact offset to pass to the next read, omitted for the final chunk. */
      nextOffset?: number;
      /** Compact structural context for callers that need to orient before reading chunks. */
      overview?: { headings: string[]; headingsTruncated?: boolean; excerpt: string };
    };
  };
  [RpcMethod.WaitFor]: {
    /** Wait until: text appears, OR a selector's element is visible/hidden, OR a fixed delay. */
    params: TabTarget & { text?: string; selector?: string; state?: "visible" | "hidden"; ms?: number };
    result: { matched: boolean };
  };
  [RpcMethod.WaitSignal]: {
    /** Event-driven wait for a declarative Book v2 signal condition in this tab:
     * evaluate immediately, re-check on observed DOM/page changes, and resolve
     * when the condition holds or the deadline expires. Runner-internal — used
     * by book gates, never recorded as a step action. The condition tree is
     * fully declarative; `script` leaves obey the backend BCP_EVAL gate. */
    params: TabTarget & {
      condition: SignalCondition;
      /** Absolute wait ceiling for this call (ms). */
      timeoutMs: number;
    };
    result: {
      /** True when the condition held before the deadline. */
      satisfied: boolean;
      /** True when the deadline expired unsatisfied. */
      timedOut?: boolean;
      /** Paths of the leaf conditions that were still failing, for diagnostics
       * (e.g. "all[0].urlIncludes"). Omitted when satisfied. */
      failedPaths?: string[];
      /** Fail-closed: a `script` leaf was blocked by policy or CSP (or the
       * condition tree was malformed). The wait stops immediately, not at the
       * deadline — re-evaluating a blocked script cannot make it unblocked. */
      blocked?: string;
      /** Last observed committed URL. */
      url?: string;
      /** Page-state summary at resolution, for timeout diagnostics. */
      pageState?: { readyState: string; loading: boolean; errorCount: number };
      /** Evidence returned by successful leaf conditions (selector matches,
       * text presence, script value). */
      evidence?: unknown;
    };
  };
  [RpcMethod.Eval]: {
    /** Runs in the page's MAIN world — an MV3 extension's CSP forbids eval/new Function
     *  in the isolated world, so page context is the only place arbitrary code can run.
     *  frameId targets a same-origin frame; omit for the top frame. */
    params: TabTarget & { code: string; frameId?: number };
    /** JSON-serializable return value of the evaluated expression (or null).
     *  truncated is set when the serialized result exceeded the size cap. */
    result: { value: unknown; truncated?: boolean };
  };
  [RpcMethod.Download]: {
    /** filename is relative to the browser's Downloads directory (chrome API limit). */
    params: { url: string; filename?: string };
    /** `state` is the download's TERMINAL state when one was reached inside the
     *  call's short wait ("complete" | "interrupted"), otherwise "in_progress".
     *  The old shape reported an id and nothing else, so a download that Chrome
     *  blocked, or that 404'd, was indistinguishable from one that succeeded. */
    result: { downloadId: number; filename: string; state: string; error?: string };
  };
  [RpcMethod.SwitchTab]: {
    /** Activate a tab. focusWindow=true (default) also raises/focuses its OS
     * window — "pull it in front of the user". focusWindow=false only makes
     * the tab active WITHIN its window (enough for captureVisibleTab) without
     * grabbing the user's screen or keyboard focus.
     *
     * restoringView=true marks a switch that GIVES THE VIEW BACK rather than
     * goes somewhere to work: the screenshot lease switches away from the
     * user's tab, shoots, and switches back, and that last hop must not paint
     * the automation badge on a tab nothing was done to. A third orthogonal
     * axis, same as focusWindow split "activate the tab" from "raise the
     * window" (learn.md 2026-08-12): switching TO a tab is not the same as
     * working IN it. */
    params: { tabId: number; focusWindow?: boolean; restoringView?: boolean };
    result: { tabId: number; windowId: number };
  };
  [RpcMethod.SelectOption]: {
    /** Match values against the <select>'s options by value or visible label. */
    params: TabTarget & { ref: string; values: string[] };
    result: { ok: true; selected: string[]; delta?: ActionDelta };
  };
  [RpcMethod.PressKey]: {
    /** key is a chord like "Enter", "Escape", "ArrowDown", "Control+a". Sent to
     * the ref (or the active element if omitted). */
    params: TabTarget & { key: string; ref?: string };
    result: { ok: true; delta?: ActionDelta };
  };
  [RpcMethod.GoBack]: { params: TabTarget; result: HistoryNavResult };
  [RpcMethod.GoForward]: { params: TabTarget; result: HistoryNavResult };
  [RpcMethod.Reload]: { params: TabTarget; result: HistoryNavResult };
  [RpcMethod.Scroll]: {
    /** Scroll a ref's scrollable ancestor, or the window by deltaY / to bottom.
     * humanize (default true) = scroll gradually (wheel ticks / smooth animation). */
    params: TabTarget & { ref?: string; deltaY?: number; toBottom?: boolean; humanize?: boolean };
    /** New scroll position + total height so the agent can tell if more loaded.
     * via "wheel" = no DOM-scrollable container existed (canvas-rendered grid);
     * a synthetic wheel event was dispatched instead and position is unknown.
     * target names what was scrolled (e.g. "window", "div.doc-body") so the
     * agent can spot a wrong-container pick and correct it with a ref. */
    /** The DOM branch reports `movedBy` — without a before-position, "scrolled
     *  800px" and "did not move at all" returned the same shape, which is how a
     *  scroll blocked by an onscroll handler reads as success.
     *  The wheel branch (canvas grids) cannot observe the container's own offset
     *  at all, so it reports neither position nor `moreBelow` — it reports
     *  `consumed`, i.e. whether anything called preventDefault on the wheel,
     *  which is the one real signal available there. The old shape filled those
     *  fields with 0/0/true, which read as measurements. */
    result:
      | { via: "dom"; scrollY: number; scrollHeight: number; movedBy: number; moreBelow: boolean; target: string }
      | { via: "wheel"; consumed: boolean; target: string };
  };
  [RpcMethod.Drag]: {
    /** HTML5 drag-and-drop from ref onto toRef. Synthetic DnD events — drives
     * JS drag-drop zones (sortable/kanban/drop-upload), NOT OS-level drag. */
    params: TabTarget & { ref: string; toRef: string; dragMethod?: "html5" | "pointer"; confirm?: boolean };
    result: { ok: true; delta?: ActionDelta };
  };
  [RpcMethod.Upload]: {
    /** Attach a file to a <input type=file> [ref] by building a File in-page and
     * setting input.files + dispatching change. No native file dialog (no CDP).
     * Bytes are fetched backend-side and passed as base64. Playbook actions may
     * instead pass `attachments` plus a stable CSS locator; the backend expands
     * those sources into this low-level shape before dispatch. */
    params: TabTarget & Pick<Locator, "ref" | "text" | "css" | "name" | "role" | "near" | "nth" | "exact"> & {
      filename?: string; mimeType?: string; dataBase64?: string; dataBase64s?: string[]; attachments?: UploadSource[]; batchUpload?: boolean;
      /** Upload `attachments` this many at a time instead of all at once. */
      batchSize?: number;
    };
    result: { ok: true; files: string[]; skipped?: boolean; delta?: ActionDelta };
  };
  [RpcMethod.Hover]: {
    /** Move the synthetic pointer over an element to reveal hover-only UI
     * (tooltips, mouseover menus). No click. Located like click. */
    params: TabTarget & Locator;
    result: { ok: true; delta?: ActionDelta };
  };
  [RpcMethod.ContextMenu]: {
    /** Right-click. A synthetic contextmenu cannot open Chrome's own menu — no
     *  extension API can — but a page with a CUSTOM context menu listens for
     *  exactly this event, and its preventDefault is the proof it handled it
     *  (surfaced as `defaultPrevented`). */
    params: TabTarget & Locator & { ms?: number };
    result: { ok: true; delta?: ActionDelta };
  };
  [RpcMethod.DblClick]: {
    /** Double-click. The second click carries detail:2 and dblclick follows it;
     *  two independent detail:1 clicks never fire a dblclick handler. */
    params: TabTarget & Locator & { ms?: number; confirm?: boolean };
    result: { ok: true; delta?: ActionDelta };
  };
  [RpcMethod.Paste]: {
    /** Paste text. A rich editor handles `paste` itself and preventDefaults; a
     *  plain field does not, and then the insertion is ours. Doing only one of
     *  the two is why a paste either did nothing or inserted twice. */
    params: TabTarget & Omit<Locator, "text" | "x" | "y"> & { text: string; ms?: number };
    result: { ok: true; delta?: ActionDelta };
  };
  [RpcMethod.ClickText]: {
    /** Fallback click when no [ref] exists: click the innermost visible element
     * whose text matches — reaches bespoke UI the snapshot didn't surface. */
    params: TabTarget & { text: string; exact?: boolean; nth?: number; confirm?: boolean };
    /** `candidates` = how many visible elements matched the text. click_text
     *  takes index 0 when several match; without this count the caller cannot
     *  tell "the only match" from "the first of nine rows". */
    result: { ok: true; matched: string; candidates: number; delta?: ActionDelta };
  };
  [RpcMethod.ReadNetwork]: {
    /** Recent XHR/fetch requests for the tab (metadata only — bodies arrive
     * separately as `network_body` events while capture is on), captured since
     * the service worker last woke. `tabId` is the tab actually read, so the
     * backend can pair those events with these requests. */
    params: TabTarget & { limit?: number };
    result: { tabId: number; requests: NetworkRequest[] };
  };
  [RpcMethod.SetNetworkCapture]: {
    /** Toggle MAIN-world fetch/XHR response-BODY capture for a tab. Off by
     * default (page stays un-patched → lower detectability). Captures requests
     * made AFTER enabling; bodies surface as `network_body` events. */
    params: TabTarget & { enabled: boolean };
    /** `armedFrames` is how many frames the MAIN-world patch actually reached.
     *  Zero with `enabled:true` means the page could not be patched at all
     *  (chrome://, the web store, a CSP that blocks injection) — the previous
     *  `ok:true` reported success there and left the agent waiting for bodies
     *  that could never arrive. */
    result: { enabled: boolean; armedFrames: number };
  };
  [RpcMethod.ListWindows]: {
    /** All browser windows with their tabs — the window-topology read that
     * list_tabs (flat) can't give: which windows exist, which is OS-focused,
     * and how tabs group by window. */
    params: Record<string, never>;
    /** lastFocusedWindowId: the window the user most recently used, even while no window of this browser has
     *  focus (focusedWindowId is then null). Absent from extensions before 0.1.7. */
    result: { windows: WindowInfo[]; focusedWindowId: number | null; lastFocusedWindowId?: number | null };
  };
  [RpcMethod.PageState]: {
    /** verbosity "summary" (default) = scalars + aggregate counts only;
     * "detail" adds dialog names, the error list, and the blocking form fields.
     * resetDelta only refreshes the change baseline without reporting `changed`
     * (use it on the first beat after you know the page changed, to avoid a
     * fresh page reading as a pile of changes).
     * deltaKey scopes the change baseline to the OBSERVER, not the tab: the
     * backend fills it with a per-MCP-session id so two sessions sharing a tab
     * each get their own "changed since I last looked" instead of clobbering a
     * shared baseline. Agents never set it. */
    params: TabTarget & { verbosity?: "summary" | "detail"; resetDelta?: boolean; deltaKey?: string };
    result: PageState;
  };
}

/** A CAPTCHA / bot-check / risk-control CANDIDATE observed on a page by DOM
 * heuristics. Its existence is the whole signal — there is no confidence
 * grading, because every DOM-derived verdict is an estimate (a video player's
 * background canvas plus its progress slider looks exactly like a slider
 * puzzle). It therefore never reaches the driving agent: it only feeds the
 * `captcha_appeared` / `captcha_cleared` events, whose consumer (the event
 * webhook) confirms it visually before anyone is told. */
export interface CaptchaSignal {
  /** The observations that fired, verbatim. */
  evidence: string[];
}

/** What changed on the page as a direct result of a mutating action, so the
 * agent can verify an outcome without a full re-snapshot. Fields are omitted
 * when nothing changed on that axis. Best-effort signal, not authoritative. */
export interface ActionDelta {
  /** New URL, set only when the action caused navigation. */
  urlChanged?: string;
  /** Net change in interactable-element count (positive = elements appeared,
   * e.g. a dropdown/panel opened or lazy content loaded). */
  elementDelta?: number;
  /** Count of dialogs/modals/alerts that newly appeared. */
  dialogsOpened?: number;
  /** Selector-agnostic interruption signals: the page became scroll-locked, or a
   * large fixed/absolute layer newly covers the viewport center — catches modals /
   * cookie or consent overlays that carry no ARIA role. */
  scrollLocked?: boolean;
  overlay?: boolean;
  /** Validation/error messages that appeared since just before the action. */
  newErrors?: string[];
  /** Total visible validation/error messages on the page now. */
  errorCount?: number;

  // ---- Evidence about the action ITSELF, not about the page ----
  // The caller is an agent: it cannot see the screen and does not remember its
  // own earlier calls. "ok, and nothing changed on six coarse axes" leaves it
  // unable to tell "the handler ran and flipped something" from "the event went
  // nowhere" — a real session read exactly that as "this control needs a trusted
  // gesture" when in truth it had simply clicked a toggle twice. Playwright never
  // needed these: its caller is a human script that already knows what it did,
  // and has a trace viewer to replay when it doesn't.

  /** Set when the event landed on a DESCENDANT of the requested element (the
   *  browser dispatches to whatever covers the point). Reassures the agent the
   *  click went somewhere sensible rather than onto an unrelated overlay. */
  dispatchedTo?: string;
  /** A handler ran and called preventDefault — proof the page reacted, even when
   *  nothing visible changed. */
  defaultPrevented?: boolean;
  /** State flips observed on the target or its near ancestors (aria-pressed /
   *  -expanded / -checked / -selected / class). This is what actually reveals a
   *  tab switch or a mode toggle, none of which move the six axes above. */
  stateChanged?: string[];
  /** Milliseconds since this same element was last acted on, when that was
   *  recent. A toggle clicked an even number of times is indistinguishable from
   *  a dead control unless the agent is told it already did this. */
  repeatedAfterMs?: number;
  /** Whether `form.requestSubmit()` was actually reached, for a type with
   *  `submit:true`. Present only when the runtime survived long enough to know:
   *  a submit that navigates tears the injection down, and the navigation
   *  barrier reports that case as `urlChanged` instead. So ABSENT means "not
   *  known", NOT "did not submit" — rendering absence as failure would tell the
   *  agent to retry a submit that in fact succeeded, i.e. submit it twice. */
  submitted?: boolean;
  /** Set when the field's value after typing differs from what was requested —
   *  an input mask or a `beforeinput` handler dropped characters silently. */
  valueMismatch?: { requested: string; actual: string };
  /** Set when the element's CENTRE was covered but another point on the same
   *  element was still exposed, and the action was taken there instead. The
   *  action did land on the requested element — this says the geometry was not
   *  what the caller would assume, which matters when the next step reasons
   *  about where things are. Never set when the cover is a real dialog: reaching
   *  around a modal would defeat what the page is trying to enforce. */
  recoveredVia?: string;
}

/** Currently-focused control, or {focused:false} when nothing has focus.
 * `ref` is valid only against the latest snapshot; `role`/`name` always are. */
export type PageFocus =
  | { focused: false }
  | {
      focused: true;
      ref?: string;
      tag: string;
      role: string;
      name: string;
      /** True for text inputs / textarea / contentEditable — where typing lands. */
      isTextEntry: boolean;
      /** Caret / selection offsets on text controls (omitted where unsupported). */
      selectionStart?: number;
      selectionEnd?: number;
      valueLength?: number;
      /** Focus is inside a (same-origin) sub-frame — activeElement is the <iframe>;
       * the inner control's ref/selection isn't reachable in this top-frame read. */
      inIframe?: boolean;
      /** Focus was pierced into an open shadow root (the reported control is the
       * real inner one, not its web-component host). */
      inShadow?: boolean;
    };

/** A form control that currently blocks submission (detail verbosity only). */
export interface FormBlocker {
  ref?: string;
  name: string;
  reason: "required-empty" | "invalid";
  /** The browser's validationMessage, when the control is :invalid. */
  message?: string;
}

/** A coherent, single-injection snapshot of a tab's STATE (not its element
 * tree — take a `snapshot` for [ref]s). Every DOM field is captured in one
 * atomic pass so nothing drifts between them; `tabId`/`windowId`/`active` are
 * stamped by the service worker. Reuses the same interruption signals as
 * ActionDelta so `changed` speaks a vocabulary the agent already knows. */
export interface PageState {
  url: string;
  title: string;
  readyState: DocumentReadyState;
  /** Still loading / not yet hydrated: readyState≠complete OR body has no text
   * after the settle gate (an SPA shell before its framework renders). */
  loading: boolean;
  /** Interactable-element count (top frame, SNAP_SELECTOR) — a cheap "how much
   * is on this page" gauge. Lower than snapshot's count, which pierces frames. */
  interactableCount: number;
  scroll: {
    y: number;
    height: number;
    /** Viewport height (innerHeight). */
    viewport: number;
    moreBelow: boolean;
    moreAbove: boolean;
  };
  focus: PageFocus;
  forms: {
    controls: number;
    filled: number;
    emptyRequired: number;
    invalid: number;
    /** Controls whose value differs from their DOM default. */
    dirty: number;
    /** Blocking fields (required-empty / invalid), detail verbosity only. */
    blockers?: FormBlocker[];
  };
  /** Open dialog/modal count (role=dialog/alertdialog, <dialog open>). */
  dialogs: number;
  /** Dialog accessible names, detail verbosity only. */
  dialogNames?: string[];
  scrollLocked: boolean;
  overlay: boolean;
  /** Visible [aria-busy]/progressbar count — an app-level "still working" gauge.
   * Spinners without an ARIA busy signal won't be counted (visible in a shot). */
  busy: number;
  errorCount: number;
  /** Visible validation/alert texts, detail verbosity only. */
  errors?: string[];
  /** What changed since this tab's PREVIOUS page_state (same ActionDelta axes as
   * click/type). Undefined on the first read or right after a full navigation. */
  changed?: ActionDelta;
  /** No prior baseline this document (fresh page / first read). */
  firstObservation?: boolean;
  tabId: number;
  windowId?: number;
  /** Whether this tab is the visible one in its window. */
  active: boolean;
  /** Whether this tab's WINDOW is the OS-focused one. active && !windowFocused
   * = visible in a background window (the user isn't looking at it), which
   * active alone can't distinguish. */
  windowFocused?: boolean;
}

/** One captured network request (metadata only). */
export interface NetworkRequest {
  method: string;
  url: string;
  /** HTTP status once completed; undefined while pending / on network error. */
  status?: number;
  /** Chrome resourceType (e.g. "xmlhttprequest"). */
  type: string;
  /** Epoch ms when observed. */
  ts: number;
  /** false when the request errored or returned >= 400. */
  ok?: boolean;
}

export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
  /** Window the tab lives in — "active" is per-window, so restoring the
   * previously visible tab after a screenshot switch needs this pairing. */
  windowId?: number;
}

/** One browser window and its tabs — the unit list_tabs's flat list can't
 * express. `focused` is the OS foreground (only one window per browser). */
export interface WindowInfo {
  windowId: number;
  /** The OS-foreground window (what the user is actually looking at). */
  focused: boolean;
  /** "normal" | "minimized" | "maximized" | "fullscreen" | "locked-fullscreen". */
  state?: string;
  /** The visible tab in this window (each window has its own active tab). */
  activeTabId: number | null;
  tabs: TabInfo[];
}

export interface SnapshotElement {
  /** Stable within one snapshot; used by click/type. e.g. "e12". */
  ref: string;
  /** Lowercase tag name. */
  tag: string;
  /** ARIA role or inferred role. */
  role: string;
  /** Trimmed, truncated accessible name / text. */
  name: string;
  /** For inputs. */
  value?: string;
  /** For checkbox/radio: current checked state (so the agent can reach a desired state). */
  checked?: boolean;
  /** For <select>: the visible option labels, so the agent knows valid choices. */
  options?: string[];
  /** True if this element is a scrollable container with more content than fits. */
  scrollable?: boolean;
  /** aria-expanded state for comboboxes/disclosures (undefined if not applicable). */
  expanded?: boolean;
  /** True when the field is currently in an invalid/error state (aria-invalid or
   * failed constraint validation) — lets the agent spot rejected input. */
  invalid?: boolean;
  /** The associated validation message (via aria-describedby), when invalid. */
  invalidMessage?: string;
  /** True when aria-busy — the element/region is loading. */
  busy?: boolean;
  /** True when the element is not visible (display:none / visibility:hidden /
   * opacity:0 / zero-size). Still listed so nothing is dropped from perception —
   * e.g. a file <input> concealed behind a styled button stays reachable by ref. */
  hidden?: boolean;
  /** True when a form control is disabled — can't be interacted with, but its
   * presence/state is still worth surfacing. */
  disabled?: boolean;
  /** True for a bespoke clickable element captured only by its cursor:pointer
   * style — a styled <div>/<span> that carries no native tag/role/tabindex
   * (React/Vue onClick leaves no onclick attr). Lets the agent trust it's actionable. */
  clickable?: boolean;
  /** True when the element's box intersects the TOP-level viewport — what the user sees, also for elements inside
   * frames. Absent inside a cross-origin frame, whose position cannot be read. */
  inViewport?: boolean;
  /** Box `[x, y, width, height]` in TOP-level viewport coordinates (frames included), rounded, present only while
   * the element is on screen. Lets an agent match what it SEES in a screenshot
   * to a [ref] it can act on — and conversely, know where on screen a given
   * element is. Omitted off-screen, where a box would only mislead. */
  rect?: [number, number, number, number];
  /** ref of the nearest ancestor also in this snapshot — a lightweight parent
   * link so the flat list still carries structure (which controls group together). */
  parentRef?: string;
  /** refs of the containers this control opens — the author's own statement via
   * aria-controls / aria-owns / popovertarget, an edge that is IN the markup
   * rather than a guess. `expanded` says a disclosure is OPEN; this says WHICH
   * ref it opened, and that is what nesting cannot recover once the panel
   * portals itself to <body> and lands nowhere near its trigger — without it a
   * caller re-snapshots and hunts the whole new list by role/name. Only targets
   * that are themselves in this snapshot appear: one with no ref is nothing the
   * caller could act on anyway. */
  controls?: string[];
  /** VISUAL placement — the one thing the DOM tree cannot carry. A modal
   * portaled to <body> is a body child in the tree but covers the whole screen
   * on screen, so tree depth says nothing about where a control actually is.
   * "dialog:<name>" / "fixed-top" / "fixed-bottom" / "fixed-left" / "fixed";
   * absent = ordinary in-flow content. */
  zone?: string;
  /** True when the element merely groups others and its accessible name is just
   * its descendants' text concatenated (the innerText fallback). Its name is
   * truncated hard, because the real targets are its children. */
  container?: boolean;
}

/* ------------------------------------------------------------------ *
 * Orchestration — the verifiable step-plan contract (P0 thin runner). *
 * A plan is an ordered list of steps; each step declares how the       *
 * runner PROVES it succeeded (structured predicates the runner checks  *
 * itself against page_state/read_content/read_network/snapshot) before *
 * the plan may advance. The agent still performs each action with the  *
 * normal browser_* tools — the runner is the verify GATE, not an       *
 * executor. See docs/superpowers/specs/2026-08-12-ultrago-     *
 * orchestration-design.md.                                             *
 * ------------------------------------------------------------------ */

/** Structured done-criteria the runner can verify on its OWN (never the
 * agent's self-report). Every present field must hold (ANDed). An empty
 * object means no check — discouraged, since such a step can't be proven. */
export interface StepVerify {
  /** The current step has at least one action that returned successfully. Use
   * for terminal actions such as closeTab, whose target no longer exists for a
   * page-state verification. */
  actionSucceeded?: boolean;
  /** page_state.url contains this substring. */
  urlIncludes?: string;
  /** read_content's visible text contains this. */
  textPresent?: string;
  /** read_content's visible text does NOT contain this. */
  textAbsent?: string;
  /** snapshot has an interactable element whose accessible name contains this. */
  elementName?: string;
  /** snapshot has an interactable element (name contains this) that is CHECKED
   * (checkbox/radio/switch) — reads SnapshotElement.checked, no pixels needed. */
  elementChecked?: string;
  /** snapshot has an interactable element (name contains this) that is ENABLED
   * (not disabled) — reads SnapshotElement.disabled. */
  elementEnabled?: string;
  /** an interactable element (name contains `name`) whose value matches — reads
   * SnapshotElement.value. Give `equals` for exact or `includes` for substring. */
  elementValue?: { name: string; equals?: string; includes?: string };
  /** AGENT-JUDGED half-gate (not runner-verifiable): a natural-language claim the
   * agent must explicitly confirm (via advance's `confirm`) AFTER the mechanical
   * predicates pass. For a VISUAL claim, the agent screenshots then confirms. It
   * forces "look + explicit verdict" (no silent skip) but the judgment is
   * self-reported — weaker than the structured predicates above. */
  assert?: string;
  /** Like `assert` but VISUAL: after the mechanical checks pass the runner takes
   * a SCREENSHOT and hands it to the (vision-capable) agent to judge via advance's
   * `confirm`. The backend NEVER judges pixels itself (no built-in model) — it
   * only captures and passes the image, so this stays inside the "no built-in
   * agent" rule. Agent-judged half-gate; forces a look at the real pixels (canvas
   * / image correctness / anything with no DOM signal). */
  visualAssert?: string;
  /** read_network has a request whose URL contains `urlIncludes` with an
   * acceptable status (default: any 2xx) since the step began. `bodyIncludes`
   * (optional) ALSO checks the response BODY contains a substring — the runner
   * turns on the MAIN-world capture for the step to get it (no CDP), so a "200
   * but business-failed {code:500}" body is caught. A truncated (>8KB) or
   * non-text body may miss; capture is on only while the step runs. */
  networkOk?: { urlIncludes: string; status?: number; bodyIncludes?: string };
  /** Run a JS expression in the page (MAIN world) and gate on its value — the
   * runner runs it ITSELF, so this is runner-verified (stronger than `assert`),
   * with arbitrary expressiveness for what the structured predicates can't say
   * (a computed value, JS state, a canvas value via a page API). READ-only — do
   * NOT mutate (that would forge the very evidence). Refused when the backend runs with BCP_EVAL=off; a
   * strict page CSP can block it. `equals` → String(value) === equals; omit
   * `equals` → the value must be truthy. */
  evalCheck?: { code: string; equals?: string };
  /** page_state.errorCount === 0. */
  noErrors?: boolean;
  /** page_state.loading === false (the page has settled/hydrated). */
  settled?: boolean;
  /** page_state has an open dialog/modal (dialogs > 0). */
  dialogOpen?: boolean;
  /** page_state form summary shows nothing blocking submit
   * (controls > 0, emptyRequired === 0, invalid === 0). */
  formSubmittable?: boolean;
}

/** What the runner does when a step's verify fails.
 * - "retry":  the agent redoes the action, then calls advance again.
 * - "rescan": re-perceive (re-snapshot) first — for portal/lazy DOM churn.
 * - "escalate": stop and hand back to the agent/user with the evidence.
 * Retries are bounded by maxRetries; exhausting them forces escalate. */
export type StepRecovery = "retry" | "rescan" | "escalate";

/** How a playbook step performs its action — resolved the SAME way click/type
 * already resolve a Locator (role/name/text/css/near), just sourced from
 * playbook data instead of a live LLM call. `params` may contain
 * "{{slotName}}" placeholders, substituted from the playbook's run-time
 * params before the RPC call is made. */
export interface PlaybookStepAction {
  method: RpcMethod | LocalMethod;
  params: Record<string, unknown>;
}

/** One step of a plan: an intent + how the runner PROVES it landed + what to
 * do if it didn't. `action`/`risk` are optional — a plain (non-playbook) plan
 * step omits them exactly like P0; the runner still only performs the action
 * itself when a step is DRIVEN by playback (see playback.ts), never on its
 * own for an ordinary plan(). */
export interface PlanStep {
  goal: string;
  verify: StepVerify;
  /** Default "escalate". */
  onFail?: StepRecovery;
  /** Retry/rescan budget before a forced escalate. Default 1. */
  maxRetries?: number;
  /** 这一步的 {{slot}} 填不上时【整步丢弃】，而不是让整本书起不来。
   *
   * 只对槽位解析生效 —— gate / verify / action 的失败照旧按 onFail 走。给的是
   * 「数据少一项就少做一步」这类步骤：主图的 5 个槽位各是一个独立 file input，
   * 而 canonical 允许 1–5 张（images.main minItems 1 / maxItems 5），第 4 张不
   * 存在时那一步没有事情可做，不该是发布失败。
   *
   * 不标它的步骤仍然 fail-closed：槽位缺失是 instantiateSteps 抛错，整本书拒绝
   * 起跑 —— 缺主图第 0 张、缺标题这种就该炸在那里。 */
  optional?: boolean;
  /** What this step DOES, for playback. Absent = a plain check-only step
   * (matches existing P0 plans, unaffected). */
  action?: PlaybookStepAction;
  /** "confirm" = this step is irreversible (submit/delete/pay/send/publish).
   * Auto playback MUST pause BEFORE executing this step's action and get an
   * explicit per-run authorization — never auto-confirmed, every replay. */
  risk?: "confirm";
  /** Book v2: the target logical page this step routes to (bound tab). Every
   * v2 book step must declare one; a page bootstrap action declares the page
   * it creates and binds. Absent in pre-v2 plans. */
  page?: string;
  /** Book v2: readiness gate awaited BEFORE the action runs. Required on every
   * step except page bootstrap actions. Local refs resolve against `page`;
   * cross-page refs name `{ page, signal }` explicitly. */
  gate?: SignalGate;
  /** The consequence gate: awaited AFTER the action, BEFORE verify — "wait until
   * my action actually took effect". Same signal vocabulary as `gate`.
   *
   * This exists because `verify` is an INSTANT check, not a wait: a click whose
   * request is still in flight verifies against a page that has not changed yet,
   * so the step fails and `onFail: retry` re-runs it — the retry budget used as
   * a polling loop. Without this field that wait had nowhere to live but inside
   * `eval` (hand-rolled setTimeout loops) or that retry abuse.
   *
   * Failure semantics are the OPPOSITE of `gate`: a gate timeout means "not
   * allowed to start yet" and costs no budget, while an `after` timeout means
   * "the action ran and did not land", which is an ordinary step failure and
   * consumes onFail/maxRetries. */
  after?: SignalGate;
}

/** A named, parameterized, ordered list of steps — the recorded/authored
 * artifact `run_playbook` loads and replays. `paramNames` declares the slots
 * steps' `action.params` strings may reference as "{{name}}"; the richer
 * `params` (JSON Schema array) additionally carries each slot's type and
 * description, used by codegen and runtime validation.
 *
 * Book v2 adds `schemaVersion: 2` and `pages`; validation rejects anything
 * without them, so the optional typing here only keeps pre-v2 values
 * representable in TS — the runner never accepts them. */
export interface Playbook {
  name: string;
  goal: string;
  paramNames: string[];
  /** Book v2: the schema marker. Rejected unless === 2 by validation. */
  schemaVersion?: number;
  /** Book v2: logical page namespace with named signals. Required + non-empty
   * in v2; each step routes to one page and gates on its signals. */
  pages?: Record<string, BookPageDefinition>;
  /** Optional JSON Schema per input slot (SSOT: resource/playbooks/*.json `params`). */
  params?: BookParamSchema[];
  /** Data contract: the shape of the book's final produced data. Absent =
   * void (no structured output — the run record IS the product). */
  outputSchema?: Record<string, unknown>;
  /** Delivery contract: where the produced data goes. Empty = no delivery
   * (pure state recording). See `Delivery`. */
  deliveries?: Delivery[];
  steps: PlanStep[];
}

export type { Delivery, DeliveryRunStatus, ResolvedDelivery, RunConclusion } from "./deliveries.js";
export { DELIVERY_DEFAULTS, DELIVERY_RUN_STATUS_VALUES, RUN_CONCLUSION_VALUES, normalizeDeliveries, normalizeDelivery, resolveDeliveries } from "./deliveries.js";

/* ------------------------------------------------------------------ *
 * Book v2 — page signals and gates (the readiness contract).          *
 * ------------------------------------------------------------------ */
export {
  BOOK_SCHEMA_VERSION,
  isBookV2,
  validateBookV2,
  validateGate,
  validateSignalCondition,
  resolveSignalRef,
} from "./book-signals.js";
export type {
  BookV2,
  BookPageDefinition,
  BookSignalDefinition,
  SignalCondition,
  SignalGate,
  SignalRef,
} from "./book-signals.js";
export type { OutputType, TypedOutput } from "./output-type.js";
export type { SchemaCitation, SchemaCitationInput } from "./schema-citation.js";
export * from "./param-runtime.js";
export { classifyOutput } from "./output-type.js";
export * from "./schema-records.js";
export * from "./param-schema-bridge.js";

/* ------------------------------------------------------------------ *
 * Browser events — page-originated signals the extension pushes to    *
 * the backend UNSOLICITED (navigation/dialog/console error/…), NOT as *
 * an RPC response. The backend buffers them by a monotonic seq so any *
 * MCP client can drain "what happened since my last tool call"        *
 * (piggyback), pull them explicitly, or block until one arrives.      *
 * ------------------------------------------------------------------ */

export type BrowserEventKind =
  // Page-originated (pushed by the extension):
  | 'navigation_started'
  | "navigation"
  | "dialog"
  | "console_error"
  | "network_failed"
  | "network_body"
  | "dom_changed"
  // Pushed the moment a challenge CANDIDATE shows up on any watched tab.
  // `detail` carries a CaptchaSignal. Never shown to the agent — see
  // isAgentHiddenEvent.
  | "captcha_appeared"
  | "captcha_cleared"
  // A tab went away. Emitted so backend state keyed by tabId can be dropped:
  // a tab that is closed while blocked would otherwise be asserted as blocked
  // forever, since every other clearing signal comes FROM the page that just
  // stopped existing.
  | "tab_closed"
  // Orchestration-level (pushed by the backend) — so every agent can be
  // NOTIFIED of topology/coordination changes instead of polling for them.
  // wait_for_event accepts these kinds too.
  | "browser_online"
  | "browser_offline"
  | "mode_changed"
  | "claim_changed"
  | "target_changed"
  | "window_opened"
  | "window_closed";

/** Orchestration-level event kinds (pushed by the backend, not the page). They
 * are NOT scoped to a session's target browser in the piggyback/wait filters —
 * a coordination signal is relevant to every agent, whatever it's driving. */
export const TOPOLOGY_EVENT_KINDS: readonly BrowserEventKind[] = [
  "browser_online",
  "browser_offline",
  "mode_changed",
  "claim_changed",
  "target_changed",
  "window_opened",
  "window_closed",
];

export function isTopologyEvent(kind: BrowserEventKind): boolean {
  return (TOPOLOGY_EVENT_KINDS as readonly string[]).includes(kind);
}

/** Kinds that exist for out-of-band consumers (the event webhook) and are
 * withheld from every agent-facing surface — piggyback, read_events,
 * wait_for_event. A challenge candidate is a DOM estimate; handing it to the
 * agent made it abandon work on pages nothing was blocking. */
export const AGENT_HIDDEN_EVENT_KINDS: readonly BrowserEventKind[] = ["captcha_appeared", "captcha_cleared"];

export function isAgentHiddenEvent(kind: BrowserEventKind): boolean {
  return (AGENT_HIDDEN_EVENT_KINDS as readonly string[]).includes(kind);
}

/** One page-originated event. `payload` shape is kind-specific and kept loose
 * so new kinds don't churn the wire type. `seq` is assigned backend-side. */
export interface BrowserEvent {
  kind: BrowserEventKind;
  /** Tab the event came from (-1 when not tab-scoped). */
  tabId: number;
  /** Epoch ms observed in the page / service worker. */
  ts: number;
  /** Human-readable one-liner, rendered directly in piggyback output. */
  summary: string;
  /** Kind-specific structured detail (url, message, status, body preview…). */
  detail?: Record<string, unknown>;
  /** Monotonic per-process seq, stamped by the backend EventStore on ingest.
   * Absent on the wire (extension→backend); present once buffered. */
  seq?: number;
  /** Which browser instance pushed this event — the instanceId (routing key,
   * not a display label). Stamped by the backend on ingest (like seq); absent
   * on the wire. */
  browser?: string;
}

/* ------------------------------------------------------------------ *
 * Message envelopes                                                   *
 * ------------------------------------------------------------------ */

/** Extension -> Backend: first frame after the socket opens. v5 requires the
 * instance identity — a hello without a valid `instanceId` is rejected as
 * protocol_incompatible (an un-identifiable extension can never be trusted to
 * route actions, probes, claims or runs). */
export interface HelloMessage {
  type: "hello";
  protocolVersion: number;
  role: ClientRole;
  token: string;
  clientInfo: { name: string; version: string; artifactHash?: string };
  /** Which browser this extension runs in ("chrome" / "firefox"). */
  browser: BrowserKind;
  /** Instance identity: which instance of `browser` this extension is. */
  instanceId: string;
}

/** Backend -> Extension: handshake accepted. The extension must then send
 * `ready` before the backend treats the session as connected. */
export interface WelcomeMessage {
  type: "welcome";
  browser: BrowserKind;
  instanceId: string;
  sessionId: string;
  protocolVersion: number;
  serverVersion: string;
}

/** Extension -> Backend: sent ONLY after receiving `welcome`, matching this
 * socket's sessionId + target. The backend marks the session authenticated /
 * connected on receipt — `hello` alone is never enough. */
export interface ReadyMessage {
  type: "ready";
  instanceId: string;
  sessionId: string;
}

/** Backend -> Extension: handshake rejected (bad token / version). Socket then closes. */
export interface RejectMessage {
  type: "reject";
  reason: string;
}

/** Heartbeat. Backend pings, extension pongs. */
export interface PingMessage {
  type: "ping";
  t: number;
}
export interface PongMessage {
  type: "pong";
  t: number;
}

/** Backend -> Extension: RPC request driving a browser action. */
export interface RpcRequestMessage {
  type: "rpc_request";
  id: string;
  method: RpcMethod;
  params: unknown;
}

/**
 * Why an RPC failed, in a form a program can branch on.
 *
 * The message alone cannot carry this: replay has to tell "this selector no
 * longer matches" (recoverable — the healing ladder can try another way to
 * reach the element) apart from "the extension went away" (not recoverable by
 * any locator). Both arrive as a sentence today, so the only available test is
 * matching prose — which changes, and mis-judging it sends a disconnected
 * browser into self-healing.
 *
 * `LOCATOR_*` are the recoverable ones. `REF_*` deliberately are NOT: a ref is
 * snapshot-scoped and has no business being in a replayable book at all (the
 * recorder already warns about it), so a stale one is an authoring bug rather
 * than page drift.
 */
export type RpcErrorCode =
  | "LOCATOR_NO_MATCH"
  | "LOCATOR_AMBIGUOUS"
  | "LOCATOR_NTH_RANGE"
  | "REF_UNKNOWN"
  | "REF_STALE";

/** One element the page offered when a locator failed to resolve. */
export interface RpcErrorCandidate {
  role?: string;
  name?: string;
  text?: string;
  css?: string;
}

/**
 * The structured half of an RPC failure. Optional on the wire on purpose: an
 * older extension simply omits it and the backend then treats the failure as
 * unrecoverable — the pre-existing behaviour. Never infer a code from `error`.
 *
 * `candidates` is what the page actually offered at the moment of the miss.
 * The DOM runtime already lists them in the message text; carrying them as data
 * is what lets a repair step read them instead of parsing prose.
 */
export interface RpcErrorInfo {
  code: RpcErrorCode;
  candidates?: RpcErrorCandidate[];
  /**
   * The one dimension that excluded everything: dropping it is what let the
   * page match `candidates` again. The DOM runtime already computes this to
   * explain a miss to a person ("without css it matches 1"); as data it names
   * the failed dimension outright, which is the whole question a fallback chain
   * has to answer.
   */
  relaxedBy?: string;
}

/** Extension -> Backend: RPC response. */
export type RpcResponseMessage =
  | { type: "rpc_response"; id: string; ok: true; result: unknown }
  | { type: "rpc_response"; id: string; ok: false; error: string; errorInfo?: RpcErrorInfo };

/** Extension -> Backend: an unsolicited page event (navigation/dialog/…).
 * Not answering any request — distinct from rpc_response. */
export interface EventMessage {
  type: "event";
  event: BrowserEvent;
}

/** Every frame the extension may send to the backend. */
export type ClientMessage =
  | HelloMessage
  | ReadyMessage
  | PongMessage
  | RpcResponseMessage
  | EventMessage;

/** Every frame the backend may send to the extension. */
export type ServerMessage =
  | WelcomeMessage
  | RejectMessage
  | PingMessage
  | RpcRequestMessage;

export type AnyMessage = ClientMessage | ServerMessage;

/** Narrowing helper. */
export function isMessageType<T extends AnyMessage["type"]>(
  msg: AnyMessage,
  type: T,
): msg is Extract<AnyMessage, { type: T }> {
  return msg.type === type;
}

// Browser lifecycle domain (readiness / setup / instance identity). Types +
// constants only — see browser-lifecycle.ts.
export * from "./browser-lifecycle.js";

// Console API types (shared with the React frontend).
export * from "./console-types.js";
export * from "./schema-compat.js";
export * from "./schema-keywords.js";
export * from "./schema-ref-resolution.js";
export * from "./flow-types.js";
export * from "./flow-ports.js";
export * from './flow-business-outcome.js';
export * from './flow-resume-protection.js';
export * from './diagnostic-redaction.js';
export * from './desktop-runtime.js';
export * from './flow-branch.js';
export * from "./script-skeleton.js";
// Playbook step action discriminated union (derived from RpcMethod/LocalMethod).
export * from "./book-actions.js";
// 内联 JS 的 `string | string[]` 存储契约（Postman Collection v2.1.0 的 Script.exec）。
// 读盘边界调 normalizeBookCode 合成，写盘调 splitBookCode 切行。
export * from "./book-code.js";
// Codegen output — book param types + JSON schema registry (source: resource/playbooks/*.json).
export * from "./generated/books.js";
export * from "./generated/schema.js";
export { attachmentParamShape, isParamMap, normalizeParams, parseParamValue, renderDefaultTemplate, resolveParamDefaults, resolveParamSchema, validateOutput, validateParams } from "./param-runtime.js";
export type { AttachmentParamShape, DefaultContext, DefaultTemplate, ParamDefaultValue, ParamMap, ParamPrimitive, ParamSchemaFragment, ParamSpec } from "./param-runtime.js";
// MCP tool name/description/params SSOT, keyed by RpcMethod. browser-mcp.ts
// registers every 1:1 tool with this (description + zod field descriptions).
export * from "./mcp-instructions.js";
