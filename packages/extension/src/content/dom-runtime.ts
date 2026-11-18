import type { SnapshotElement, ActionDelta, CaptchaSignal } from "@bcp/shared";

/**
 * Self-contained DOM automation runtime, injected on demand via
 * chrome.scripting.executeScript({ func: bcpDomRuntime, world: "ISOLATED" }).
 *
 * WHY a single self-contained function (no imports, all helpers nested):
 *   - executeScript serializes the function source; any reference to module
 *     scope would break at runtime, so everything lives inside.
 *   - Running on demand means DOM ops no longer depend on a PERSISTENT content
 *     script — they work on chrome://-adjacent pages, pre-existing tabs, and
 *     after an extension reload, none of which the declarative content script
 *     survives.
 *   - world:"ISOLATED" keeps the snapshot ref map (stored on the isolated-world
 *     global) invisible to the page and persistent across injections per frame.
 *
 * Build target is ES2022 (native async/await, spread) so esbuild injects NO
 * module-level helpers into the serialized body.
 */
export async function bcpDomRuntime(
  op: "snapshot" | "click" | "type" | "read" | "wait" | "select" | "key" | "scroll" | "drag" | "upload" | "hover" | "clickText" | "contextmenu" | "dblclick" | "paste" | "state",
  params: {
    ref?: string; text?: string; submit?: boolean; maxChars?: number; offset?: number; full?: boolean;
    role?: string; name?: string; css?: string; near?: string; x?: number; y?: number;
    waitText?: string; ms?: number; humanize?: boolean;
    values?: string[]; key?: string; deltaY?: number; toBottom?: boolean;
    selector?: string; state?: "visible" | "hidden"; confirm?: boolean;
     toRef?: string; dragMethod?: "html5" | "pointer"; filename?: string; mimeType?: string; dataBase64?: string; dataBase64s?: string[];
    exact?: boolean; nth?: number;
    verbosity?: "summary" | "detail"; resetDelta?: boolean; deltaKey?: string;
  },
): Promise<{ value?: unknown; error?: string }> {
  try {
    // Ref map persists across injections in the isolated world (page can't see it).
    const store = globalThis as unknown as {
      __bcpRefs?: Map<string, Element>;
      /** Reverse of __bcpRefs, published by snapshot() so page_state resolves
       *  element -> ref in O(1) instead of scanning the whole map per lookup.
       *  Weak: only ever queried BY element, and a strong map would pin the
       *  previous DOM generation alive across injections. */
      __bcpRefOf?: WeakMap<Element, string>;
      /** Recent mutating actions, newest last. Each RPC is stateless, so without
       *  this the caller cannot know it already clicked the very same element —
       *  and a toggle clicked twice is indistinguishable from a dead control.
       *  WeakRef so a remembered element never keeps a detached node alive. */
      __bcpActs?: { el: WeakRef<Element>; at: number }[];
      /** Highest ref number ever minted in this document. Refs are reused for
       *  elements that survive a re-snapshot, so the counter cannot restart —
       *  a fresh element must never be handed a number a live element still holds. */
      __bcpRefSeq?: number;
      /** Refs present at the observer's previous snapshot, keyed by deltaKey the
       *  same way page_state keys its state baseline, so two sessions sharing a
       *  tab don't consume each other's "what changed since I last looked". */
      __bcpSnapSeen?: Record<string, string[]>;
    };
    store.__bcpRefs ??= new Map<string, Element>();

    // Single source of the interactable selector — shared by snapshot() and
    // captureSig() so the delta's element count and the snapshot list agree (V2).
    const SNAP_SELECTOR =
      'a[href], button, input:not([type="hidden"]), textarea, select, summary, ' +
      '[role], [contenteditable=""], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"]), ' +
      // `drag` addresses its endpoints by ref, and refs only exist for elements
      // in the snapshot — so without this the drag tool cannot reach a plain
      // <div draggable="true">, i.e. exactly the sortable-list case it is for.
      '[draggable="true"]';

    // Behavioral humanization for click/type is OFF by default: synthetic events
    // carry isTrusted:false, which any anti-bot check reads first — so the jitter
    // buys no real cover while costing 150-350ms per click and 35-110ms per
    // keystroke. Opt in with humanize:true when a human is watching the run.
    // (scroll keeps its own default-ON tick loop — there the pacing is functional,
    // it drives lazy-load/IntersectionObserver, not disguise.)
    // page-context Math.random is fine here.
    const human = params.humanize === true;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    /** Resolve after the browser has had a real rendering opportunity. The first
     *  frame ends this turn; the IntersectionObserver task queued during THAT
     *  frame's rendering steps runs before the second callback fires, so by then
     *  the lazy loading a scroll just triggered has already been appended. Capped
     *  because rAF is frozen in a hidden tab — callers must skip it there rather
     *  than pay the cap (see the click path). */
    const afterNextPaint = (capMs = 60): Promise<void> =>
      new Promise<void>((resolve) => {
        const done = () => { clearTimeout(cap); resolve(); };
        const cap = setTimeout(done, capMs);
        requestAnimationFrame(() => requestAnimationFrame(done));
      });

    // Wait until the DOM is meaningfully rendered before reading it. SPAs report
    // readyState "complete" with an empty <body> until the framework hydrates,
    // so a plain read/snapshot at that moment returns misleading emptiness.
    // Gate: document parsed + body has real content + a brief mutation quiet
    // period, capped so a genuinely-blank page still returns promptly.
    const settleDom = async (maxMs = 3000, quietMs = 250): Promise<void> => {
      const start = Date.now();
      if (document.readyState === "loading")
        await new Promise<void>((r) => document.addEventListener("DOMContentLoaded", () => r(), { once: true }));
      const hasContent = () => (document.body?.innerText?.trim().length ?? 0) > 0 || (document.body?.childElementCount ?? 0) > 2;
      while (!hasContent() && Date.now() - start < maxMs) await sleep(50);
      // Quiescence, with two windows. Text streamed into EXISTING nodes is real
      // hydration and must still hold the gate (learn 2026-07-21: reading an
      // un-hydrated SPA returns misleading emptiness) — but a ticking counter or
      // a live clock is also characterData, and under one shared window it holds
      // the gate open until maxMs on every single read. So element add/remove
      // (which is what changes the interactable set) keeps the full window,
      // while text-only churn settles on a much shorter one.
      const TEXT_QUIET = Math.min(quietMs, 120);
      await new Promise<void>((resolve) => {
        let timer = setTimeout(done, quietMs);
        const cap = setTimeout(done, Math.max(0, maxMs - (Date.now() - start)));
        const obs = new MutationObserver((records) => {
          let structural = false;
          for (const r of records) {
            if (r.type === "characterData") continue;
            for (const n of r.addedNodes) if (n.nodeType === 1) { structural = true; break; }
            if (structural) break;
            for (const n of r.removedNodes) if (n.nodeType === 1) { structural = true; break; }
            if (structural) break;
          }
          clearTimeout(timer);
          timer = setTimeout(done, structural ? quietMs : TEXT_QUIET);
        });
        obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        function done() {
          clearTimeout(timer);
          clearTimeout(cap);
          obs.disconnect();
          resolve();
        }
      });
    };

    const truncate = (s: string, n: number): string => {
      const t = s.replace(/\s+/g, " ").trim();
      return t.length > n ? `${t.slice(0, n)}…` : t;
    };
    /** Visible = a non-empty box AND what `checkVisibility()` says.
     *
     *  Geometry first because snapshot runs this over every element in the
     *  document and an empty box is the cheap way out; the order is otherwise
     *  irrelevant (plain AND).
     *
     *  What changed and why (measured against Playwright's definition over the
     *  22 ways CSS/HTML can hide something — the matrix now lives in check:dom):
     *   - `content-visibility:hidden` and a closed `<details>` were both
     *     answered VISIBLE by the old predicate, and by all six other copies of
     *     it in this repo. `getComputedStyle` cannot see either; only
     *     `checkVisibility` walks the flat tree far enough to.
     *   - `opacity !== "0"` is GONE. An `opacity:0` element still occupies
     *     layout and still receives clicks, so Playwright counts it visible.
     *     Worse, the old test read the element's own computed opacity, so the
     *     same visual result answered differently depending on whether the
     *     author set it on the node or on an ancestor.
     *   - zero size now means EITHER dimension is 0, not both. A 80x0 panel
     *     mid-expand is not something a user can click.
     *
     *  Semantically identical to bcpDomHelpersFactory's `visible` and textually
     *  identical to bcpSignalWait's copy (the factory one tests checkVisibility
     *  first and geometry last — same AND, different order, because that one is
     *  not called per-element over a whole document). They cannot share a symbol
     *  — each is stringified into the page separately — so what keeps them honest
     *  is check:dom's V group, which runs the 22-row matrix against all three. */
    const isVisible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const check = (el as Element & {
        checkVisibility?: (o?: Record<string, boolean>) => boolean;
      }).checkVisibility;
      if (typeof check !== "function") {
        const d = el.closest("details,summary");
        if (d && d !== el && d.nodeName === "DETAILS" && !(d as HTMLDetailsElement).open) return false;
        return getComputedStyle(el).visibility === "visible";
      }
      // Old and new option spellings both passed: unknown keys are ignored, so
      // this is the only form that holds on an engine knowing just one set.
      return check.call(el, {
        visibilityProperty: true,
        checkVisibilityCSS: true,
      });
    };
    const inferRole = (el: Element): string => {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button" || tag === "summary") return "button";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const type = (el as HTMLInputElement).type;
        return ["checkbox", "radio", "button", "submit", "file", "search"].includes(type) ? type : "textbox";
      }
      if (el.getAttribute("contenteditable") !== null) return "textbox";
      return "generic";
    };
    const accessibleName = (el: Element): string => {
      const aria = el.getAttribute("aria-label");
      if (aria) return aria;
      const labelledby = el.getAttribute("aria-labelledby");
      if (labelledby) {
        const ref = document.getElementById(labelledby);
        if (ref?.textContent) return ref.textContent;
      }
      // A form control is usually named by its associated <label> — either via
      // for=, or by being nested inside one. Without this step a labelled field
      // has NO name at all: it carries no child text of its own, so it is
      // anonymous in the snapshot and unfindable by name.
      const labels = (el as HTMLInputElement).labels;
      if (labels?.length) {
        const viaLabel = [...labels].map((l) => l.textContent ?? "").join(" ").trim();
        if (viaLabel) return viaLabel;
      }
      const input = el as HTMLInputElement;
      if (input.placeholder) return input.placeholder;
      if (el.getAttribute("alt")) return el.getAttribute("alt")!;
      if (el.getAttribute("title")) return el.getAttribute("title")!;
      return (el as HTMLElement).innerText || el.textContent || "";
    };

    const resolve = (ref: string): HTMLElement => {
      // Read through the store rather than a captured binding: snapshot() swaps
      // the map wholesale (see its publish step) instead of mutating in place.
      const el = store.__bcpRefs?.get(ref);
      if (!el) throw new Error(`unknown ref "${ref}" — take a fresh snapshot`);
      if (!el.isConnected) throw new Error(`stale ref "${ref}" (element was removed) — take a fresh snapshot`);
      return el as HTMLElement;
    };

    // ---- Action delta: capture a compact page signature before/after a mutating
    // action so the tool can report what changed without a full re-snapshot. ----
    // NOTE: bare [role="alert"] is deliberately NOT here. That role means "announce
    // this promptly", not "this is an error" — a version-update banner, a save
    // confirmation and a cookie notice all legitimately carry it. Including it made
    // page_state report a standing "1 error(s)" on an ordinary page, which both
    // buried real errors and actively misled a session into investigating a click
    // that was fine. Component libraries put their real validation errors behind
    // the class selectors below (which usually ALSO carry role=alert), so nothing
    // is lost; genuine alerts remain visible in the snapshot as `alert` elements.
    const ERROR_SELECTOR =
      '[aria-invalid="true"], [aria-errormessage], .error, .ant-form-item-explain-error, .arco-form-message-error, .el-form-item__error';
    const collectErrors = (): string[] => {
      const out: string[] = [];
      for (const el of document.querySelectorAll(ERROR_SELECTOR)) {
        if (!isVisible(el)) continue;
        const t = (el as HTMLElement).innerText?.trim();
        if (t) out.push(truncate(t, 80));
        if (out.length >= 10) break;
      }
      return out;
    };
    // Selector-agnostic interruption probes: a scroll-locked page and a large
    // fixed/absolute layer over the viewport center catch modals/overlays that
    // carry no [role] — where the role-based `dialogs` count above is blind.
    const scrollLocked = (): boolean =>
      /hidden/.test(getComputedStyle(document.body).overflow + " " + getComputedStyle(document.documentElement).overflow);
    const centerOverlay = (): boolean => {
      const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2) as HTMLElement | null;
      if (!el || !/^(fixed|absolute|sticky)$/.test(getComputedStyle(el).position)) return false;
      const r = el.getBoundingClientRect();
      return r.width * r.height > innerWidth * innerHeight * 0.4;
    };
    // Open dialogs, VISIBILITY-FILTERED — component libraries keep closed modals
    // mounted (display:none). Shared by captureSig (→ delta's dialogsOpened) and
    // page_state's `dialogs` field so the two never disagree. A native
    // <dialog open> is open by definition, so trust the attribute.
    const visibleDialogs = (): Element[] =>
      [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]')].filter(
        (d) => (d as HTMLElement).matches("dialog[open]") || isVisible(d),
      );
    type Sig = { url: string; count: number; dialogs: number; errors: string[]; locked: boolean; overlay: boolean };
    const captureSig = (): Sig => ({
      url: location.href,
      count: document.querySelectorAll(SNAP_SELECTOR).length,
      dialogs: visibleDialogs().length,
      errors: collectErrors(),
      locked: scrollLocked(),
      overlay: centerOverlay(),
    });
    const diffSig = (b: Sig, a: Sig): ActionDelta | undefined => {
      const d: ActionDelta = {};
      if (b.url !== a.url) d.urlChanged = a.url;
      if (a.count !== b.count) d.elementDelta = a.count - b.count;
      if (a.dialogs > b.dialogs) d.dialogsOpened = a.dialogs - b.dialogs;
      if (a.locked && !b.locked) d.scrollLocked = true;
      if (a.overlay && !b.overlay) d.overlay = true;
      const newErrors = a.errors.filter((e) => !b.errors.includes(e));
      if (newErrors.length) d.newErrors = newErrors;
      if (a.errors.length) d.errorCount = a.errors.length;
      return Object.keys(d).length ? d : undefined;
    };
    // Diff against `before`, but never let a failed after-capture (page mid-
    // navigation → torn-down DOM) turn a successful action into an error.
    const afterDelta = (before: Sig): ActionDelta | undefined => {
      try {
        return diffSig(before, captureSig());
      } catch {
        return undefined;
      }
    };
    // Run a mutating action, let sync re-renders (dropdown/dialog open) flush,
    // then diff. Settle is kept SHORT so a navigating action's context isn't torn
    // down mid-await (which would reject the whole injection). Async-appearing
    // validation is caught by the next snapshot's [invalid] state or read_network.
    /** An action may hand back its own baseline, and MUST when it scrolls before
     *  dispatching: a baseline taken before that scroll attributes every
     *  lazy-loaded row our own scrolling triggered to the action itself — which
     *  is exactly the `±N elements` signal the tool text teaches the agent to
     *  read as an interruption. */
    type ActOutcome = { evidence?: Partial<ActionDelta>; baseline?: Sig };
    const withDelta = async (act: () => Promise<ActOutcome | void>): Promise<ActionDelta | undefined> => {
      const fallback = captureSig();
      const out = (await act()) || {};
      await sleep(50);
      const page = afterDelta(out.baseline ?? fallback);
      // Evidence about the ACTION is reported even when the page signature did
      // not move — "ok, and the page looks identical" is precisely the case the
      // agent cannot interpret on its own.
      const ev = out.evidence;
      if (!ev || !Object.keys(ev).length) return page;
      return { ...(page ?? {}), ...ev };
    };

    // HTML5 drag-and-drop via synthetic DnD events. Works for JS-listening drop
    // zones (sortable/kanban/drop-upload); per spec synthetic events do NOT drive
    // the browser's native OS-level drag (learn 2026-07-21).
    // A drag presses, moves and releases, so it answers to the same gate as a click: one end inside the other is
    // a click in disguise, and a risky label on either end — the control pressed, or the zone dropped onto (a
    // 删除 bin) — needs the user's confirm.
    const dragGate = (from: HTMLElement, to: HTMLElement, confirmed: boolean | undefined): void => {
      if (composedContains(from, to) || composedContains(to, from))
        throw new Error("drag: the source and the target must be two separate elements — a press and release on one control is a click; use click for that");
      for (const [end, el] of [["source", from], ["target", to]] as const) {
        const label = (accessibleName(el) || (el as HTMLInputElement).value || el.getAttribute("title") || "").trim();
        if (!confirmed && RISKY.test(label))
          throw new Error(`risky action on "${label.slice(0, 40)}" (drag ${end}) — pass confirm:true to proceed (only if the user asked for this)`);
      }
    };

    const realDrag = async (from: HTMLElement, to: HTMLElement, confirmed?: boolean): Promise<ActOutcome> => {
      dragGate(from, to, confirmed);
      // Both endpoints, because a drop onto a covered target lands on the cover.
      // This path had no actionability check of any kind before.
      await reachTarget(from, "drag");
      // The baseline is taken after the LAST scroll (see ActOutcome): rows that scrolling loaded are not the drag's.
      const { baseline } = await reachTarget(to, "drop");
      const dt = new DataTransfer();
      const ev = (type: string, el: Element): DragEvent => {
        const r = el.getBoundingClientRect();
        return new DragEvent(type, {
          bubbles: true, cancelable: true, composed: true,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, dataTransfer: dt,
        });
      };
      from.dispatchEvent(ev("dragstart", from));
      to.dispatchEvent(ev("dragenter", to));
      // Leaving the source is a real part of the gesture: sortable libraries hang
      // their "clear the placeholder / un-highlight" logic on dragleave, and a
      // drag that never fires one leaves the source row styled as still-dragging
      // after the drop. Per spec the new target gets dragenter first, then the
      // old one gets dragleave.
      if (to !== from) from.dispatchEvent(ev("dragleave", from));
      // Per the HTML5 DnD spec a drop target signals "I accept this" by calling
      // preventDefault on dragover. That handshake is the only cheap way to
      // tell a real reorder from a drag onto dead space: reordering a list
      // changes neither the element count nor the URL nor any aria attribute,
      // so the page signature stays flat either way. realClick has captured
      // this same dispatchEvent return since it was written; drag threw it away.
      // More than one dragover on purpose: a real pointer emits a stream of them,
      // and list libraries decide insert-before vs insert-after from the movement
      // BETWEEN two of them. A single event gives them nothing to compare.
      let accepted = false;
      for (let i = 0; i < 3; i++) if (!to.dispatchEvent(ev("dragover", to))) accepted = true;
      to.dispatchEvent(ev("drop", to));
      from.dispatchEvent(ev("dragend", from));
      return { evidence: { defaultPrevented: accepted }, baseline };
    };

    // Pointer-driven drag for libraries built on pointer/mouse events rather than HTML5 DnD (sortable lists in
    // fallback mode, range sliders, canvas editors): press on the source, a straight run of moves, release over
    // the target. Each event goes to whatever is under the pointer, as a real one would (pointer capture is not
    // emulated), and bubbles to the document listeners these libraries attach on press. A frame apart, so a
    // library that updates on requestAnimationFrame sees motion. Synthetic events stay isTrusted=false: a widget
    // that checks that — typically one asking the user to prove they are human — will not move.
    const realPointerDrag = async (from: HTMLElement, to: HTMLElement, confirmed?: boolean): Promise<ActOutcome> => {
      dragGate(from, to, confirmed);
      await reachTarget(to, "drop");
      const { baseline } = await reachTarget(from, "drag");
      const center = (el: Element): [number, number] => {
        const r = el.getBoundingClientRect();
        return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
      };
      const [x0, y0] = center(from);
      const [x1, y1] = center(to);
      // Bringing the source on screen can scroll the target away; dragging to stale coordinates would drop on
      // whatever is there now, so both ends must be visible together.
      const onScreen = (x: number, y: number) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
      if (!onScreen(x0, y0) || !onScreen(x1, y1))
        throw new Error("drag (pointer): the source and the target are not on screen together — scroll so both are visible, or drag in shorter steps");
      const at = (x: number, y: number): HTMLElement => deepElementFromPoint(x, y) ?? from;
      from.dispatchEvent(new PointerEvent("pointerover", pointerInit(x0, y0, "move")));
      from.dispatchEvent(new PointerEvent("pointerdown", pointerInit(x0, y0, "down")));
      from.dispatchEvent(new MouseEvent("mousedown", pointerInit(x0, y0, "down")));
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        const x = Math.round(x0 + ((x1 - x0) * i) / steps);
        const y = Math.round(y0 + ((y1 - y0) * i) / steps);
        const held = { ...pointerInit(x, y, "move"), buttons: 1 };
        const el = at(x, y);
        el.dispatchEvent(new PointerEvent("pointermove", held));
        el.dispatchEvent(new MouseEvent("mousemove", { ...held, button: 0 }));
        await sleep(16);
      }
      const end = at(x1, y1);
      end.dispatchEvent(new PointerEvent("pointerup", pointerInit(x1, y1, "up")));
      end.dispatchEvent(new MouseEvent("mouseup", pointerInit(x1, y1, "up")));
      return { evidence: {}, baseline };
    };

    // Shadow-piercing querySelector (first match across document + open shadow roots).
    const queryDeep = (sel: string): Element | null => {
      const search = (root: Document | ShadowRoot): Element | null => {
        const m = root.querySelector(sel);
        if (m) return m;
        for (const host of root.querySelectorAll("*")) {
          const sr = (host as HTMLElement).shadowRoot;
          if (sr) {
            const r = search(sr);
            if (r) return r;
          }
          if (host instanceof HTMLIFrameElement) {
            try {
              const doc = host.contentDocument; // same-origin only; cross-origin throws
              if (doc) {
                const r = search(doc);
                if (r) return r;
              }
            } catch {
              /* cross-origin iframe — out of reach */
            }
          }
        }
        return null;
      };
      return search(document);
    };

    /** The nearest ancestor (self included) that is genuinely not rendering. The
     *  element's own zero box is the symptom; this is the cause, and the only thing
     *  worth acting on. */
    const hiddenCause = (el: Element): Element => {
      for (let n: Element | null = el; n; n = climbOut(n)) {
        // Deliberately NOT `!isVisible(n)`: an element hidden by an ancestor is
        // itself invisible, so that test would return the element on the first
        // iteration and report the symptom as the cause. What is asked here is
        // "which node CARRIES the rule", so each node is tested on its own
        // declarations. Kept in step with isVisible: `opacity:0` is no longer a
        // cause (it does not make anything invisible), while content-visibility
        // and a closed <details> now are — the two the old rule could not see.
        const st = getComputedStyle(n);
        if (st.display === "none" || st.visibility === "hidden") return n;
        if (st.getPropertyValue("content-visibility") === "hidden") return n;
        if (n.nodeName === "DETAILS" && !(n as HTMLDetailsElement).open) return n;
      }
      return el;
    };
    /** aria-controls is the author's own statement of which control opens a
     *  container — an edge that is IN the markup, not a guess — and its [ref] is the
     *  argument for the retry. Returns "" when the page declares no such edge:
     *  saying nothing is correct then, because a list of things to try ("open the
     *  menu / switch tab / expand the section") is not information the caller
     *  didn't already have. */
    const openerFor = (cause: Element): string => {
      const id = cause instanceof HTMLElement ? cause.id : "";
      const opener = id ? document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(id)}"]`) : null;
      if (!opener) return "";
      const ref = store.__bcpRefOf?.get(opener);
      return ` — ${describeEl(opener)} declares aria-controls="${id}": click ${ref ? `[ref] "${ref}"` : "it"} first`;
    };
    /** WHICH of the three actionability axes failed, and the one thing that can
     *  change it. "hidden or disabled" collapsed three unrelated next steps into one
     *  sentence: a detached element must be re-located, a disabled one is waiting on
     *  its form, an undisplayed one on the container that holds it — and retrying is
     *  right for exactly none of them. */
    const whyNotActionable = (el: HTMLElement, waitedMs: number): string => {
      if (!el.isConnected)
        return "it was removed from the DOM mid-wait — re-locate it (take a fresh snapshot, or address it by description instead of by [ref])";
      if ((el as HTMLInputElement).disabled || el.getAttribute("aria-disabled") === "true")
        return `${describeEl(el)} was still disabled after ${waitedMs}ms — page_state {verbosity:"detail"} names the form fields that block submission`;
      const cause = hiddenCause(el);
      if (cause === el) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) {
          // isVisible also rejects a 0×0 box, and nothing up the chain is hidden —
          // so "not displayed" would be the wrong word and the wrong next step.
          const inner = [...el.querySelectorAll<HTMLElement>("*")].find((c) => isVisible(c));
          const ref = inner ? store.__bcpRefOf?.get(inner) : undefined;
          return `${describeEl(el)} is rendered but its box is 0×0 — it has no layout of its own` +
            (inner ? `; ${describeEl(inner)}${ref ? ` [ref] "${ref}"` : ""} inside it does — act on that` : "");
        }
        return `${describeEl(el)} is in the DOM but not displayed${openerFor(el)}`;
      }
      return `${describeEl(el)} is not displayed because ${describeEl(cause)} is hidden${openerFor(cause)}`;
    };

    // Auto-wait: block until the element is connected, visible and enabled (or time out).
    const waitActionable = async (el: HTMLElement, ms = 5000): Promise<void> => {
      const deadline = Date.now() + ms;
      for (;;) {
        const enabled = !(el as HTMLInputElement).disabled && el.getAttribute("aria-disabled") !== "true";
        if (el.isConnected && isVisible(el) && enabled) return;
        if (Date.now() > deadline) throw new Error(`not actionable within ${ms}ms: ${whyNotActionable(el, ms)}`);
        await sleep(100);
      }
    };

    // NOTE: there is deliberately no "wait until the box stops moving" gate here,
    // although Playwright has one (two consecutive animation frames at the same
    // position). Measured: with the interception retry above, adding it changed
    // no observable outcome — a moving target is rejected by the hit test and
    // retried either way, so stability polling only substitutes a precise wait
    // for a backoff wait. It would cost a rAF loop that freezes in background
    // tabs. Reconsider only if a case appears where a click lands on a moving
    // element and the hit test still passes.
    const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
    };

    const pointerInit = (x: number, y: number, phase: "move" | "down" | "up"): PointerEventInit => ({
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
      pointerId: 1, pointerType: "mouse", isPrimary: true,
      button: phase === "move" ? -1 : 0, buttons: phase === "down" ? 1 : 0, pressure: phase === "down" ? 0.5 : 0,
    });

    // parentElement and contains() both stop dead at a shadow boundary, so a
    // control rendered inside a web component would never resolve to the
    // dialog or fixed layer that actually hosts it. Walk the COMPOSED tree
    // instead, which is what "is it inside" means visually.
    // assignedSlot comes FIRST: a slotted child's visual parent is the slot's
    // position inside the shadow tree, not its light-DOM parent — so for
    // <my-dialog><button slot="ok">, only the slot chain reaches the
    // [role=dialog] that my-dialog renders around it.
    // Terminates: a document root has no .host.
    const upward = (el: Element): Element | null =>
      el.assignedSlot ?? el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);
    const composedContains = (anc: Element, el: Element): boolean => {
      for (let n: Element | null = el; n; n = upward(n)) if (n === anc) return true;
      return false;
    };

    // pointerenter/mouseenter don't bubble, and a real pointer move makes the
    // browser fire them at EVERY ancestor between the old and new hover target
    // (outermost first) — dispatchEvent() only notifies the single node it's
    // called on. A hover-trigger listener bound on a wrapper above the
    // hit-tested point (e.g. a dropdown trigger wrapping an inner text span)
    // never sees a lone dispatch on the leaf. Walk the composed-tree ancestor
    // chain and fire one enter event per level to reproduce that cascade.
    const dispatchEnterChain = (t: Element, make: () => Event) => {
      const chain: Element[] = [];
      for (let n: Element | null = t; n; n = upward(n)) chain.push(n);
      for (let i = chain.length - 1; i >= 0; i--) chain[i].dispatchEvent(make());
    };

    // document.elementFromPoint RETARGETS its answer into the document tree: for
    // anything painted inside an open shadow root it returns the HOST, never the
    // node under the cursor. Every caller here reads that answer as "what is
    // actually at this point", so on a web-component page the hit test compares the
    // target against its own host and concludes something covers it. Each root
    // re-runs the test in ITS own tree, so descend until one stops moving.
    const deepElementFromPoint = (px: number, py: number): HTMLElement | null => {
      let el = document.elementFromPoint(px, py) as HTMLElement | null;
      for (let d = 0; el?.shadowRoot && d < 10; d++) {
        const inner = el.shadowRoot.elementFromPoint(px, py) as HTMLElement | null;
        if (!inner || inner === el) break;
        el = inner;
      }
      return el;
    };

    /** Climb one step, for the question "which control did the user point at": the
     *  light-DOM parent when there is one, otherwise OUT through the shadow
     *  boundary to the host. Deliberately NOT `upward`, which prefers assignedSlot
     *  and would route a slotted light-DOM node INTO the shadow tree — changing
     *  which element is chosen on ordinary markup that has nothing to do with the
     *  boundary this exists to cross. */
    const climbOut = (el: Element): Element | null =>
      el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);

    // Rotating scroll alignments, mirroring Playwright's _retryAction: a target
    // that is unreachable under one alignment is often reachable under another
    // (a sticky header and a sticky footer cover opposite edges).
    const SCROLL_BLOCKS: ScrollLogicalPosition[] = ["center", "start", "end"];
    const RETRY_WAITS = [0, 20, 100, 100, 500];
    const describeEl = (el: Element): string => {
      const cls = typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/)[0]
        : "";
      return `<${el.tagName.toLowerCase()}${cls}>`;
    };

    // ---- Action evidence ----------------------------------------------------
    // What the caller needs to distinguish "the handler ran and flipped
    // something" from "the event went nowhere". A mode toggle or a tab switch
    // moves none of captureSig's six axes, so without this the tool reports
    // "nothing changed" while the whole panel swapped.
    const STATE_ATTRS = ["aria-pressed", "aria-expanded", "aria-checked", "aria-selected", "class"];
    /** State an action could plausibly flip, on the element and a few ancestors —
     *  component libraries usually toggle a class on a wrapper, not on the button. */
    const readState = (el: Element): Map<string, string> => {
      const m = new Map<string, string>();
      let n: Element | null = el;
      for (let d = 0; n && d < 4; d++) {
        for (const a of STATE_ATTRS) m.set(`${d}|${a}`, n.getAttribute(a) ?? "");
        n = n.parentElement;
      }
      return m;
    };
    const diffState = (before: Map<string, string>, after: Map<string, string>): string[] => {
      const out: string[] = [];
      for (const [k, v] of before) {
        const w = after.get(k) ?? "";
        if (v === w) continue;
        const [d, attr] = k.split("|");
        const where = d === "0" ? "target" : `ancestor#${d}`;
        // class values can be long and noisy; that it changed is the signal.
        out.push(attr === "class" ? `${where} class changed` : `${where} ${attr}: ${v || "(unset)"} → ${w || "(unset)"}`);
      }
      return out;
    };
    const REPEAT_WINDOW_MS = 120_000;
    /** Record this element as acted-on; report how long ago it last was, if recent. */
    const noteAction = (el: Element): number | undefined => {
      const acts = (store.__bcpActs ??= []);
      const now = Date.now();
      let last: number | undefined;
      for (const a of acts) if (a.el.deref() === el && now - a.at < REPEAT_WINDOW_MS) last = now - a.at;
      acts.push({ el: new WeakRef(el), at: now });
      if (acts.length > 20) acts.shift();
      return last;
    };

    /** A cover is rarely total, and the retry loop only ever hit-tested the box
     *  CENTRE — so it reports failure while a corner of the same control is still
     *  exposed, which a coordinate click can take (the clip-path case in the
     *  regression harness scans for exactly such a point by hand). Scan the box and
     *  hand back a point that really resolves to the target; when none does, hand
     *  back a selector for the cover, VERIFIED to resolve back to it, so it can be
     *  waited out or acted on by name instead of by description. ~15 hit tests,
     *  paid once, on a path that has already failed. */
    const exposedPoint = (el: HTMLElement): { x: number; y: number } | null => {
      const r = el.getBoundingClientRect();
      for (let iy = 1; iy <= 3; iy++) {
        for (let ix = 1; ix <= 5; ix++) {
          const px = Math.round(r.left + (r.width * ix) / 6);
          const py = Math.round(r.top + (r.height * iy) / 4);
          if (px < 0 || py < 0 || px >= innerWidth || py >= innerHeight) continue;
          const at = deepElementFromPoint(px, py);
          if (at && (at === el || composedContains(el, at))) return { x: px, y: py };
        }
      }
      return null;
    };

    /** A modal is SUPPOSED to block what is behind it. Reaching around one via a
     *  corner that happens to peek out would defeat the page's own intent, so the
     *  auto-recovery below refuses when the cover belongs to a real dialog — and
     *  only then. An ordinary element overlapping its own sibling (a card over
     *  its corner control) carries no such intent. */
    const coverIsModal = (cover: HTMLElement): boolean =>
      visibleDialogs().some((d) => d === cover || composedContains(d, cover));

    const reachableHint = (el: HTMLElement, cover: HTMLElement): string => {
      const p = exposedPoint(el);
      if (p) return `\n  → retry as click {x:${p.x}, y:${p.y}} — that point on the target is still exposed`;
      // Name the shadow HOST, not the node inside it: only the host is reachable by
      // a document selector, and an unverifiable selector is worse than none.
      const root = cover.getRootNode();
      const named = root instanceof ShadowRoot ? (root.host as HTMLElement) : cover;
      const byId = named.id ? `#${CSS.escape(named.id)}` : "";
      const byClass = typeof named.className === "string" && named.className.trim()
        ? `${named.tagName.toLowerCase()}.${named.className.trim().split(/\s+/).map((c) => CSS.escape(c)).join(".")}`
        : named.tagName.toLowerCase();
      const sel = [byId, byClass].find((s) => s && document.querySelector(s) === named);
      return sel
        ? `\n  → no point on the target is exposed. The cover is ${sel} — wait_for {selector:"${sel}", state:"hidden"}, or act on it directly (a backdrop/consent layer usually closes on click)`
        : "\n  → no point on the target is exposed — the cover overlaps it completely";
    };

    /** Everything an action must do BEFORE it can dispatch: wait for the element
     *  to be actionable, scroll it into view, and resolve a point that really
     *  hit-tests to it. Extracted because only `click` ever had it — `type`,
     *  `select`, `drag` and `hover` dispatched into whatever was there, so an
     *  overlay over a login form meant typing into a field the user could not
     *  reach, reported as success. One pipeline is also the only way a new
     *  interaction (right-click, double-click) starts life with these guarantees
     *  instead of becoming the ninth action that has none of them. */
    type Reached = { x: number; y: number; target: HTMLElement; baseline: Sig; recovered?: string };
    const reachTarget = async (
      el: HTMLElement,
      what: string,
      timeoutMs = 5000,
      atPoint?: { x: number; y: number },
    ): Promise<Reached> => {
      const deadline = Date.now() + timeoutMs;
      let intercepts = 0;
      let lastCover = "";
      for (let attempt = 0; ; attempt++) {
        await waitActionable(el, Math.max(0, deadline - Date.now()));
        // A coordinate action must land on the point the caller named: the
        // element's centre may be somewhere else entirely (a canvas hot-spot, a
        // wide toolbar row), and scrolling would invalidate that point outright.
        if (!atPoint) {
          el.scrollIntoView({ block: SCROLL_BLOCKS[attempt % SCROLL_BLOCKS.length], inline: "center" });
          // Let the scroll pay off BEFORE any measurement below. It moves the box
          // synchronously, but the lazy loading it triggers rides on
          // IntersectionObserver, delivered in the rendering steps — so a same-turn
          // capture measures the page as it was before our own scroll landed, and
          // every row that then arrives inside withDelta's settle is billed to the
          // action as `±N elements`, i.e. exactly the interruption signal the tool
          // text teaches the agent to trust. Placed here rather than just before
          // the baseline on purpose: waiting AFTER the hit test would let the
          // reflow this wait absorbs invalidate x/y between the test and dispatch,
          // re-opening the race the interception check exists for. Skipped in a
          // hidden tab — rAF is frozen there and IntersectionObserver does not
          // deliver either, so there is nothing to exclude.
          if (!document.hidden) await afterNextPaint();
        }
        const r = el.getBoundingClientRect();
        let x = atPoint ? Math.round(atPoint.x) : Math.round(r.left + r.width / 2);
        let y = atPoint ? Math.round(atPoint.y) : Math.round(r.top + r.height / 2);
        let hit = deepElementFromPoint(x, y);
        let recovered: string | undefined;

        // Playwright's expectHitTarget rule: the hit passes when it IS the target
        // or a DESCENDANT of it, because the browser dispatches to whatever covers
        // the point. An ANCESTOR is not — it means the target is not actually
        // painted there. With clip-path the bounding-box centre can fall outside
        // the visible shape and elementFromPoint returns the card underneath;
        // dispatching anyway is the "clicked but nothing happened" that took three
        // sessions to explain.
        if (hit && hit !== el && !composedContains(el, hit)) {
          const cover = hit;
          const by = describeEl(cover);
          intercepts++;
          lastCover = by;
          // The centre is covered but the control may still be reachable. We
          // already compute that point to put it in the error; making the caller
          // re-issue it costs a round trip, another full retry loop, and depends
          // on it reading past the failure headline — it did not, in a recorded
          // session, for 70 seconds and two identical retries.
          const p = atPoint ? null : coverIsModal(cover) ? null : exposedPoint(el);
          if (p) {
            x = p.x; y = p.y;
            hit = deepElementFromPoint(x, y);
            recovered = `centre covered by ${by}; acted on (${x},${y}), still exposed`;
          } else {
            const wait = RETRY_WAITS[Math.min(attempt, RETRY_WAITS.length - 1)];
            if (Date.now() + wait >= deadline) {
              noteAction(el); // a failure is still an attempt — see noteAction
              throw new Error(
                `${what} intercepted: ${by} covers ${describeEl(el)}.` +
                reachableHint(el, cover) +
                `\n  (${intercepts} attempt(s) over ${timeoutMs}ms, all intercepted by ${lastCover})`,
              );
            }
            await sleep(wait);
            continue;
          }
        }
        // The element can go away between the actionability check and dispatch.
        if (!el.isConnected) throw new Error(`element was detached from the DOM before the ${what} could land`);
        // Baseline AFTER the scroll, not before: see ActOutcome.
        return { x, y, target: hit ?? el, baseline: captureSig(), recovered };
      }
    };

    /** Right-click. A synthetic contextmenu does NOT open Chrome's own menu —
     *  nothing an extension dispatches can — but a page with a custom context
     *  menu listens for exactly this event and calls preventDefault, which is
     *  also the signal that it handled it. Reported as defaultPrevented. */
    const realContextMenu = async (el: HTMLElement, timeoutMs = 5000): Promise<ActOutcome> => {
      const { x, y, target: t, baseline } = await reachTarget(el, "right-click", timeoutMs);
      const stateBefore = readState(el);
      const repeatedAfterMs = noteAction(el);
      const down = { ...pointerInit(x, y, "down"), button: 2, buttons: 2 };
      t.dispatchEvent(new PointerEvent("pointerdown", down));
      t.dispatchEvent(new MouseEvent("mousedown", down));
      t.dispatchEvent(new PointerEvent("pointerup", { ...pointerInit(x, y, "up"), button: 2 }));
      t.dispatchEvent(new MouseEvent("mouseup", { ...pointerInit(x, y, "up"), button: 2 }));
      const handled = !t.dispatchEvent(new MouseEvent("contextmenu", { ...pointerInit(x, y, "up"), button: 2, buttons: 2 }));
      await sleep(30);
      const stateChanged = diffState(stateBefore, readState(el));
      return {
        baseline,
        evidence: {
          ...(t !== el ? { dispatchedTo: describeEl(t) } : {}),
          ...(handled ? { defaultPrevented: true } : {}),
          ...(stateChanged.length ? { stateChanged } : {}),
          ...(repeatedAfterMs !== undefined ? { repeatedAfterMs } : {}),
        },
      };
    };

    /** Double-click. Per UI Events the second click carries detail:2 and the
     *  dblclick follows it — a handler bound to dblclick never fires if you just
     *  send two independent clicks with detail:1. */
    const realDblClick = async (el: HTMLElement, confirmed?: boolean, timeoutMs = 5000): Promise<ActOutcome> => {
      const label = (accessibleName(el) || (el as HTMLInputElement).value || el.getAttribute("title") || "").trim();
      if (!confirmed && RISKY.test(label))
        throw new Error(`risky action on "${label.slice(0, 40)}" — pass confirm:true to proceed (only if the user asked for this)`);
      const { x, y, target: t, baseline } = await reachTarget(el, "double-click", timeoutMs);
      const stateBefore = readState(el);
      const repeatedAfterMs = noteAction(el);
      for (const detail of [1, 2]) {
        t.dispatchEvent(new PointerEvent("pointerdown", pointerInit(x, y, "down")));
        t.dispatchEvent(new MouseEvent("mousedown", { ...pointerInit(x, y, "down"), detail }));
        if (detail === 1) t.focus?.();
        t.dispatchEvent(new PointerEvent("pointerup", pointerInit(x, y, "up")));
        t.dispatchEvent(new MouseEvent("mouseup", { ...pointerInit(x, y, "up"), detail }));
        t.dispatchEvent(new MouseEvent("click", { ...pointerInit(x, y, "up"), detail }));
      }
      const accepted = t.dispatchEvent(new MouseEvent("dblclick", { ...pointerInit(x, y, "up"), detail: 2 }));
      await sleep(30);
      const stateChanged = diffState(stateBefore, readState(el));
      return {
        baseline,
        evidence: {
          ...(t !== el ? { dispatchedTo: describeEl(t) } : {}),
          ...(accepted ? {} : { defaultPrevented: true }),
          ...(stateChanged.length ? { stateChanged } : {}),
          ...(repeatedAfterMs !== undefined ? { repeatedAfterMs } : {}),
        },
      };
    };

    /** Paste. A rich editor listens for `paste` and inserts the content itself,
     *  calling preventDefault; a plain field does not, and then the insertion is
     *  ours to perform. Doing only one of the two is why "paste" into a
     *  contentEditable either did nothing or double-inserted. */
    const realPaste = async (target: HTMLElement, text: string, timeoutMs = 5000): Promise<ActOutcome> => {
      const el = followLabel(target);
      await reachTarget(el, "paste", timeoutMs);
      el.focus();
      const editable = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (!editable && !el.isContentEditable)
        throw new Error(`${describeEl(el)} cannot receive a paste — it is not an editable element${innerControlHint(el, "editable")}`);
      const stateBefore = readState(el);
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const handledByPage = !el.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true, composed: true }),
      );
      const evidence: Partial<ActionDelta> = {};
      if (!handledByPage) {
        // The page let the default through, so WE are the default action.
        const ok = el.dispatchEvent(new InputEvent("beforeinput", {
          bubbles: true, cancelable: true, composed: true, inputType: "insertFromPaste", data: text,
        }));
        if (ok) {
          if (editable) setNativeValue(el, el.value + text);
          else el.textContent = (el.textContent ?? "") + text;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertFromPaste", data: text }));
        }
      } else {
        evidence.defaultPrevented = true; // the editor took it — do NOT also insert
      }
      await sleep(30);
      const after = editable ? el.value : (el.textContent ?? "");
      if (!after.includes(text)) evidence.valueMismatch = { requested: text, actual: after };
      const stateChanged = diffState(stateBefore, readState(el));
      if (stateChanged.length) evidence.stateChanged = stateChanged;
      return { evidence };
    };

    const RISKY = /(提交|删除|移除|清空|购买|下单|支付|付款|结算|发送|注销|退订|confirm|delete|remove|submit|\bpay\b|\bbuy\b|purchase|checkout|place\s*order|\bsend\b|sign\s*out|log\s*out|unsubscribe)/i;
    const realClick = async (
      el: HTMLElement,
      confirmed?: boolean,
      timeoutMs = 5000,
      atPoint?: { x: number; y: number },
    ): Promise<ActOutcome> => {
      // Soft safety gate: irreversible-looking clicks need explicit confirm:true.
      // accessibleName() also covers aria-label/title/alt, catching icon-only buttons.
      const label = (accessibleName(el) || (el as HTMLInputElement).value || el.getAttribute("title") || "").trim();
      if (!confirmed && RISKY.test(label)) {
        throw new Error(`risky action on "${label.slice(0, 40)}" — pass confirm:true to proceed (only if the user asked for this)`);
      }
      const { x, y, target: t, baseline, recovered } = await reachTarget(el, "click", timeoutMs, atPoint);
      const stateBefore = readState(el);
      const repeatedAfterMs = noteAction(el);

      // Humanized approach: a few pointermoves along a short jittered path in.
      if (human) {
        const steps = 3;
        for (let i = 1; i <= steps; i++) {
          const mx = Math.round(x - (steps - i) * rnd(6, 14) + rnd(-3, 3));
          const my = Math.round(y - (steps - i) * rnd(4, 10) + rnd(-3, 3));
          t.dispatchEvent(new PointerEvent("pointermove", { ...pointerInit(mx, my, "move"), button: 0 }));
          t.dispatchEvent(new MouseEvent("mousemove", { ...pointerInit(mx, my, "move"), button: 0 }));
          await sleep(rnd(15, 45));
        }
      }
      const move = { ...pointerInit(x, y, "move"), button: 0 };
      t.dispatchEvent(new PointerEvent("pointerover", pointerInit(x, y, "move")));
      dispatchEnterChain(t, () => new PointerEvent("pointerenter", { ...pointerInit(x, y, "move"), bubbles: false, composed: false }));
      t.dispatchEvent(new MouseEvent("mouseover", move));
      dispatchEnterChain(t, () => new MouseEvent("mouseenter", { ...move, bubbles: false }));
      t.dispatchEvent(new PointerEvent("pointermove", pointerInit(x, y, "move")));
      t.dispatchEvent(new MouseEvent("mousemove", move));
      t.dispatchEvent(new PointerEvent("pointerdown", pointerInit(x, y, "down")));
      t.dispatchEvent(new MouseEvent("mousedown", pointerInit(x, y, "down")));
      t.focus?.();
      if (human) await sleep(rnd(40, 120)); // press dwell
      t.dispatchEvent(new PointerEvent("pointerup", pointerInit(x, y, "up")));
      t.dispatchEvent(new MouseEvent("mouseup", pointerInit(x, y, "up")));
      // dispatchEvent returns false when a handler called preventDefault — that
      // is positive proof the page reacted, even when nothing visible changed.
      const accepted = t.dispatchEvent(new MouseEvent("click", { ...pointerInit(x, y, "up"), detail: 1 }));

      // Frameworks apply state asynchronously (microtask / nextTick), so reading
      // immediately after dispatch would still see the pre-click values.
      await sleep(30);
      const stateChanged = diffState(stateBefore, readState(el));
      return {
        baseline,
        evidence: {
          ...(t !== el ? { dispatchedTo: describeEl(t) } : {}),
          ...(recovered ? { recoveredVia: recovered } : {}),
          ...(accepted ? {} : { defaultPrevented: true }),
          ...(stateChanged.length ? { stateChanged } : {}),
          ...(repeatedAfterMs !== undefined ? { repeatedAfterMs } : {}),
        },
      };
    };

    // Move the synthetic pointer onto an element to reveal hover-only UI (tooltips,
    // mouseover menus). Same enter sequence as a click's approach, but no down/up —
    // nothing is activated.
    const realHover = async (el: HTMLElement): Promise<void> => {
      const { x, y, target: t } = await reachTarget(el, "hover");
      const move = { ...pointerInit(x, y, "move"), button: 0 };
      t.dispatchEvent(new PointerEvent("pointerover", pointerInit(x, y, "move")));
      dispatchEnterChain(t, () => new PointerEvent("pointerenter", { ...pointerInit(x, y, "move"), bubbles: false, composed: false }));
      t.dispatchEvent(new MouseEvent("mouseover", move));
      dispatchEnterChain(t, () => new MouseEvent("mouseenter", { ...move, bubbles: false }));
      t.dispatchEvent(new PointerEvent("pointermove", pointerInit(x, y, "move")));
      t.dispatchEvent(new MouseEvent("mousemove", move));
    };

    const PUNCT: Record<string, string> = {
      " ": "Space", "-": "Minus", "=": "Equal", ".": "Period", ",": "Comma", "/": "Slash",
      ";": "Semicolon", "'": "Quote", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash",
      "`": "Backquote", "\n": "Enter", "\t": "Tab",
    };
    const codeFor = (ch: string): string =>
      /[a-zA-Z]/.test(ch) ? "Key" + ch.toUpperCase() : /[0-9]/.test(ch) ? "Digit" + ch : PUNCT[ch] ?? "";
    const kbInit = (key: string, code: string): KeyboardEventInit => {
      const legacy = key.length === 1 ? key.toUpperCase().charCodeAt(0) : code === "Enter" ? 13 : 0;
      return { bubbles: true, cancelable: true, composed: true, key, code, keyCode: legacy, which: legacy } as unknown as KeyboardEventInit;
    };

    // The browser re-runs HTML value sanitization on EVERY value-setter call, so
    // any invalid intermediate is discarded. Assembling these types one
    // character at a time therefore silently produces garbage — measured in real
    // Chrome: "19.9" into input[type=number] lands "9", "-50" lands "50" with
    // the sign gone, date/time/month/week land "". Only whole-value assignment
    // works. (Playwright splits the same way in injectedScript's fill(); it
    // keeps `number` on the typing side only because it can push the whole
    // string through the CDP keyboard in one call, which we have no equivalent of.)
    const SET_VALUE_TYPES = new Set(["color", "date", "time", "datetime-local", "month", "range", "week"]);
    const TYPE_INTO_TYPES = new Set(["", "email", "number", "password", "search", "tel", "text", "url"]);

    /** followLabel covers the <label> case; the OTHER half of the same mistake is a
     *  styled wrapper (component libraries render a box around the real control,
     *  with no <label> anywhere), and all three "wrong kind of element" errors below
     *  are that mistake. The control is one query away and its [ref] from the last
     *  snapshot is the literal argument for the retry — hand that over instead of
     *  only naming what went wrong. When there is no such control the next step is a
     *  DIFFERENT TOOL, and naming it is the only useful thing left to say. */
    const CONTROL_SEL: Record<"select" | "file" | "editable", string> = {
      select: "select",
      file: 'input[type="file"]',
      editable: 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea, [contenteditable=""], [contenteditable="true"]',
    };
    const innerControlHint = (el: HTMLElement, kind: "select" | "file" | "editable"): string => {
      const inner = el.querySelector<HTMLElement>(CONTROL_SEL[kind]);
      if (inner) {
        const ref = store.__bcpRefOf?.get(inner);
        return ` — it CONTAINS ${describeEl(inner)}${ref ? `, [ref] "${ref}"` : ""}; retry against that${ref ? "" : " (snapshot it for its ref)"}`;
      }
      if (kind === "select")
        return " — select_option drives a native <select> only; for an Ant/Element/Arco-style dropdown use pick_option {ref, option}, which opens this trigger and clicks the option";
      if (kind === "file")
        return " — upload_file needs a real <input type=file> and there is none inside this element; a drop-zone-only uploader cannot be driven from here (a synthetic drag carries no file bytes)";
      if (el instanceof HTMLSelectElement) return " — use select_option (or pick_option for a custom dropdown)";
      const r = inferRole(el);
      if (r === "checkbox" || r === "radio" || r === "button" || r === "submit") return ` — a ${r} is driven with click, not type_text`;
      return " — type_text needs an <input>, <textarea> or contenteditable, and nothing inside this element is one";
    };

    // A styled wrapper or a <label> is a very common target for an agent that
    // located the visible thing rather than the control. Resolve to the element
    // that actually holds the value, like Playwright's retarget(node,'follow-label').
    const followLabel = (el: HTMLElement): HTMLElement => {
      if (
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement || el.isContentEditable
      ) return el;
      const control = (el.closest("label") as HTMLLabelElement | null)?.control as HTMLElement | null;
      return control ?? el;
    };

    const realType = async (target: HTMLElement, text: string, submit?: boolean, confirmed?: boolean): Promise<ActOutcome> => {
      const el = followLabel(target);
      // Through the shared pipeline: a cookie banner over a login form used to
      // mean typing into a field the user cannot reach, reported as success.
      // The resolved point is unused here (typing goes to focus, not to a
      // coordinate) — what matters is that the field is actually reachable.
      await reachTarget(el, "type");
      el.focus();
      const editable = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (!editable && !el.isContentEditable)
        throw new Error(`${describeEl(el)} is not an editable element${innerControlHint(el, "editable")}`);
      // Fail loudly rather than dispatching into a field that will ignore it.
      if (editable && el.readOnly) throw new Error("element is readonly");

      // Returns whether the form was ACTUALLY submitted. Both guards below fail
      // silently in the wild: a field outside any <form>, and an autocomplete
      // widget that preventDefaults Enter. The caller used to be told
      // "and submitted" purely because it had passed submit:true.
      const doSubmit = (): boolean => {
        const form = el.closest("form") as HTMLFormElement | null;
        const btn = form?.querySelector<HTMLElement>('[type="submit"], button:not([type])');
        const btnLabel = btn ? (accessibleName(btn) || (btn as HTMLInputElement).value || "").trim() : "";
        if (!confirmed && RISKY.test(btnLabel)) {
          throw new Error(`risky submit ("${btnLabel.slice(0, 40)}") — pass confirm:true (only if the user asked for this)`);
        }
        const enterOk = el.dispatchEvent(new KeyboardEvent("keydown", kbInit("Enter", "Enter")));
        el.dispatchEvent(new KeyboardEvent("keyup", kbInit("Enter", "Enter")));
        if (!enterOk || !form?.requestSubmit) return false;
        form.requestSubmit();
        return true;
      };

      if (el instanceof HTMLInputElement) {
        // el.type is the NORMALIZED type: an unknown type="foobar" reads "text",
        // which is also how the field actually behaves.
        const t = el.type.toLowerCase();
        if (!SET_VALUE_TYPES.has(t) && !TYPE_INTO_TYPES.has(t))
          throw new Error(`input[type=${t}] cannot be typed into — use click (checkbox/radio/button) or upload_file (file)`);
        if (SET_VALUE_TYPES.has(t) || t === "number") {
          const v = t === "color" ? text.trim().toLowerCase() : text.trim();
          if (t === "number" && v !== "" && isNaN(Number(v))) throw new Error(`"${v}" is not a valid number`);
          setNativeValue(el, v);
          // Read back: the sanitizer silently blanks or clamps a value it
          // rejects (out-of-range for range, malformed date, …). Without this
          // the caller would be told the field was filled when it was not.
          if (el.value !== v)
            throw new Error(`input[type=${t}] rejected "${v}" (field now reads "${el.value}") — check format/min/max`);
          el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: v }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return submit ? { evidence: { submitted: doSubmit() } } : {};
        }
      }

      // type_text SETS the field (like Playwright fill): clear any existing content first,
      // otherwise typing into a non-empty field would append (e.g. "Y" + "X" -> "YX").
      if (editable) {
        if (el.value) {
          setNativeValue(el, "");
          el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "deleteContentBackward" }));
        }
      } else if (el.textContent) {
        el.textContent = "";
      }
      for (const ch of text) {
        el.dispatchEvent(new KeyboardEvent("keydown", kbInit(ch, codeFor(ch))));
        if (editable) {
          const ok = el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: ch }));
          if (ok) {
            setNativeValue(el, el.value + ch);
            el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: ch }));
          }
        } else {
          document.execCommand("insertText", false, ch);
        }
        el.dispatchEvent(new KeyboardEvent("keyup", kbInit(ch, codeFor(ch))));
        // Human keystroke cadence: longer pause after space/punctuation.
        if (human) await sleep(/\s|[.,;!?]/.test(ch) ? rnd(90, 200) : rnd(35, 110));
      }
      if (editable) el.dispatchEvent(new Event("change", { bubbles: true }));
      const evidence: Partial<ActionDelta> = {};
      // The per-character loop already knows when a `beforeinput` handler
      // refused a character — it skips setNativeValue for exactly that reason —
      // but it never told the caller. An input mask that drops "." turns
      // "19.9" into "199" and the field reports success either way.
      if (editable && el.value !== text) evidence.valueMismatch = { requested: text, actual: el.value };
      if (submit) evidence.submitted = doSubmit();
      return { evidence };
    };

    /** Where this frame's viewport sits in the top window's viewport: the sum of each same-origin parent
     *  <iframe>'s content-box offset. null across an origin, where the offset cannot be read. */
    const frameOffset = (): { x: number; y: number; width: number; height: number } | null => {
      let x = 0;
      let y = 0;
      let w: Window = window;
      try {
        while (w !== w.top) {
          const fe = w.frameElement as HTMLElement | null;
          if (!fe) return null;
          const r = fe.getBoundingClientRect();
          const cs = (fe.ownerDocument.defaultView ?? window).getComputedStyle(fe);
          x += r.left + fe.clientLeft + parseFloat(cs.paddingLeft || "0");
          y += r.top + fe.clientTop + parseFloat(cs.paddingTop || "0");
          w = w.parent;
        }
        return { x, y, width: w.innerWidth, height: w.innerHeight };
      } catch {
        return null;
      }
    };

    const snapshot = () => {
      const topView = frameOffset();
      const newRefs = new Map<string, Element>();
      const elements: SnapshotElement[] = [];
      let i = 0;
      // Recursive walker that pierces OPEN shadow roots (web components / Salesforce /
      // YouTube etc. render controls inside shadow DOM that a flat query never sees).
      const collected = new Set<Element>();
      // Bespoke clickables captured only by their cursor:pointer style (no native
      // tag/role/tabindex to select on) — tracked so we can flag them [clickable].
      const customClickable = new Set<Element>();
      // cursor:pointer per node, memoized so the parent test is a lookup rather
      // than a second style read. (This walk is O(N) getComputedStyle either
      // way — the memo removes the parent re-read, it does not halve the total.)
      const pointerCache = new Map<Element, boolean>();
      // Elements that establish a fixed/sticky LAYER, gathered during this same
      // walk at no extra cost, so zoneOf can find a control's layer by walking
      // ancestors instead of reading style per ancestor on demand.
      const fixedLayers = new Set<Element>();
      const collect = (root: Document | ShadowRoot) => {
        for (const el of root.querySelectorAll(SNAP_SELECTOR)) collected.add(el);
        for (const host of root.querySelectorAll("*")) {
          const sr = (host as HTMLElement).shadowRoot;
          if (sr) collect(sr); // open shadow root only; closed roots are unreachable (no CDP)
          // ONE getComputedStyle per node, read for two purposes: several reads
          // off one live declaration cost a single style resolution, so folding
          // the layer probe in here is free.
          const st = getComputedStyle(host);
          pointerCache.set(host, st.cursor === "pointer");
          if (st.position === "fixed") fixedLayers.add(host);
          else if (st.position === "sticky") {
            // A sticky element that has not stuck yet is ordinary in-flow
            // content; it only becomes a layer once pinned to an edge.
            const r = host.getBoundingClientRect();
            if (r.top <= 1 || r.bottom >= innerHeight - 1) fixedLayers.add(host);
          }
          // React/Vue onClick is a delegated listener (no onclick attr). cursor:pointer
          // inherits, so the OUTERMOST pointer element is the real clickable — capture
          // that (its inherited icon/text descendants are skipped) so <div> buttons aren't invisible.
          if (collected.has(host) || st.cursor !== "pointer") continue;
          const par = host.parentElement;
          if (par && pointerCache.get(par)) continue; // parent is pointer too → not outermost
          collected.add(host);
          customClickable.add(host);
        }
      };
      collect(document);

      // Pass 1: assign every ref up front so parentRef resolves regardless of
      // collection order (a parent may be collected after its child).
      //
      // An element that survives KEEPS the ref it had. Refs used to be pure
      // document position, renumbered on every snapshot, which cost twice: the
      // caller's refs all went stale on any re-render (its own description said
      // so), and nothing could be compared across two snapshots — so every read
      // handed back the whole page with no indication of what was new. Identity
      // is what makes both fixable, and the reverse map that provides it was
      // already being published for page_state.
      const prevRefOf = store.__bcpRefOf;
      let seq = store.__bcpRefSeq ?? 0;
      const elToRef = new WeakMap<Element, string>();
      for (const el of collected) {
        const ref = prevRefOf?.get(el) ?? `e${++seq}`;
        newRefs.set(ref, el);
        elToRef.set(el, ref);
      }
      const parentRefOf = (el: Element): string | undefined => {
        let p = el.parentElement;
        while (p) {
          const r = elToRef.get(p);
          if (r) return r;
          p = p.parentElement;
        }
        return undefined;
      };
      // ---- The edge the author wrote down. aria-controls / aria-owns /
      // popovertarget all name a container BY ID, and all three are the page
      // saying "this control opens that" — not a heuristic. Resolving them is
      // what keeps a portaled panel findable: `expanded` already reports that a
      // disclosure opened, and the panel it opened is routinely a <body> child
      // sitting nowhere near its trigger, so nesting cannot lead back to it and
      // the caller is left re-scanning the whole new list by role/name.
      //
      // Ids are resolved against the element's OWN root, not `document`: inside
      // a shadow root an id is scoped to that root, so a document-level lookup
      // silently misses (or worse, finds a same-id element in the light DOM).
      // Space-separated lists are legal for aria-controls/aria-owns; popovertarget
      // is a single id, which the same split handles as a list of one.
      //
      // The cast is safe rather than hopeful: collect() walks from `document`
      // and through shadow roots only, and nothing awaits between it and here,
      // so every element reaching this point is connected and its root is a
      // Document or a ShadowRoot — both of which carry getElementById. A
      // runtime guard for the remaining case would be unreachable, and an
      // unreachable guard is one no mutation can prove.
      const CONTROLS_ATTRS = ["aria-controls", "aria-owns", "popovertarget"];
      const controlsOf = (el: Element): string[] | undefined => {
        const out: string[] = [];
        const root = el.getRootNode() as Document | ShadowRoot;
        for (const attr of CONTROLS_ATTRS) {
          const raw = el.getAttribute(attr);
          if (!raw) continue;
          for (const id of raw.split(/\s+/)) {
            if (!id) continue;
            const target = root.getElementById(id);
            // Only refs that are IN this snapshot: a target that was not
            // collected is not actionable, and emitting a dangling id would be
            // an edge the caller cannot follow.
            const ref = target ? elToRef.get(target) : undefined;
            if (ref && !out.includes(ref)) out.push(ref);
          }
        }
        return out.length ? out : undefined;
      };
      // ---- Visual placement. The DOM tree carries nesting, not geometry: a
      // modal portaled to <body> sits at tree depth 1 while covering the whole
      // screen, so an agent reading the tree alone cannot tell what is on top,
      // what is behind it, or which controls belong together on screen. ----
      const openDialogs = visibleDialogs().map((d) => ({ el: d, name: truncate(accessibleName(d), 40) }));
      const zoneOf = (el: Element): string | undefined => {
        for (const d of openDialogs) if (composedContains(d.el, el)) return d.name ? `dialog:${d.name}` : "dialog";
        // A control lives INSIDE a fixed layer far more often than it IS the
        // fixed element (a nav bar is fixed; its buttons are static). Walk up to
        // the layer — mirroring the containment walk the dialog branch above
        // already does — and classify by the LAYER's box, not the control's.
        let layer: Element | null = el;
        while (layer && !fixedLayers.has(layer)) layer = upward(layer);
        if (!layer) return undefined;
        const r = layer.getBoundingClientRect();
        if (r.bottom < innerHeight * 0.25) return "fixed-top";
        if (r.top > innerHeight * 0.75) return "fixed-bottom";
        if (r.right < innerWidth * 0.3) return "fixed-left";
        return "fixed";
      };
      // NOTE: there is deliberately no per-element occlusion probe here.
      // "Can this be clicked right now" is answered at ACTION time, on the one
      // element being acted on — realClick already hit-tests and falls back to
      // the real ref when an overlay covers it. Playwright draws the same line
      // (its Receives-Events check runs in _checkFrameIsHitTarget just before
      // the pointer sequence, never across a snapshot): a hit test per element
      // costs an order of magnitude more than the rect/style reads around it
      // and answers a question nobody asks until they act. The @dialog:<name>
      // zone below already tells an agent which controls belong to an open
      // modal, which is what it actually needs while perceiving.
      // accessibleName falls back to innerText, which on a grouping node returns
      // every descendant's text glued together. Detect that origin so such names
      // can be flagged instead of burying the real targets under a 120-char blob.
      const nameFromText = (el: Element): boolean =>
        !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby") &&
        !(el as HTMLInputElement).placeholder && !el.getAttribute("alt") && !el.getAttribute("title");

      // Pass 2: build each element with geometry, parent link and visual zone.
      for (const el of collected) {
        // One rect + one style read per element, shared by the scrollable probe
        // and the viewport test below. (Visibility used to share them too; it now
        // calls isVisible, which takes its own — see the note there for why the
        // duplicated rule was worse than the duplicated read.)
        const rct = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        // Was an INLINE copy of the visibility rule, which is how it silently
        // kept the old semantics after isVisible was corrected — check:dom's V
        // group caught it. It costs one extra getBoundingClientRect inside
        // isVisible (the layout is already clean, so it is a cache hit), and
        // that is worth more than a predicate that only LOOKS like the others.
        const visible = isVisible(el);
        // Never drop an element — a hidden/disabled node is still worth perceiving
        // (e.g. a file <input> concealed behind a styled button). Mark state instead.
        const hidden = !visible || undefined;
        const disabled = (el as HTMLInputElement).disabled || undefined;
        const clickable = customClickable.has(el) || undefined;
        const ref = elToRef.get(el)!;
        const value = (el as HTMLInputElement).value;
        const input = el as HTMLInputElement;
        const isCheck = el.tagName === "INPUT" && (input.type === "checkbox" || input.type === "radio");
        const sel = el instanceof HTMLSelectElement
          ? [...el.options].slice(0, 50).map((o) => truncate(o.textContent ?? o.value, 40)) // cap: a country <select> can have 200+
          : undefined;
        const scrollable =
          el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(style.overflowY + " " + style.overflow)
            ? true
            : undefined;
        const expandedAttr = el.getAttribute("aria-expanded");
        const expanded = expandedAttr === "true" ? true : expandedAttr === "false" ? false : undefined;
        const invalid =
          el.getAttribute("aria-invalid") === "true" || input.validity?.valid === false ? true : undefined;
        let invalidMessage: string | undefined;
        if (invalid) {
          const desc = el.getAttribute("aria-describedby");
          const m = desc
            ? desc.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" ")
            : "";
          if (m) invalidMessage = truncate(m, 80);
        }
        const busy = el.getAttribute("aria-busy") === "true" ? true : undefined;
        const role = inferRole(el);
        const name = truncate(accessibleName(el), 120);
        // Judged in the TOP viewport: inside a frame, the frame's own viewport says nothing about what the user
        // sees, and a frame-local box does not line up with a screenshot or click({x,y}).
        const box = topView ? { left: rct.left + topView.x, top: rct.top + topView.y, right: rct.right + topView.x, bottom: rct.bottom + topView.y } : null;
        const inViewport = box
          ? rct.bottom > 0 && rct.right > 0 && rct.top < innerHeight && rct.left < innerWidth &&
            box.bottom > 0 && box.right > 0 && box.top < topView!.height && box.left < topView!.width
          : undefined;
        elements.push({
          ref, tag: el.tagName.toLowerCase(), role,
          name, value: value ? truncate(value, 60) : undefined,
          checked: isCheck ? input.checked : undefined,
          options: sel,
          scrollable,
          expanded, invalid, invalidMessage, busy, hidden, disabled, clickable,
          inViewport, parentRef: parentRefOf(el), controls: controlsOf(el),
          // Geometry, but only while on screen — an off-screen box is a number
          // that looks authoritative and means nothing. This is what lets an
          // agent tie something it SAW in a screenshot to a ref it can act on.
          rect: inViewport && box
            ? [Math.round(box.left), Math.round(box.top), Math.round(rct.width), Math.round(rct.height)]
            : undefined,
          zone: zoneOf(el),
          // Only a role-less, non-clickable node can be a pure grouping wrapper.
          // A <button>/<a> containing a snapshotted child (an icon <span
          // role="img">) is still the real target — and so is a cursor:pointer
          // <div>, which collect()'s outermost-pointer rule already identified
          // as the clickable body. Flagging either would have the tool text tell
          // the agent to act on its children instead of on the control itself.
          container: (role === "generic" && !clickable && nameFromText(el)) || undefined,
        });
      }
      // Pass 3: a ref that others point at is a GROUPING node. Combined with the
      // role-less + innerText-named test above, that identifies a wrapper whose
      // name is merely its descendants' text concatenated. Flag only — `name` is
      // deliberately left INTACT, because orchestrator's elementName predicate
      // matches against it; the renderer shortens it for display instead.
      const isParent = new Set<string>();
      for (const e of elements) if (e.parentRef) isParent.add(e.parentRef);
      for (const e of elements) if (!isParent.has(e.ref)) e.container = undefined;

      // Publish both maps together, only once the snapshot is fully built: a
      // throw partway through must not leave an emptied ref map paired with the
      // previous generation's reverse index (which would also pin its detached
      // nodes indefinitely).
      store.__bcpRefs = newRefs;
      store.__bcpRefOf = elToRef;
      store.__bcpRefSeq = seq;

      // What is NEW since this observer last looked. Without it every snapshot
      // arrives as an undifferentiated full page and the caller has to re-scan
      // all of it to find the one control that appeared — which is the whole
      // cost of a read, paid again on every beat.
      const seenStore = (store.__bcpSnapSeen ??= {});
      const key = params.deltaKey ?? "_";
      const prevSeen = params.resetDelta ? undefined : seenStore[key];
      const nowRefs = elements.map((e) => e.ref);
      seenStore[key] = nowRefs;
      let changed: { added: string[]; removed: number } | undefined;
      if (prevSeen) {
        const before = new Set(prevSeen);
        const added = nowRefs.filter((r) => !before.has(r));
        const now = new Set(nowRefs);
        const removed = prevSeen.filter((r) => !now.has(r)).length;
        if (added.length || removed) changed = { added, removed };
      }

      const se = document.scrollingElement ?? document.documentElement;
      const moreBelow = se.scrollTop + se.clientHeight < se.scrollHeight - 4;
      return { url: location.href, title: document.title, elements, moreBelow, changed };
    };

    // ---- Descriptive locators -------------------------------------------
    // A `ref` names an element as it was AT SNAPSHOT TIME; after a re-render,
    // a portal, or a virtual list recycling its rows it is gone, and the agent
    // has to re-snapshot just to name the thing again. A description is
    // re-resolved AT ACTION TIME instead, which is the single biggest reason
    // Playwright's locators feel seamless. Deliberately NOT ARIA-centric: role
    // is only one of the filters, and `text`/`css` work on markup with zero
    // accessibility attributes — which is most of what we drive.
    //
    // Scope note: these resolve in the frame the RPC targets, which is the main
    // frame when no ref was supplied. Elements inside iframes still need a ref.

    const SKIP_TEXT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "HEAD", "TEMPLATE"]);
    // Zero-width space and soft hyphen show up in real UI labels and would
    // silently defeat an exact match.
    const normText = (s: string): string => s.replace(/[​­]/g, "").replace(/\s+/g, " ").trim();

    /** Text as a user perceives it, memoized per call.
     *  Not textContent (drags in <script>/<style>), not innerText (forces a
     *  reflow on every call — quadratic across a scan — and applies
     *  text-transform, so a CSS-uppercased label stops matching its source). */
    const makeTextOf = () => {
      const cache = new Map<Element, string>();
      const textOf = (el: Element): string => {
        const hit = cache.get(el);
        if (hit !== undefined) return hit;
        let out = "";
        if (!SKIP_TEXT_TAGS.has(el.tagName)) {
          if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button" || el.type === "reset")) {
            out = el.value ?? ""; // these carry their label in .value, with no child text
          } else {
            for (const n of el.childNodes) {
              if (n.nodeType === 3) out += n.nodeValue ?? "";
              else if (n.nodeType === 1) out += textOf(n as Element);
            }
            const sr = (el as HTMLElement).shadowRoot;
            if (sr) for (const c of sr.children) out += textOf(c);
          }
        }
        cache.set(el, out);
        return out;
      };
      return textOf;
    };

    /** Max gap (px) between a candidate and its `near` anchor. Playwright's
     *  :near defaults to 50 and its directional selectors are unbounded; for an
     *  agent-facing API an unbounded one would match across the whole viewport,
     *  and 50 is too tight for a table row's action buttons. */
    /** Cap on the edge-to-edge distance to the anchor.
     *  Raising this to 1000 with an anisotropic weight was tried and reverted:
     *  measured, it reached 1000px sideways but only 333px vertically, so on a
     *  wide viewport it crossed into an unrelated panel and picked the wrong
     *  control while excluding the correct one directly below the anchor.
     *  A tight isotropic cap refuses instead of guessing — and refusing is the
     *  behaviour `near` should have when the anchor genuinely fails to narrow. */
    const NEAR_MAX_PX = 200;

    /** The elements that carry `want` as text, innermost first.
     *  A loose match keeps the documented rule (below): an invisible descendant holding the text
     *  displaces its ancestor, because text nobody can see must not resolve to the container around it.
     *  An exact match means the label the user reads. textContent counts text that is not rendered, so a visible
     *  control holding a display:none hover panel (zhipin's header 登录/注册) never equals its own label while
     *  hidden copies elsewhere do. So exact compares the full text OR the rendered text (innerText, which leaves
     *  out display:none / visibility:hidden descendants), and only a RENDERED child can displace its parent —
     *  the parent's rendered text already proves the label is what the user sees there. innerText lays out, so
     *  it is read only for elements no rendered child displaces, which excludes every outer container. */
    const matchText = (els: HTMLElement[], want: string, exact: boolean | undefined, textOf: (el: Element) => string): HTMLElement[] => {
      const full = (el: Element) => normText(textOf(el)).toLowerCase();
      if (!exact) {
        // Deliberately NOT visibility-aware. Requiring the displacing child to be visible was tried and reverted:
        // it stopped an invisible descendant from eliminating its ancestor, and the query then resolved to that
        // ancestor — a layout container "showing" text nobody can see. Clicking it is worse than refusing: with a
        // label like 删除账户 the risk gate would fire on text the user never saw. When the only copy of the text
        // is invisible, "nothing matches" is the correct answer. (Exact is different: the parent's own rendered
        // text equals the label, so the user does see it there.)
        const holders = els.filter((el) => full(el).includes(want));
        return holders.filter((el) => ![...el.children].some((c) => full(c).includes(want)));
      }
      // "Rendered", not isVisible: a zero-height wrapper around an absolutely positioned control has no box of
      // its own but its text is on screen, and must still displace the <body> around it.
      const rendered = (c: Element) => {
        const check = (c as Element & { checkVisibility?: (o?: Record<string, boolean>) => boolean }).checkVisibility;
        return typeof check === "function" ? check.call(c, { visibilityProperty: true, checkVisibilityCSS: true }) : getComputedStyle(c).display !== "none";
      };
      const displaced = (el: Element) => [...el.children].some((c) => full(c).includes(want) && rendered(c));
      return els.filter((el) => {
        const t = full(el);
        if (!t.includes(want) || displaced(el)) return false;
        return t === want || normText((el as HTMLElement).innerText ?? "").toLowerCase() === want;
      });
    };

    const locate = (q: typeof params, includeHidden = false): { matches: HTMLElement[]; how: string } => {
      const textOf = makeTextOf();
      const how: string[] = [];

      let pool: HTMLElement[];
      if (q.css) {
        pool = [...document.querySelectorAll<HTMLElement>(q.css)];
        how.push(`css=${q.css}`);
      } else {
        pool = [...document.querySelectorAll<HTMLElement>("*")];
      }
      if (q.role) {
        pool = pool.filter((el) => inferRole(el) === q.role);
        how.push(`role=${q.role}`);
      }
      if (q.name) {
        const want = normText(q.name).toLowerCase();
        pool = pool.filter((el) => {
          // Name-from-content applies only to roles that support it (accname
          // §5.3). Allowing it on a role-less container would let <html> and
          // <body> be "named" by every word on the page, so any `name` query
          // would match the document root before the control it meant.
          if (inferRole(el) === "generic") {
            const explicit = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") ||
              el.getAttribute("alt") || el.getAttribute("title");
            if (!explicit) return false;
          }
          const n = normText(accessibleName(el)).toLowerCase();
          return n ? (q.exact ? n === want : n.includes(want)) : false;
        });
        how.push(`name=${JSON.stringify(q.name)}`);
      }
      if (q.text) {
        pool = matchText(pool, normText(q.text).toLowerCase(), q.exact, textOf); // the deepest holder of the text
        how.push(`text=${JSON.stringify(q.text)}`);
      }
      // Visibility last: moving it earlier changed no result (the set is
      // order-independent) and made a text-only query run isVisible over every
      // element in the document instead of the handful the text filter left.
      // includeHidden is the failure path re-asking THIS query what it would have
      // matched without the filter: "present but not displayed" and "not on this
      // page" demand opposite responses from the caller, and the filtered result
      // cannot tell them apart. It must reach the ANCHOR scan too — otherwise a
      // query carrying `near` dies on the throw below and whyNothing reports the
      // wrong cause entirely.
      if (!includeHidden) pool = pool.filter((el) => isVisible(el));

      if (q.near) {
        const want = normText(q.near).toLowerCase();
        // `exact` applies here too, with the same notion of the label the user reads.
        const anchors = matchText([...document.querySelectorAll<HTMLElement>("*")].filter((el) => includeHidden || isVisible(el)), want, q.exact, textOf);
        if (!anchors.length)
          throw new Error(
            `near: no visible element matching ${JSON.stringify(q.near)}` +
            // The anchor failed; the rest of the query did not, and its survivors
            // are already in hand. Handing them over turns a dead end into the same
            // explicit choice the strict branch offers. (No guard is bypassed here:
            // an anchor that matches NOTHING was never narrowing anything.)
            (pool.length
              ? ` — the other criteria still match ${pool.length}:\n${listCandidates(pool, 5)}\n  → fix the anchor text, or pass nth (0-based) to pick one deliberately`
              : " — and the other criteria match nothing either, so the anchor is not what failed"),
          );
        // Several anchors are allowed on purpose: a heading plus the same text
        // inside a row is ubiquitous, and refusing that broke calls that worked.
        // The gap is minimised over all anchors, so the nearest pairing wins.
        // (Refusing was tried and reverted; the only escape hatch would have been
        // `exact`, which is shared with `text` and cannot tighten the anchor alone.)
        // The distance is plain and isotropic. Weighting dy 3× to encode "near
        // means same row" was tried and reverted: combined with the cap it
        // reached ~1000px sideways but only ~333px down, so it would pair an
        // anchor with an unrelated control clear across the viewport while
        // refusing one just below. A short symmetric radius refuses both.
        const gap = (el: HTMLElement): number => {
          const a = el.getBoundingClientRect();
          let best = Infinity;
          for (const an of anchors) {
            const b = an.getBoundingClientRect();
            const dx = Math.max(0, a.left - b.right, b.left - a.right);
            const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
            best = Math.min(best, Math.hypot(dx, dy));
          }
          return best;
        };
        const ranked = pool
          .map((el) => [el, gap(el)] as const)
          .sort((x, y) => x[1] - y[1]);
        const scored = ranked.filter(([, d]) => d <= NEAR_MAX_PX);
        // The cap refusing is correct (see above, and the harness pins it). What was
        // wrong is that "nothing matches" hid the one number that decides the next
        // move: the caller cannot see the layout and does not know the cap, so it
        // re-words a locator whose only defect is an anchor on the far side of the
        // viewport. Reported, NOT relaxed — the excluded candidate is deliberately
        // not named, because naming it is how the reverted anisotropic version
        // handed out a wrong control.
        if (ranked.length && !scored.length)
          throw new Error(
            `near: the closest element matching the other criteria is ${Math.round(ranked[0][1])}px from ` +
            `${JSON.stringify(q.near)}; near only pairs within ${NEAR_MAX_PX}px — name an anchor beside the target ` +
            `(its own row or cell, not the section heading), or drop near and disambiguate with nth/css, ` +
            `which are explicit choices rather than the pairing this cap refused`,
          );
        // `near` IS the disambiguation the caller asked for, so collapse to the
        // closest candidate — otherwise every repeated control in a list would
        // still trip strictness and `near` would buy nothing. But only when the
        // winner is unambiguously closest: a tie means the anchor did not
        // actually separate them, and picking one then is exactly the guess
        // strictness exists to prevent.
        pool = scored.length > 1 && scored[0][1] < scored[1][1]
          ? [scored[0][0]]
          : scored.map(([el]) => el);
        how.push(`near=${JSON.stringify(q.near)}`);
      }
      return { matches: pool, how: how.join(" + ") || "(no criteria)" };
    };

    /** The numbered candidate list the strict branch prints. Every other dead end
     *  here wants the same thing: an agent that cannot see the page can only
     *  choose between things it has been shown. */
    const listCandidates = (els: HTMLElement[], cap: number): string =>
      els.slice(0, cap).map((el, i) => {
        const nm = truncate(accessibleName(el) || textOf0(el), 60);
        return `  ${i}) ${inferRole(el)}${nm ? ` "${nm}"` : ""} ${describeEl(el)}`;
      }).join("\n") + (els.length > cap ? `\n  … ${els.length - cap} more` : "");

    // How this element could be named by a Locator. Text is dropped when it
    // just repeats the accessible name — two identical dimensions look like
    // corroboration without being any.
    const dimsOf = (el: HTMLElement) => {
      const d: { role?: string; name?: string; text?: string; css?: string } = {};
      const role = inferRole(el);
      if (role) d.role = role;
      const name = accessibleName(el);
      if (name) d.name = truncate(name, 60);
      const text = textOf0(el);
      if (text && text !== name) d.text = truncate(text, 60);
      if (el.id) d.css = "#" + el.id;
      return d;
    };

    // The same candidates listCandidates renders for a human, as data. A locator
    // that stopped matching is exactly when something upstream may want to pick
    // a different way in, and parsing that back out of the message text would be
    // both fragile and lossy.
    const candidatesOf = (els: HTMLElement[], cap: number) => els.slice(0, cap).map(dimsOf);

    // How the element that a locator DID reach could also have been named.
    //
    // A book records one or two dimensions, so the first thing that changes on
    // the page ends the run — there is no second way in. These are read at the
    // one moment the answer is certain: the element is in hand, and it is the
    // right one because the locator that found it is the one the author wrote.
    // Set on the way out of locateOne; read once by the op that asked.
    //
    // Scoped to this call, not to the module — every invocation of the runtime
    // gets a fresh one. So it needs no reset: an op that reaches its element by
    // ref or by coordinate simply leaves it undefined and reports nothing,
    // rather than inheriting whatever a previous call resolved. (Worth stating
    // because the opposite looks true at a glance, and a reset "for safety"
    // would only imply a sharing that does not exist.)
    let lastResolved: ReturnType<typeof dimsOf> | undefined;
    const resolved = (el: HTMLElement): HTMLElement => {
      const d = dimsOf(el);
      lastResolved = Object.keys(d).length ? d : undefined;
      return el;
    };
    const withResolved = <T extends object>(out: T): T =>
      lastResolved ? ({ ...out, resolved: lastResolved } as T) : out;

    // Locator failures carry a code so the caller can branch on WHAT failed
    // rather than on how the sentence reads. The message is unchanged — it is
    // still the thing a person reads — these ride alongside it. Property names
    // are prefixed because this Error crosses into the extension's own code.
    // The codes are string literals rather than an import: this whole function
    // is serialised by executeScript and cannot import anything. `RpcErrorCode`
    // in @bcp/shared is the type side of the same contract; check:dom asserts
    // they still agree.
    const locErr = (
      code: "LOCATOR_NO_MATCH" | "LOCATOR_AMBIGUOUS" | "LOCATOR_NTH_RANGE",
      message: string,
      candidates?: ReturnType<typeof candidatesOf>,
      relaxedBy?: string,
    ): Error => {
      const e = new Error(message) as Error & {
        bcpCode?: string;
        bcpCandidates?: unknown;
        bcpRelaxedBy?: string;
      };
      e.bcpCode = code;
      if (candidates && candidates.length) e.bcpCandidates = candidates;
      if (relaxedBy) e.bcpRelaxedBy = relaxedBy;
      return e;
    };

    /** Why a query matched nothing — the most frequent failure here, and the one
     *  that told the caller least. Each branch RE-RUNS the same locator with
     *  exactly ONE thing relaxed, so what comes back names the single parameter to
     *  change instead of leaving five to re-guess. Paid only after the call has
     *  already failed. Returns "" when no probe fires: a longer message that
     *  narrows nothing is worse than a short one.
     *  `near` is deliberately NOT relaxable here. Its cap reports its own measured
     *  distance (see locate), and re-offering the candidates that cap refused
     *  would undo a guard that was added after a measured mis-click. */
    const RELAXABLE = ["css", "role", "name", "text"] as const;
    // `probe` is an out-parameter, not a return value, because every caller but
    // one wants only the sentence. The one that wants more is the throw site:
    // "dropping X brings the matches back" names the dimension that broke and
    // the elements it was hiding — the two things a fallback needs, and both
    // already computed here purely to phrase the explanation.
    const whyNothing = (q: typeof params, probe?: { key?: string; els?: HTMLElement[] }): string => {
      const run = (qq: typeof params, includeHidden = false): HTMLElement[] => {
        try {
          return locate(qq, includeHidden).matches;
        } catch {
          return []; // a probe must never replace the real failure with its own
        }
      };
      // Dropping the ONLY criterion just matches the page, and a drop that still
      // leaves dozens of candidates has narrowed nothing — neither earns a line.
      const given = RELAXABLE.filter((k) => q[k]);
      let best: { key: string; els: HTMLElement[] } | undefined;
      if (given.length > 1) {
        for (const k of given) {
          const relaxed = { ...q };
          delete relaxed[k];
          const els = run(relaxed);
          if (els.length && els.length <= 8 && (!best || els.length < best.els.length)) best = { key: k, els };
        }
      }
      if (best) {
        if (probe) { probe.key = best.key; probe.els = best.els; }
        return `\n  without ${best.key} it matches ${best.els.length}:\n${listCandidates(best.els, 5)}` +
          `\n  → ${best.key} is what excluded them: drop it, or set it to a value one of the candidates above actually has`;
      }

      const hidden = run(q, true);
      const option = hidden.find((el) => el instanceof HTMLOptionElement) as HTMLOptionElement | undefined;
      if (option) {
        // A closed <select>'s options have no box at all, so "reveal it" is not the
        // answer here — a different tool is.
        const sel = option.closest("select");
        const ref = sel ? store.__bcpRefOf?.get(sel) : undefined;
        return `\n  → that text is an <option>${sel ? ` inside a <select>${ref ? ` [ref] "${ref}"` : " (snapshot it for its ref)"}` : ""}:` +
          ` an <option> is never clickable — choose it with select_option {ref, values:[…]}`;
      }
      if (hidden.length)
        return `\n  ${hidden.length} element(s) match every criterion but are NOT displayed:\n${listCandidates(hidden, 5)}` +
          `\n  → the description is right and the page state is not; re-wording will not change that${openerFor(hiddenCause(hidden[0]))}`;

      // A description resolves in the MAIN frame only — a [ref] carries its frame
      // id, a description has nowhere to put one. Only VISIBLE iframes are counted:
      // a 0×0 analytics beacon sits on most pages and would fire this line
      // everywhere. snapshot pierces frames and hands back "42_e7"-style refs.
      const frames = [...document.querySelectorAll("iframe")].filter((f) => isVisible(f)).length;
      if (frames)
        return `\n  → nothing in this frame matches, and ${frames} visible iframe(s) here were NOT searched:` +
          ` a description resolves in the main frame only. snapshot covers every frame and returns sub-frame refs like "42_e7" — act by [ref] instead`;
      return "";
    };

    /** Resolve to exactly one element, or fail with the candidates listed.
     *  Silently taking the first match is how an agent ends up clicking the
     *  wrong row; Playwright is strict by default for the same reason. */
    const locateOne = (q: typeof params, opName: string, includeHidden = false): HTMLElement => {
      const { matches, how } = locate(q, includeHidden);
      if (!matches.length) {
        const probe: { key?: string; els?: HTMLElement[] } = {};
        const why = whyNothing(q, probe);
        throw locErr(
          "LOCATOR_NO_MATCH",
          `${opName}: nothing matches ${how}${why}`,
          probe.els ? candidatesOf(probe.els, 10) : undefined,
          probe.key,
        );
      }
      if (q.nth !== undefined) {
        const picked = matches[q.nth];
        if (!picked)
          throw locErr(
            "LOCATOR_NTH_RANGE",
            `${opName}: nth=${q.nth} is out of range — ${matches.length} match(es) for ${how}:\n${listCandidates(matches, 10)}`,
            candidatesOf(matches, 10),
          );
        return resolved(picked);
      }
      if (matches.length > 1) {
        throw locErr(
          "LOCATOR_AMBIGUOUS",
          `${opName}: ${matches.length} elements match ${how} — narrow it, or pass nth (0-based):\n${listCandidates(matches, 10)}`,
          candidatesOf(matches, 10),
        );
      }
      return resolved(matches[0]);
    };
    const textOf0 = (el: Element): string => normText(el.textContent ?? "");

    /** The element painted at a viewport point, climbed to the nearest thing that
     *  is actually interactive. elementFromPoint routinely lands on a decorative
     *  child — the <i> glyph inside an icon button — and acting on that would put
     *  the risk gate and the accessible name on the glyph rather than the control.
     *  Falls back to the raw hit when nothing above it is interactive, which is
     *  the canvas hot-spot case. */
    const atPointTarget = (px: number, py: number): HTMLElement => {
      const hit = deepElementFromPoint(px, py);
      if (!hit) {
        // "must be on screen" is unfalsifiable from the caller's side: it never
        // said how big the screen is. Two things are measured here and nowhere
        // else — the box the point has to fall inside, and (because a screenshot
        // PNG comes back in DEVICE pixels and nothing downstream rescales it)
        // whether the SAME point divided by devicePixelRatio hits something real.
        // The second line prints ONLY when that probe actually resolves, so it is
        // a verified retry argument, not a theory about the caller.
        const dpr = devicePixelRatio || 1;
        let scaled = "";
        if (dpr !== 1) {
          const sx = Math.round(px / dpr);
          const sy = Math.round(py / dpr);
          const alt = deepElementFromPoint(sx, sy);
          if (alt) {
            const nm = truncate(accessibleName(alt), 40);
            scaled =
              `\n  (${sx}, ${sy}) — your point ÷ devicePixelRatio ${dpr} — is ${describeEl(alt)}${nm ? ` "${nm}"` : ""}.` +
              ` A screenshot PNG is in device pixels; retry as click {x:${sx}, y:${sy}}`;
          }
        }
        throw new Error(
          `no element at (${px}, ${py}) — coordinates are viewport-relative; this viewport is ${innerWidth}×${innerHeight}.${scaled}`,
        );
      }
      // Pass 1 — nearest ancestor that is interactive BY MARKUP. This must come
      // first, and the cursor test must not be folded into it: `cursor` is an
      // INHERITED property, so every descendant of a cursor:pointer control also
      // computes `pointer`. A combined test therefore matches the decorative
      // glyph at depth 0 and never climbs at all — which is exactly the case
      // this function exists for, and it silently put the risk gate and the
      // accessible name on the glyph instead of on the control.
      // The climb uses climbOut, not parentElement: now that the hit test
      // descends into open shadow roots, parentElement is null at the root
      // boundary and the climb would stop one step short of the custom element
      // that IS the control — leaving the risk gate and the name on an inner
      // <span>. climbOut rather than `upward` on purpose: upward prefers
      // assignedSlot, which would route a slotted light-DOM node INTO a shadow
      // tree and change the answer on ordinary markup this has nothing to do with.
      for (let n: Element | null = hit, d = 0; n && d < 5; n = climbOut(n), d++) {
        if (n.matches(SNAP_SELECTOR)) return n as HTMLElement;
      }
      // Pass 2 — fall back to a cursor:pointer element, but only where the
      // pointer ORIGINATES. Inheriting it from an ancestor proves nothing.
      // (Inheritance follows the flattened tree, so the parent test climbs the
      // same way.)
      for (let n: Element | null = hit, d = 0; n && d < 5; n = climbOut(n), d++) {
        const p = climbOut(n);
        if (getComputedStyle(n).cursor === "pointer" && (!p || getComputedStyle(p).cursor !== "pointer")) return n as HTMLElement;
      }
      return hit; // nothing interactive above it — a canvas hot-spot, most likely
    };

    /** A target is a [ref], a viewport point, or a description resolved now. */
    const targetOf = (opName: string): HTMLElement => {
      if (params.ref) return resolve(params.ref);
      // Half a coordinate is a caller mistake, not a description — falling through
      // to locateOne would answer with a confusing "nothing matches (no criteria)".
      if ((params.x === undefined) !== (params.y === undefined))
        throw new Error(`${opName}: x and y must be given together (received only ${params.x === undefined ? "y" : "x"})`);
      if (params.x !== undefined && params.y !== undefined) return atPointTarget(params.x, params.y);
      return locateOne(params, opName);
    };

    switch (op) {
      case "snapshot":
        await settleDom();
        return { value: snapshot() };
      case "state": {
        await settleDom();
        const detail = params.verbosity === "detail";
        const se = document.scrollingElement ?? document.documentElement;
        const bodyText = (document.body?.innerText ?? "").trim();

        // Focus — pierce OPEN shadow roots to the real focused control (a
        // web-component host's activeElement is the host, not its inner input;
        // same shadow walk as snapshot's collect at 220/401). Closed shadow /
        // cross-origin iframes stay unreachable, like snapshot.
        let ae = document.activeElement;
        let inShadow = false;
        while (ae && ae.shadowRoot && ae.shadowRoot.activeElement) {
          ae = ae.shadowRoot.activeElement;
          inShadow = true;
        }
        let focus: Record<string, unknown>;
        if (!ae || ae === document.body || ae === document.documentElement) {
          focus = { focused: false };
        } else {
          const ref = store.__bcpRefOf?.get(ae);
          const el = ae as HTMLInputElement;
          const type = (el.getAttribute("type") ?? "").toLowerCase();
          // Non-text input types (buttons, pickers, file) — typing doesn't land here.
          const isTextEntry =
            (ae.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "reset", "image", "range", "color", "file"].includes(type)) ||
            ae.tagName === "TEXTAREA" ||
            (ae as HTMLElement).isContentEditable;
          let selectionStart: number | undefined, selectionEnd: number | undefined, valueLength: number | undefined;
          try {
            if (el.selectionStart != null) { selectionStart = el.selectionStart; selectionEnd = el.selectionEnd ?? undefined; }
          } catch { /* non-text input: selection unsupported */ }
          if (typeof el.value === "string") valueLength = el.value.length;
          focus = {
            focused: true, ref, tag: ae.tagName.toLowerCase(), role: inferRole(ae),
            name: truncate(accessibleName(ae), 120), isTextEntry,
            selectionStart, selectionEnd, valueLength,
            inIframe: ae.tagName === "IFRAME" || undefined,
            inShadow: inShadow || undefined,
          };
        }

        // Forms — aggregate submittability. Use the constraint-validation API
        // (validity.valueMissing) instead of a manual required&&empty test, so a
        // radio GROUP with one selection reads as satisfied; and count each radio
        // group ONCE (one logical field), not once per button. required-empty and
        // other-invalid are mutually exclusive so one field never double-counts.
        let controls = 0, filled = 0, emptyRequired = 0, invalid = 0, dirty = 0;
        const blockers: Array<Record<string, unknown>> = [];
        const countedGroups = new Set<string>();
        const refOf = (c: Element): string | undefined => store.__bcpRefOf?.get(c);
        for (const c of document.querySelectorAll("input, select, textarea")) {
          if (!isVisible(c)) continue;
          const el = c as HTMLInputElement;
          const type = (el.getAttribute("type") ?? "").toLowerCase();
          const isRadio = type === "radio";
          // A radio GROUP is ONE logical field — account it once, across every
          // count (controls/filled/dirty too, not just validity), else a
          // satisfied 3-button group reads "1/3 filled".
          const gkey = isRadio && el.name ? `r:${el.name}` : null;
          if (gkey && countedGroups.has(gkey)) continue;
          if (gkey) countedGroups.add(gkey);
          const isCheck = type === "checkbox" || isRadio;
          const radios = gkey
            ? ([...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)] as HTMLInputElement[])
            : [el];
          const empty = isRadio
            ? !radios.some((r) => r.checked)
            : isCheck
              ? !el.checked
              : !String(el.value ?? "").trim();
          controls++;
          if (!empty) filled++;
          // Constraint validation OR the ARIA fallback: Ant/Element/Arco set
          // aria-required/aria-invalid but NOT the native attrs, so validity
          // alone (valueMissing) misses them — check both.
          const v = el.validity;
          const ariaRequired = el.getAttribute("aria-required") === "true";
          const ariaInvalid = el.getAttribute("aria-invalid") === "true";
          const missing = (v ? v.valueMissing : el.required && empty) || (empty && ariaRequired);
          const otherInvalid = !missing && ((v ? !v.valid && !v.valueMissing : false) || ariaInvalid);
          if (missing) {
            emptyRequired++;
            if (detail && blockers.length < 10) blockers.push({ ref: refOf(c), name: truncate(accessibleName(c), 80), reason: "required-empty" });
          } else if (otherInvalid) {
            invalid++;
            if (detail && blockers.length < 10) blockers.push({ ref: refOf(c), name: truncate(accessibleName(c), 80), reason: "invalid", message: truncate(el.validationMessage ?? "", 80) || undefined });
          }
          let isDirty = false;
          try {
            if (el.tagName === "SELECT") {
              isDirty = [...(el as unknown as HTMLSelectElement).options].some((o) => o.selected !== o.defaultSelected);
            } else if (isRadio) {
              isDirty = radios.some((r) => r.checked !== r.defaultChecked);
            } else if (isCheck) {
              isDirty = el.checked !== el.defaultChecked;
            } else {
              isDirty = el.value !== el.defaultValue;
            }
          } catch { /* defaults unreadable */ }
          if (isDirty) dirty++;
        }

        // Change delta — baseline keyed by observer (deltaKey), stored per
        // document in the isolated world so two sessions sharing a tab don't
        // clobber each other's "changed since I last looked".
        const sigStore = store as unknown as { __bcpStateSig?: Record<string, Sig> };
        sigStore.__bcpStateSig ??= {};
        const key = params.deltaKey ?? "_";
        const nowSig = captureSig();
        const prev = sigStore.__bcpStateSig[key];
        let changed = prev && !params.resetDelta ? diffSig(prev, nowSig) : undefined;
        // diffSig always stamps errorCount as context (fine for action deltas).
        // For page_state's periodic `changed`, a persistent UNCHANGED error count
        // is not a change — otherwise every beat reports "1 error(s)" and the
        // "nothing changed" verify signal never appears. Drop a lone, unchanged
        // errorCount; keep it when errors actually moved (newErrors) or the count
        // differs, or when it rides alongside a real change.
        if (
          changed &&
          Object.keys(changed).length === 1 &&
          changed.errorCount != null &&
          !changed.newErrors &&
          prev!.errors.length === nowSig.errors.length
        ) {
          changed = undefined;
        }
        sigStore.__bcpStateSig[key] = nowSig;

        const dialogEls = visibleDialogs(); // shared visible-filter (matches captureSig)
        const busy = [...document.querySelectorAll('[aria-busy="true"],[role="progressbar"],progress:not([value])')].filter(isVisible).length;

        return {
          value: {
            url: location.href,
            title: document.title,
            readyState: document.readyState,
            loading: document.readyState !== "complete" || bodyText.length === 0,
            interactableCount: nowSig.count,
            scroll: {
              y: se.scrollTop, height: se.scrollHeight, viewport: innerHeight,
              moreBelow: se.scrollTop + se.clientHeight < se.scrollHeight - 4,
              moreAbove: se.scrollTop > 4,
            },
            focus,
            forms: { controls, filled, emptyRequired, invalid, dirty, ...(detail && blockers.length ? { blockers } : {}) },
            dialogs: dialogEls.length,
            ...(detail ? { dialogNames: [...dialogEls].slice(0, 5).map((d) => truncate(accessibleName(d), 60)) } : {}),
            scrollLocked: nowSig.locked,
            overlay: nowSig.overlay,
            busy,
            errorCount: nowSig.errors.length,
            ...(detail && nowSig.errors.length ? { errors: nowSig.errors } : {}),
            ...(changed ? { changed } : {}),
            ...(prev ? {} : { firstObservation: true }),
          },
        };
      }
      case "click": {
        // params.ms bounds the actionability+interception retry loop. Not yet
        // surfaced as an MCP tool argument; the default suits real pages and the
        // regression harness passes a short one to assert the timeout path.
        const at = params.x !== undefined && params.y !== undefined ? { x: params.x, y: params.y } : undefined;
        const delta = await withDelta(() => realClick(targetOf("click"), params.confirm, params.ms, at));
        return withResolved({ value: { ok: true, delta } });
      }
      case "contextmenu": {
        const delta = await withDelta(() => realContextMenu(targetOf("right-click"), params.ms));
        return withResolved({ value: { ok: true, delta } });
      }
      case "dblclick": {
        const delta = await withDelta(() => realDblClick(targetOf("double-click"), params.confirm, params.ms));
        return withResolved({ value: { ok: true, delta } });
      }
      case "paste": {
        const el = params.ref ? resolve(params.ref) : locateOne({ ...params, text: undefined }, "paste");
        const delta = await withDelta(() => realPaste(el, params.text ?? "", params.ms));
        return withResolved({ value: { ok: true, delta } });
      }
      case "type": {
        // `text` is the value being typed, so it cannot double as a locator the
        // way it does for click. An input carries no child text anyway — locate
        // it by name (accessibleName already covers placeholder and <label>),
        // role, css or near.
        const el = params.ref ? resolve(params.ref) : locateOne({ ...params, text: undefined }, "type");
        const delta = await withDelta(() => realType(el, params.text ?? "", params.submit, params.confirm));
        return withResolved({ value: { ok: true, delta } });
      }
      case "read": {
        await settleDom();
        // NOT `truncate`: it collapses every run of whitespace, newlines
        // included, so a whole page arrives as one line and every table, list
        // and menu loses the row/column structure the agent reads layout from.
        // That is fine for the short labels truncate exists for, and wrong here.
        // Keep the line breaks innerText already computed; only squeeze runs of
        // spaces within a line and long blank stretches.
        const raw = (document.body?.innerText ?? "")
          .replace(/[^\S\n]+/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        // Keep the read lossless: callers can concatenate chunks exactly, and
        // the metadata tells them whether another RPC is required. The default
        // is intentionally much larger than the historical 8K cap, while
        // pagination still makes arbitrarily long pages readable without
        // attempting one unbounded RPC response.
        const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")]
          .filter(isVisible)
          .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter(Boolean);
        const overview = {
          headings: headings.slice(0, 40),
          ...(headings.length > 40 ? { headingsTruncated: true } : {}),
          excerpt: raw.slice(0, 800),
        };
        if (params.full) {
          return {
            value: {
              url: location.href,
              title: document.title,
              text: raw,
              offset: 0,
              totalChars: raw.length,
              truncated: false,
              overview,
            },
          };
        }
        const requestedMax = params.maxChars ?? 32_000;
        const max = Number.isFinite(requestedMax) && requestedMax > 0 ? Math.floor(requestedMax) : 32_000;
        const requestedOffset = params.offset ?? 0;
        const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? Math.min(raw.length, Math.floor(requestedOffset)) : 0;
        const end = Math.min(raw.length, offset + max);
        const text = raw.slice(offset, end);
        const truncated = end < raw.length;
        return {
          value: {
            url: location.href,
            title: document.title,
            text,
            offset,
            totalChars: raw.length,
            truncated,
            ...(truncated ? { nextOffset: end } : {}),
            overview,
          },
        };
      }
      case "wait": {
        const ms = params.ms ?? 5000;
        const deadline = Date.now() + ms;
        const check = (): boolean | null => {
          if (params.selector) {
            const el = queryDeep(params.selector);
            const vis = !!el && isVisible(el);
            return params.state === "hidden" ? !vis : vis; // default: wait until visible
          }
          if (params.waitText) return (document.body?.innerText ?? "").includes(params.waitText);
          return null; // no condition -> fixed delay
        };
        if (check() === null) {
          await sleep(ms);
          return { value: { matched: true } };
        }
        while (Date.now() < deadline) {
          if (check()) return { value: { matched: true } };
          await sleep(200);
        }
        return { value: { matched: false } };
      }
      case "select": {
        const el = followLabel(resolve(params.ref!));
        if (!(el instanceof HTMLSelectElement))
          throw new Error(`ref "${params.ref}" is ${describeEl(el)}, not a <select>${innerControlHint(el, "select")}`);
        // A covered <select> used to take the value and report success.
        await reachTarget(el, "select");
        const want = params.values ?? [];
        const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase(); // collapse ws to match snapshot labels
        const opts = [...el.options];
        const label = (o: HTMLOptionElement) => o.textContent?.trim() || o.value;
        const hit = (o: HTMLOptionElement) => want.some((v) => norm(v) === norm(o.value) || norm(v) === norm(o.textContent ?? ""));
        // Decide BEFORE touching the control. The loop used to assign opt.selected
        // as it went and only afterwards discover it had matched nothing — leaving
        // every option deselected, which resets a single <select> to index 0. A
        // call that refused to set the field and changed it anyway.
        const selected = opts.filter(hit).map(label);
        if (selected.length === 0)
          throw new Error(
            `no option matched ${JSON.stringify(want)} — this <select> offers ${opts.length}: ` +
            `${opts.slice(0, 20).map((o) => JSON.stringify(label(o))).join(", ")}${opts.length > 20 ? `, … ${opts.length - 20} more (truncated)` : ""}.` +
            ` Pass one verbatim (value or visible label; whitespace and case are normalized)`,
          );
        const before = captureSig();
        for (const opt of opts) opt.selected = hit(opt); // replace semantics (Playwright-style) for single AND multiple
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(50);
        // Report what SURVIVED the change handlers, not what we set. A controlled
        // component or a cascading-select validator can put the old option back,
        // and `selected` above was built before change was even dispatched.
        const actual = [...el.selectedOptions].map((o) => o.textContent?.trim() || o.value);
        return { value: { ok: true, selected: actual, delta: afterDelta(before) } };
      }
      // Deliberately NOT routed through reachTarget. A keyboard event is
      // delivered to the focused element, not to whatever is painted at a
      // coordinate — a covered input still receives keys, and hit-testing here
      // would refuse actions the browser performs perfectly well.
      case "key": {
        const chord = params.key ?? "";
        let base: string;
        let mods: string[];
        if (chord === "+") {
          base = "+";
          mods = [];
        } else {
          const parts = chord.split("+");
          base = parts.pop() ?? "";
          mods = parts.map((m) => m.toLowerCase());
        }
        const target = params.ref ? resolve(params.ref) : ((document.activeElement as HTMLElement) ?? document.body);
        const NAV: Record<string, number> = {
          ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35,
          PageUp: 33, PageDown: 34, Delete: 46, Backspace: 8, Enter: 13, Tab: 9, Escape: 27,
        };
        const legacy = base.length === 1 ? base.toUpperCase().charCodeAt(0) : (NAV[base] ?? 0);
        const init = {
          bubbles: true, cancelable: true, composed: true,
          key: base,
          code: /^[a-zA-Z]$/.test(base) ? "Key" + base.toUpperCase() : /^[0-9]$/.test(base) ? "Digit" + base : base,
          keyCode: legacy, which: legacy,
          ctrlKey: mods.includes("control") || mods.includes("ctrl"),
          shiftKey: mods.includes("shift"),
          altKey: mods.includes("alt"),
          metaKey: mods.includes("meta") || mods.includes("cmd"),
        } as unknown as KeyboardEventInit;
        const before = captureSig();
        // A synthetic key drives no native default action, so a handler calling
        // preventDefault is the only positive proof the page saw this keystroke
        // at all. Same evidence realClick has always captured.
        const accepted = target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
        await sleep(50);
        const delta = afterDelta(before);
        return { value: { ok: true, delta: accepted ? delta : { ...(delta ?? {}), defaultPrevented: true } } };
      }
      case "drag": {
        const drag = params.dragMethod === "pointer" ? realPointerDrag : realDrag;
        const delta = await withDelta(() => drag(resolve(params.ref!), resolve(params.toRef!), params.confirm));
        return withResolved({ value: { ok: true, delta } });
      }
      case "hover": {
        const el = resolve(params.ref!);
        const before = captureSig();
        await realHover(el);
        await sleep(150); // let a hover-triggered tooltip/menu render
        return { value: { ok: true, delta: afterDelta(before) } };
      }
      case "clickText": {
        const want = (params.text ?? "").trim();
        if (!want) throw new Error("clickText requires a `text` to match");
        const norm = (s: string) => s.replace(/\s+/g, " ").trim();
        const wn = norm(want).toLowerCase();
        // Innermost visible element whose text matches — reaches bespoke UI the
        // snapshot didn't surface. textContent (no reflow); the click still bubbles
        // to whatever delegated handler an ancestor holds.
        const matches: HTMLElement[] = [];
        // Cheap miss short-circuit only: if the text is nowhere on the page,
        // skip the scan entirely ("no such label" is the common outcome).
        // The scan itself is deliberately the straightforward one — a
        // text-node walk cannot reproduce its semantics, because a label may be
        // SPLIT across children (<span>Sub</span><span>mit</span>) so that no
        // single text node matches, while judging a text node by its owner's
        // textContent instead makes an outer wrapper (<li>Price $5
        // <button>Buy</button></li>) match ahead of the real control and shifts
        // every `nth`. The innermost-match filter below is what gets both right.
        // Gate on the SAME text source the scan below uses. Using innerText here
        // while the scan reads textContent made the two disagree: innerText
        // omits CSS-hidden text and applies text-transform, so the gate could
        // reject a string the scan would have found. A gate must be no stricter
        // than what it guards — being looser only costs a scan.
        // Same text and the same notion of an exact label as a click description (matchText), including open
        // shadow roots — two matchers that disagreed is how exact click_text kept missing labels locate found.
        const textOfPage = makeTextOf();
        if (normText(textOfPage(document.body ?? document.documentElement)).toLowerCase().includes(wn))
          matches.push(...matchText([...document.querySelectorAll<HTMLElement>("*")].filter((el) => isVisible(el)), wn, params.exact, textOfPage));
        if (matches.length === 0) {
          // The scan is visibility-filtered and optionally exact-filtered, so "not
          // found" covers three situations with three different fixes. Re-run it
          // without either filter: what comes back says which one this is, instead
          // of leaving the caller to re-word a string that was never the problem.
          const loose: HTMLElement[] = [];
          for (const el of document.querySelectorAll<HTMLElement>("*")) {
            if (!norm(el.textContent || "").toLowerCase().includes(wn)) continue;
            if (![...el.children].some((c) => norm(c.textContent || "").toLowerCase().includes(wn))) loose.push(el);
          }
          const visible = loose.filter((el) => isVisible(el));
          const shown = loose.slice(0, 3)
            .map((el) => `  ${describeEl(el)}${isVisible(el) ? "" : " [not displayed]"} text: ${JSON.stringify(truncate(el.textContent || "", 60))}`)
            .join("\n");
          throw new Error(
            `no visible element with text ${JSON.stringify(want)}` +
            (loose.length
              ? `, but ${loose.length} element(s) contain it:\n${shown}\n  → ${
                  visible.length
                    ? "no element's text EQUALS it, which is what exact:true requires — drop exact, or pass the full text quoted above"
                    : `every copy is hidden, so re-wording cannot help${openerFor(hiddenCause(loose[0]))}`
                }`
              : ` — that string is nowhere in this document; read_content to see what is, or snapshot if the target may be in another frame (click_text sees the main frame only)`),
          );
        }
        if (params.nth !== undefined && !matches[params.nth])
          throw new Error(
            `nth=${params.nth} is out of range — ${matches.length} element(s) match ${JSON.stringify(want)} (0-based)`,
          );
        const target = matches[params.nth ?? 0];
        const delta = await withDelta(() => realClick(target, params.confirm, params.ms));
        // WHICH of the N it clicked is not something the caller can look up: it
        // cannot see the page, and this tool has never refused an ambiguous match —
        // it takes index 0 in silence. Reporting the count (and keeping the click)
        // makes "wrong row" an observation the caller can act on with nth, instead
        // of an invisible one. Deliberately NOT a refusal: refusing here would break
        // every call that legitimately means "the first one".
        return { value: { ok: true, matched: norm(target.textContent || "").slice(0, 80), candidates: matches.length, delta } };
      }
      // Deliberately NOT routed through reachTarget either, and for the opposite
      // reason: the file <input> behind a styled uploader is hidden BY DESIGN
      // (snapshot lists it as [hidden] precisely so it can still be targeted).
      // An actionability/visibility check would reject the normal case.
      case "upload": {
        // A file input is routinely hidden behind a styled <label>/button, so an
        // agent that located the visible control lands on the wrapper, not the
        // input. follow-label resolves it.
        // Locating is shared with every other op (targetOf → locateOne), so a
        // file input is reachable by name/role/near/nth exactly like a button —
        // which is what RpcContracts[Upload] has always declared. It used to
        // accept ONLY ref/css, so a playbook that located a slot by `name`
        // (the only form that survives replay — refs die on the re-render an
        // upload itself causes) failed with "provide ref or css".
        // locateOne filters hidden elements, and that is right here rather than
        // a problem: the <input type=file> is hidden BY DESIGN, so a name query
        // lands on the VISIBLE styled slot and followLabel walks in to the
        // input — the same wrapper→control resolution select_option relies on.
        // Visible-first, hidden as a fallback. Both halves are load-bearing:
        // visible-first keeps a `name` query landing on the STYLED SLOT only —
        // the hidden <input> inside it usually carries the same accessible
        // name, so counting both would make nth advance two per uploader; the
        // hidden fallback keeps a locator that points AT the input itself
        // (css:"#file") working, which is legitimate and used by playbooks.
        const target = params.ref
          ? resolve(params.ref)
          : (() => {
              try {
                return locateOne(params, "upload");
              } catch (error) {
                if ((error as { bcpCode?: string }).bcpCode !== "LOCATOR_NO_MATCH") throw error;
                return locateOne(params, "upload", true);
              }
            })();
        const el = followLabel(target);
        if (!(el instanceof HTMLInputElement) || el.type !== "file")
          throw new Error(`upload target is ${describeEl(el)}, not an <input type=file>${innerControlHint(el, "file")}`);
        const encoded = params.dataBase64s?.length ? params.dataBase64s : [params.dataBase64 ?? ""];
        const files = encoded.map((data, index) => {
          const bin = atob(data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const filename = params.dataBase64s?.length
            ? `${String(params.filename || "upload").replace(/\.[^.]+$/, "")}-${index + 1}.jpg`
            : params.filename ?? "upload";
          return new File([bytes], filename, { type: params.mimeType || "application/octet-stream" });
        });
        const dt = new DataTransfer();
        for (const file of files) dt.items.add(file);
        const before = captureSig();
        el.files = dt.files; // FileList from DataTransfer is assignable (no native dialog / no CDP)
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(200);
        return { value: { ok: true, files: [...el.files].map((f) => f.name), delta: afterDelta(before) } };
      }
      case "scroll": {
        const refEl = params.ref ? resolve(params.ref) : null;
        let c: HTMLElement | null = refEl;
        // Advance until we hit a genuinely scrollable ancestor (overflow auto/scroll + overflowing).
        while (c && !(c.scrollHeight > c.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(c).overflowY)))
          c = c.parentElement;
        let box = c ?? (document.scrollingElement as HTMLElement) ?? document.documentElement;
        // Short descriptor ("div.doc-body") so the agent can tell what we scrolled.
        const desc = (el: Element): string => {
          const cls = typeof el.className === "string" && el.className.trim()
            ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
            : "";
          return `${el.tagName.toLowerCase()}${cls}`;
        };
        if (box.scrollHeight <= box.clientHeight + 4) {
          // Window not scrollable — many apps (Feishu docs, Gmail) scroll an
          // inner container instead. Pick the largest visible scrollable one.
          let best: HTMLElement | null = null;
          let bestArea = 0;
          for (const el of document.querySelectorAll<HTMLElement>("*")) {
            if (el.scrollHeight <= el.clientHeight + 4 || el.clientHeight < 150) continue;
            if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
            const r = el.getBoundingClientRect();
            const area = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * r.width;
            if (area > bestArea) { bestArea = area; best = el; }
          }
          // Only trust a container that dominates the viewport — a small side
          // panel (chat/nav pane) beating an unscrollable canvas main area is
          // the wrong pick; prefer the wheel fallback then.
          if (best && bestArea >= innerWidth * innerHeight * 0.25) box = best;
        }
        if (box.scrollHeight <= box.clientHeight + 4) {
          // Nothing DOM-scrollable — canvas-rendered grids (Feishu Bitable,
          // Google Sheets) consume wheel events instead. Dispatch one at the
          // target's center; coordinates matter: handlers hit-test the position.
          const rect = refEl?.getBoundingClientRect();
          const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
          const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
          // Pierce open shadow roots: a canvas-grid rendered as a web component
          // listens INSIDE its root, and a wheel event dispatched on the HOST never
          // reaches it — the same retargeting defect the click hit test has.
          const target = deepElementFromPoint(x, y) ?? document.body;
          const total = params.toBottom ? 100000 : params.deltaY ?? window.innerHeight * 0.9;
          // A canvas grid that consumes the wheel calls preventDefault. That is the
          // ONLY observation available on this path — the container's internal
          // scroll offset lives in the page's own JS, not in the DOM — and it is
          // the difference between "the grid scrolled" and "the event went
          // nowhere". realClick has captured the same dispatchEvent return since
          // it was written.
          let consumed = false;
          const tick = (deltaY: number) => {
            const accepted = target.dispatchEvent(
              new WheelEvent("wheel", { deltaY, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }),
            );
            if (!accepted) consumed = true;
            return accepted;
          };
          // Humanize (default ON): real wheels emit ~100px ticks. toBottom stays
          // single-shot — ticking through an unknown distance takes unbounded time.
          if (params.humanize !== false && !params.toBottom) {
            // Math.abs + sign so negative deltas (scroll up) tick correctly too.
            const dir = Math.sign(total) || 1;
            for (let left = Math.abs(total); left > 0; left -= 120) {
              tick(dir * Math.min(120, left));
              await new Promise((r) => setTimeout(r, 40));
            }
          } else {
            tick(total);
          }
          await new Promise((r) => setTimeout(r, 250));
          return {
            value: {
              // NOT 0/0/true — those were placeholders that read as measurements.
              // Nothing on this path can observe a canvas grid's own offset.
              via: "wheel",
              consumed,
              target: `wheel@${Math.round(x)},${Math.round(y)} -> ${desc(target)}`,
            },
          };
        }
        const wasAt = box.scrollTop; // without a BEFORE, "scrolled 800px" and "did not move" return the same shape
        const top = params.toBottom ? box.scrollHeight : box.scrollTop + (params.deltaY ?? box.clientHeight * 0.9);
        // Smooth scrolling is animation-driven: background tabs freeze rAF, so
        // the animation never runs and the scroll silently no-ops. Humanize
        // only when someone can actually see it.
        if (params.humanize !== false && document.visibilityState === "visible") {
          box.scrollTo({ top, behavior: "smooth" });
          await new Promise((r) => setTimeout(r, 600)); // let the smooth animation settle
        } else {
          box.scrollTop = top;
        }
        await new Promise((r) => setTimeout(r, 250)); // let lazy loaders fire
        const sy = box.scrollTop, sh = box.scrollHeight, ch = box.clientHeight;
        const target = box === document.scrollingElement ? "window" : desc(box);
        return { value: { scrollY: sy, scrollHeight: sh, movedBy: Math.round(sy - wasAt), moreBelow: sy + ch < sh - 4, via: "dom", target } };
      }
      default:
        return { error: `unknown op ${op}` };
    }
  } catch (e) {
    // The message is what a person reads; `errorInfo` is what a program branches
    // on. Returning only the sentence is what forced every caller upstream to
    // decide "is this a stale selector or a dead browser?" by matching prose.
    // Carried as a plain object because this function is serialised into the
    // page and the Error's own properties do not survive the return trip.
    const tagged = e as { bcpCode?: string; bcpCandidates?: unknown; bcpRelaxedBy?: string };
    const out: { error: string; errorInfo?: { code: string; candidates?: unknown; relaxedBy?: string } } = {
      error: e instanceof Error ? e.message : String(e),
    };
    if (tagged && typeof tagged.bcpCode === "string") {
      out.errorInfo = { code: tagged.bcpCode };
      if (tagged.bcpCandidates) out.errorInfo.candidates = tagged.bcpCandidates;
      if (tagged.bcpRelaxedBy) out.errorInfo.relaxedBy = tagged.bcpRelaxedBy;
    }
    return out;
  }
}

/**
 * Injected on demand (chrome.scripting, ISOLATED world) to show/hide the
 * "automation running" badge. Replaces the persistent content script entirely,
 * so the extension declares NO content_scripts and thus NO web_accessible_resources
 * — the page can no longer fingerprint the extension by probing a stable asset URL.
 * The host ref lives on the isolated-world global (invisible to the page).
 */
export function bcpOverlay(show: boolean): void {
  const g = globalThis as unknown as { __bcpOv?: HTMLElement | null };
  if (show) {
    if (g.__bcpOv) return; // idempotent
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483647";
    const sh = host.attachShadow({ mode: "closed" }); // page JS can't read contents
    sh.innerHTML = `
      <style>
        .bar{display:flex;align-items:center;gap:10px;background:#1e1e2e;color:#e4e4f0;
          font:13px system-ui,-apple-system,sans-serif;padding:8px 12px;border-radius:10px;
          box-shadow:0 4px 16px rgba(0,0,0,.35);border:1px solid #3a3d5c}
        .dot{width:8px;height:8px;border-radius:50%;background:#7c6cff;animation:bcpP 1s infinite}
        @keyframes bcpP{50%{opacity:.3}}
        button{background:#f26d78;color:#fff;border:none;border-radius:6px;
          padding:4px 10px;cursor:pointer;font:12px system-ui}
      </style>
      <div class="bar"><span class="dot"></span><span>UltraGo 正在操作此页面</span>
        <button id="s">停止</button></div>`;
    sh.getElementById("s")?.addEventListener("click", () => chrome.runtime.sendMessage({ kind: "interrupt" }));
    (document.documentElement || document.body).appendChild(host);
    g.__bcpOv = host;
  } else {
    g.__bcpOv?.remove();
    g.__bcpOv = null;
  }
}

/**
 * Injected into the page's MAIN world before interaction ops so a page dialog
 * (alert/confirm/prompt) fired from a click handler can't block our synthetic
 * dispatch. Idempotent. Destructive confirms are already gated upstream by the
 * risky-click classifier, so auto-accepting here is safe.
 */
type NativeDialogs = { a: typeof window.alert; c: typeof window.confirm; p: typeof window.prompt };

export function bcpDialogShim(accept: boolean): void {
  const w = window as unknown as { __bcpNative?: NativeDialogs };
  if (!w.__bcpNative) w.__bcpNative = { a: window.alert, c: window.confirm, p: window.prompt };
  window.alert = () => undefined;
  // Tie the dialog response to the caller's explicit confirm intent — fail-safe
  // CANCEL by default so an unexpected confirm() can't auto-proceed a destructive action.
  window.confirm = () => accept;
  window.prompt = () => (accept ? "" : null);
}

/** Restore native dialogs after the op so real user interaction isn't affected. */
export function bcpDialogRestore(): void {
  const w = window as unknown as { __bcpNative?: NativeDialogs };
  if (w.__bcpNative) {
    window.alert = w.__bcpNative.a;
    window.confirm = w.__bcpNative.c;
    window.prompt = w.__bcpNative.p;
    w.__bcpNative = undefined;
  }
}

/**
 * Injected (ISOLATED world) to install RESIDENT page-event probes — alongside a
 * snapshot ("install on perceive"), and on load for every watched tab, so a tab
 * the agent is not currently driving can still report that it got blocked.
 * Three jobs:
 *   1. A throttled MutationObserver → `dom_changed` burst summaries (catches
 *      "content changed but element count didn't", e.g. a table refresh) plus
 *      prompt `dialog` events when a custom [role=dialog] modal is portaled in.
 *   2. A bridge that relays MAIN-world console errors (posted via
 *      window.postMessage, since MAIN has no chrome API) on to the SW.
 *   3. Challenge/risk-control detection → `captcha_appeared`/`captcha_cleared`
 *      (consumed by the event webhook only — never shown to the agent).
 * ISOLATED world can see the page DOM AND has chrome.runtime, so it messages the
 * SW directly. Idempotent — probes die on navigation, so the next snapshot
 * re-installs them; a redundant re-inject is a no-op.
 *
 * `nav` carries the one class of evidence a page CANNOT see about itself: the
 * HTTP status and challenge header of its own document, which only the SW's
 * webRequest listener observes. Optional by design — a recycled SW loses it, and
 * detection then runs on DOM signals alone. Absent, not wrong. It describes the
 * TOP document, so only the top frame may read it.
 */
export function bcpEventProbes(nav?: { status?: number; cfChallenge?: boolean }): void {
  const g = globalThis as unknown as {
    __bcpProbes?: boolean;
    __bcpCaptcha?: CaptchaSignal;
    __bcpCheckCaptcha?: () => CaptchaSignal | undefined;
  };
  if (g.__bcpProbes) return;
  g.__bcpProbes = true;

  // Firefox's promise-based sendMessage lives on `browser`; Chrome exposes it on
  // `chrome`. Bind whichever this injected ISOLATED world provides so the .catch
  // below always has a promise to chain (self-contained: no import in an injected fn).
  const api = (globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome;
  const sendEvent = (kind: string, summary: string, detail?: Record<string, unknown>): void => {
    api.runtime.sendMessage({ kind: "bcpPageEvent", event: { kind, summary, detail } }).catch(() => {
      /* SW asleep / extension context invalidated — best effort */
    });
  };

  const DIALOG_SEL = '[role="dialog"],[role="alertdialog"],dialog[open]';

  // ---- Challenge / risk-control detection ---------------------------------
  // Every verdict here is a DOM estimate, so it only ever becomes an event for
  // the webhook, which confirms it visually. bcpDomRuntime (the agent's view of
  // the page) deliberately does not read it.
  //
  // Costs one pass per quiet window (it rides the dom_changed throttle below),
  // never per mutation — the whole point of pushing detection into a resident
  // probe is that no caller has to poll for it.
  //
  // ISOLATED world: this code can only ever look at the DOM. Page globals —
  // window.TencentCaptcha, window.initGeetest, window.grecaptcha — are NOT
  // reachable from here, and a check for them would be silently false forever.
  // Don't add one.
  //
  // Fingerprint confidence is NOT uniform, so each row says where it came from:
  //   [doc] the vendor's own integration documentation
  //   [obs] observed in the wild / community write-ups — expected to go stale
  // Host-based anchors (iframe/script src) are preferred over class names where
  // the docs give one: a vendor renames classes between releases, but the CDN
  // host it loads from is contractual. When every row misses, the structural
  // fallback below is what still catches the challenge.
  const VENDORS: Array<[string, string]> = [
    ["recaptcha", 'iframe[src*="recaptcha"],.g-recaptcha'], // [doc]
    ["hcaptcha", 'iframe[src*="hcaptcha.com"],.h-captcha'], // [doc]
    ["turnstile", 'iframe[src*="challenges.cloudflare.com"],.cf-turnstile'], // [doc]
    // [doc] docs.geetest.com names *.geetest.com / *.geevisit.com as the hosts
    // to allowlist; geetest_-prefixed classes are [obs] but stable across v3/v4.
    ["geetest", 'iframe[src*="geetest.com"],script[src*="geetest.com"],[class*="geetest_"]'],
    // [doc] cloud.tencent.com/document/product/1110/36841: script host
    // turing.captcha.qcloud.com, and "弹窗最外层用 class=tcaptcha-transform".
    ["tencent", 'iframe[src*="turing.captcha"],script[src*="turing.captcha"],.tcaptcha-transform'],
    // [doc] host dun.163.com; [obs] yidun_ class prefix (yidun_slider / _jigsaw).
    ["yidun", 'iframe[src*="dun.163.com"],script[src*="dun.163.com"],[class*="yidun_"]'],
    // [obs] ByteDance/Douyin secsdk — no public integration doc; anchors from
    // community reverse-engineering. Most likely row to rot; treat as a hint.
    ["bytedance", '#captcha_container,#captcha-verify-image,[class*="secsdk-captcha"],[class*="captcha_verify_"]'],
  ];
  // The English half is deliberately weighted toward interstitial WORDING rather
  // than the word "captcha": Cloudflare's own challenge pages never say captcha,
  // they say "Just a moment…" / "Checking your browser" / "Attention Required",
  // which are the three strings every scraping stack keys on.
  const CHALLENGE_TEXT =
    /验证码|滑块|拖动|风控|安全验证|访问受限|人机验证|verify you are human|not a robot|security check|just a moment|checking your browser|attention required/i;
  /** Coarse "how much is on this page" gauge. Deliberately NOT snapshot's
   *  SNAP_SELECTOR — this only has to tell a real page from a barren one, and
   *  copying that selector here would be a second copy to keep in sync. */
  const GAUGE_SEL = "a,button,input,select,textarea,[role],[onclick]";
  const isTop = window === window.top;
  /** Things you can drag. Deliberately broad and deliberately bilingual — the
   *  handle is the one part of a slider challenge that cannot be styled away,
   *  and vendors name it every possible way. */
  const DRAG_SEL =
    '[class*="slider"],[class*="slide"],[class*="drag"],[role="slider"],[draggable="true"],[aria-label*="滑"]';

  /** Is this element actually on screen? The same three rules snapshot uses in
   *  bcpDomRuntime, restated here because an injected function is serialised
   *  whole and cannot import or share a closure with the other one — keep the
   *  two in step. Matters because a fingerprint answers "is the widget on this
   *  page", and a login form that PRELOADS a hidden slider answers yes without
   *  anything blocking the user. */
  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  };

  /** The layer covering the viewport, if there is one. Found by hit-testing the
   *  centre and walking UP to the first positioned ancestor big enough to be a
   *  cover — the control itself is usually static inside a fixed container, so
   *  asking the hit element about its own position answers the wrong question.
   *  Bounded to 8 levels: one hit-test plus ≤8 getComputedStyle is cheap enough
   *  to run on the action path, an unbounded walk to <html> is not. */
  const overlayRoot = (): HTMLElement | undefined => {
    let node: Element | null = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    for (let i = 0; node && i < 8; i++) {
      const pos = getComputedStyle(node).position;
      if (pos === "fixed" || pos === "absolute") {
        const r = node.getBoundingClientRect();
        if (r.width * r.height >= innerWidth * innerHeight * 0.5) return node as HTMLElement;
      }
      node = node.parentElement;
    }
    return undefined;
  };

  const detectChallenge = (): CaptchaSignal | undefined => {
    const evidence: string[] = [];
    // A fingerprint answers "whose challenge machinery is loaded here", NOT "is
    // it challenging you". Those differ constantly: a login form preloads its
    // slider hidden, and reporting that as an interception makes the agent
    // abandon work that was never blocked. So a fingerprint only convicts when
    // one of its elements is actually displayed.
    let vendorShown = false;
    for (const [name, sel] of VENDORS) {
      const hits = document.querySelectorAll(sel);
      if (!hits.length) continue;
      vendorShown = [...hits].some(shown);
      evidence.push(`vendor fingerprint: ${name}${vendorShown ? "" : " (present but not displayed)"}`);
      break;
    }
    const text = (document.body?.innerText ?? "").slice(0, 4000);
    const textHit = CHALLENGE_TEXT.exec(text)?.[0];
    if (textHit) evidence.push(`page text matches "${textHit}"`);

    // Page-level — the whole document IS the challenge. Only the top frame may
    // conclude this: a barren SUBFRAME is just a small iframe, not a blocked
    // page. `nav` describes the top document, which is the other reason this is
    // gated on isTop.
    if (isTop) {
      // The server DECLARING its own response to be a challenge. Every other
      // signal here is us inferring from appearance; this one is the origin
      // stating it, so it convicts alone and nothing else has to agree.
      if (nav?.cfChallenge) {
        evidence.push("server sent cf-mitigated: challenge");
        return { evidence };
      }
      const n = document.querySelectorAll(GAUGE_SEL).length;
      const barren = n < 10 && text.length < 500;
      if (barren) evidence.push(`barren page: ${n} interactable(s), ${text.length} chars of text`);
      // Blocking statuses only. A 404 is barren and unhelpful too, but it is not
      // an interception and must not corroborate one.
      const statusHit = nav?.status === 403 || nav?.status === 429 || nav?.status === 503;
      if (statusHit) evidence.push(`document returned HTTP ${nav?.status}`);
      // Keywords are REQUIRED here, not one vote among equals. This used to be
      // "any 2 of {url path, barren, keywords}", and the url-path vote is what
      // made it wrong: an ordinary email-verification or 2FA page sits on
      // /verify/ AND is barren, so those two convicted a page that was never a
      // challenge — while the agent was told its last action had not landed.
      // HTTP 403/429/503 replaces that vote as corroboration, and cannot convict
      // alone either: a plain Forbidden page is also barren and also 403.
      if (textHit && (barren || statusHit)) return { evidence };
    }

    if (vendorShown) return { evidence };

    // Structural fallback — the only branch that can catch a challenge nobody
    // has fingerprinted, which is the common case for a vendor that just
    // shipped a redesign. Shape of a slider challenge: a layer covering the
    // viewport, something to LOOK at inside it (the puzzle canvas/image), and
    // something to DRAG. Requiring the handle OR the keywords is what stops an
    // ordinary image lightbox — also a covering layer holding an <img> — from
    // reading as a challenge.
    const layer = overlayRoot();
    if (layer) {
      const media = layer.querySelector("canvas,img");
      const handle = layer.querySelector(DRAG_SEL);
      if (media && (handle || textHit)) {
        evidence.push(
          `viewport-covering layer holding <${media.tagName.toLowerCase()}>${handle ? " and a drag handle" : ""}`,
        );
        return { evidence };
      }
    }

    if (textHit && (layer || document.querySelector(DIALOG_SEL))) {
      evidence.push(`challenge keywords inside ${layer ? "a viewport-covering layer" : "an open dialog"}`);
      return { evidence };
    }

    // A fingerprint that is loaded but not displayed challenges nobody.
    return undefined;
  };

  // Only transitions are pushed, and the transition is BLOCKED ↔ CLEAR — not
  // "the evidence changed". A challenge renders in steps, and the branch that
  // fires moves while it does; keying on anything finer turned ONE challenge
  // into three `captcha_appeared`s inside 1s (observed on chat.deepseek.com),
  // each carrying a screenshot of a different half-rendered frame.
  let lastBlocked = false;
  const checkChallenge = (): CaptchaSignal | undefined => {
    const sig = detectChallenge();
    g.__bcpCaptcha = sig;
    if (!!sig !== lastBlocked) {
      lastBlocked = !!sig;
      if (sig) sendEvent("captcha_appeared", `possible challenge — ${sig.evidence[0]}`, { ...sig });
      else sendEvent("captcha_cleared", "challenge no longer detected");
    }
    return sig;
  };
  // Published only as the regression harness's seam (dom-runtime-check forces a
  // synchronous check instead of waiting out the 500ms observer beat).
  g.__bcpCheckCaptcha = checkChallenge;
  checkChallenge();

  const seenDialogs = new WeakSet<Element>();
  let pending = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const obs = new MutationObserver((records) => {
    pending += records.length;
    // Prompt dialog report: a newly-portaled custom modal.
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        const dlg = n.matches?.(DIALOG_SEL) ? n : n.querySelector?.(DIALOG_SEL);
        if (dlg && !seenDialogs.has(dlg)) {
          seenDialogs.add(dlg);
          const name = ((dlg as HTMLElement).getAttribute("aria-label") || (dlg as HTMLElement).innerText || "")
            .replace(/\s+/g, " ").trim().slice(0, 60);
          sendEvent("dialog", `dialog appeared${name ? `: ${name}` : ""}`);
        }
      }
    }
    // Throttle the mutation firehose into one summary per 500ms quiet window.
    if (timer) return;
    timer = setTimeout(() => {
      const n = pending;
      pending = 0;
      timer = undefined;
      if (n > 0) sendEvent("dom_changed", `${n} DOM change(s) since last beat`, { count: n });
      checkChallenge();
    }, 500);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // Bridge: MAIN-world probes post console errors here (they have no chrome API).
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data as { __bcp?: string; kind?: string; summary?: string; detail?: Record<string, unknown> } | null;
    if (!d || d.__bcp !== "event") return;
    sendEvent(d.kind ?? "console_error", d.summary ?? "", d.detail);
  });
}

/**
 * Injected on demand (MAIN world) alongside a snapshot: capture page-script
 * errors — only observable in the page's OWN world — and relay them to the
 * ISOLATED bridge via window.postMessage (MAIN has no chrome API). Idempotent.
 */
export function bcpMainConsoleProbe(): void {
  const w = window as unknown as { __bcpConsoleProbe?: boolean };
  if (w.__bcpConsoleProbe) return;
  w.__bcpConsoleProbe = true;
  const post = (summary: string, detail?: Record<string, unknown>): void => {
    window.postMessage({ __bcp: "event", kind: "console_error", summary, detail }, "*");
  };
  window.addEventListener("error", (e) => {
    post(`JS error: ${e.message}`, { message: e.message, source: e.filename, line: e.lineno });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    post(`Unhandled rejection: ${String(reason?.message ?? reason)}`);
  });
}

/**
 * Injected on demand (MAIN world) when the agent enables network-body capture
 * for a tab. Monkey-patches window.fetch + XMLHttpRequest to surface JSON/text
 * RESPONSE BODIES — the only way to read them without CDP. Bodies are posted to
 * the ISOLATED bridge (bcpEventProbes) as `network_body` events. Patches the
 * globals ONCE; a re-inject just re-arms __bcpNetOn (capture is toggled off by
 * flipping that flag, without un-patching). Best-effort: a capture error must
 * never break the page's own fetch/XHR.
 */
export function bcpNetworkPatch(): void {
  const w = window as unknown as { __bcpNetPatched?: boolean; __bcpNetOn?: boolean };
  w.__bcpNetOn = true; // (re)enable on every (re)inject
  if (w.__bcpNetPatched) return;
  w.__bcpNetPatched = true;

  const CAP = 8192;
  const wanted = (ct: string | null): boolean => !!ct && /(json|text|xml|javascript|urlencoded)/i.test(ct);
  const report = (method: string, url: string, status: number, ct: string | null, text: string): void => {
    if (!w.__bcpNetOn) return;
    const truncated = text.length > CAP;
    window.postMessage({
      __bcp: "event", kind: "network_body",
      summary: `body ${status} ${method} ${url}`,
      detail: { url, method, status, contentType: ct, body: truncated ? text.slice(0, CAP) : text, truncated: truncated || undefined },
    }, "*");
  };

  const origFetch = window.fetch;
  window.fetch = function (...args: Parameters<typeof fetch>): Promise<Response> {
    return origFetch(...args).then((resp) => {
      try {
        const ct = resp.headers.get("content-type");
        if (w.__bcpNetOn && wanted(ct)) {
          const req = args[0];
          const url = req instanceof Request ? req.url : String(req);
          const method = (args[1]?.method || (req instanceof Request ? req.method : "GET")).toUpperCase();
          resp.clone().text().then((t) => report(method, url, resp.status, ct, t)).catch(() => {});
        }
      } catch {
        /* never break the page's fetch */
      }
      return resp;
    });
  };

  // Loose signature: the native overloaded .open otherwise makes the forwarding
  // call infer its args as unknown. We only read method+url; async/user/password
  // pass straight through.
  const origOpen = XMLHttpRequest.prototype.open as (this: XMLHttpRequest, ...args: unknown[]) => void;
  const origSend = XMLHttpRequest.prototype.send;
  type XhrMeta = XMLHttpRequest & { __bcpM?: string; __bcpU?: string };
  XMLHttpRequest.prototype.open = function (this: XhrMeta, method: string, url: string | URL, ...rest: unknown[]): void {
    this.__bcpM = method;
    this.__bcpU = String(url);
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (this: XhrMeta, body?: Document | XMLHttpRequestBodyInit | null): void {
    this.addEventListener("load", () => {
      try {
        const ct = this.getResponseHeader("content-type");
        const readable = this.responseType === "" || this.responseType === "text";
        if (w.__bcpNetOn && wanted(ct) && readable) {
          report(this.__bcpM || "GET", this.__bcpU || "", this.status, ct, this.responseText);
        }
      } catch {
        /* ignore */
      }
    });
    return origSend.call(this, body);
  };
}

/**
 * Event-driven wait for a Book v2 signal condition. Injected by the service
 * worker with `world: "MAIN"` so `script` leaves can use `new Function` — the
 * MV3 extension's own CSP forbids eval in the isolated world, so arbitrary
 * page expressions can only run here (and a strict PAGE CSP can still block
 * them, exactly like browser.eval; that is fail-closed via `blocked`).
 *
 * Evaluates immediately, re-checks only after observed changes (MutationObserver
 * + load/popstate/hashchange, with a bounded safety wake-up for state that
 * changes without a DOM event), and resolves when the condition holds, the
 * deadline expires, or evaluation fails closed. ALWAYS cleans up its
 * observer/listeners/timers — success, timeout, or error.
 *
 * Navigation is NOT handled here: a navigation destroys this document (the
 * pending promise dies with it) and the service worker re-injects into the new
 * document with the remaining deadline.
 *
 * `domFactorySrc` is bcpDomHelpersFactory's own source (this function is
 * stringified into the page and cannot reach a sibling's closure); it becomes
 * the `bcpDom` a `script` leaf sees. Required, not optional: the one caller
 * that forgets it would produce gates that fail only on the pages that use it.
 */
export function bcpSignalWait(
  condition: unknown,
  timeoutMs: number,
  domFactorySrc: string,
): Promise<{
  satisfied: boolean;
  timedOut?: boolean;
  failedPaths?: string[];
  blocked?: string;
  url?: string;
  pageState?: { readyState: string; loading: boolean; errorCount: number };
  evidence?: unknown;
}> {
  const deadline = Date.now() + timeoutMs;
  const failed: string[] = [];
  let evidence: unknown;

  // `bcpDom` for `script` leaves, built from bcpDomHelpersFactory's own source
  // (handed in by the service worker) exactly the way browser.eval builds it —
  // so a gate and a step ask the SAME question about visibility instead of two
  // copies that drift apart. Bounded by THIS signal's deadline: nothing a gate
  // reaches for may outlive the gate's own budget.
  //
  // Why this exists: the predicate unification moved books from hand-copied
  // `getComputedStyle` checks to `bcpDom.visible`, and only the eval path
  // injected it — every converted signal died with "bcpDom is not defined"
  // (run 597a0cad, 6 signals in doudian-publish-canonical). The capability now
  // travels with BOTH evaluation paths, which is also why PROTOCOL_VERSION
  // moved: nothing in the RPC shape reveals which side of the fix you're on.
  let bcpDom: unknown;
  try {
    bcpDom = (new Function(`return (${domFactorySrc})`)() as (d: number) => unknown)(deadline);
  } catch {
    bcpDom = undefined; // a page CSP that blocks Function() blocks the leaf itself
  }

  const hasContent = (): boolean =>
    (document.body?.innerText?.trim().length ?? 0) > 0 || (document.body?.childElementCount ?? 0) > 2;
  const settledNow = (): boolean => document.readyState === "complete" && hasContent();
  // Network quiet, measured page-side. The service worker's per-tab in-flight
  // set isn't reachable from an injected function, so we count in flight here.
  //
  // PerformanceObserver('resource') is NOT enough: it only reports COMPLETED
  // entries, so "nothing landed for 500ms" is equally true when nothing is
  // happening and when the one request we are waiting on is still out — the
  // skeleton-screen case this leaf exists to catch. Counting in flight is the
  // only page-side way to tell those apart.
  //
  // Installed once per document and deliberately never uninstalled: it is a
  // pair of counters, and restoring the originals would race with requests
  // started under the wrapper. Tradeoff: this replaces `window.fetch` and
  // `XMLHttpRequest.prototype.send` in the MAIN world, so a page that compares
  // fetch by identity would see a different function.
  interface BcpNetState { inFlight: number; lastDoneAt: number }
  const NET_KEY = "__bcpNetState";
  const winAny = window as unknown as Record<string, unknown>;
  let net = winAny[NET_KEY] as BcpNetState | undefined;
  if (!net) {
    const st: BcpNetState = { inFlight: 0, lastDoneAt: Date.now() };
    winAny[NET_KEY] = st;
    const done = (): void => {
      st.inFlight = Math.max(0, st.inFlight - 1);
      st.lastDoneAt = Date.now();
    };
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function bcpFetch(this: unknown, ...args: Parameters<typeof fetch>) {
        st.inFlight += 1;
        let out: Promise<Response>;
        try {
          out = origFetch.apply(this as never, args) as Promise<Response>;
        } catch (e) {
          done();
          throw e;
        }
        return out.then(
          (r) => { done(); return r; },
          (e) => { done(); throw e; },
        );
      } as typeof fetch;
    }
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function bcpSend(this: XMLHttpRequest, ...args: unknown[]) {
      st.inFlight += 1;
      this.addEventListener("loadend", done, { once: true });
      return (origSend as (...a: unknown[]) => void).apply(this, args);
    } as typeof XMLHttpRequest.prototype.send;
    net = st;
  }
  const netState = net;
  const pageStateNow = () => ({
    readyState: document.readyState,
    loading: document.readyState !== "complete" || !hasContent(),
    errorCount: document.querySelectorAll('[role="alert"], [aria-live="assertive"]').length,
  });
  /** Same definition as bcpDomRuntime's isVisible and bcpDomHelpersFactory's
   *  `visible` — see the long note on the former for why it is this and not
   *  getComputedStyle. A third copy exists because each of these functions is
   *  stringified into the page on its own and cannot reach a sibling's closure;
   *  check:dom's V group runs one matrix against all three so they cannot drift.
   *
   *  This copy was the loosest of the seven: it answered 0x0, `scale(0)` and
   *  `font-size:0` as visible (getClientRects().length is non-zero for a
   *  zero-area box), which let a signal gate open on something nobody can see. */
  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const check = (el as Element & {
      checkVisibility?: (o?: Record<string, boolean>) => boolean;
    }).checkVisibility;
    if (typeof check !== "function") {
      const d = el.closest("details,summary");
      if (d && d !== el && d.nodeName === "DETAILS" && !(d as HTMLDetailsElement).open) return false;
      return getComputedStyle(el).visibility === "visible";
    }
    return check.call(el, {
      visibilityProperty: true,
      checkVisibilityCSS: true,
    });
  };
  /** Composed-DOM traversal: pierce open shadow roots and same-origin iframes,
   * matching the existing runtime's queryDeep semantics. */
  const shadowQuery = (root: ParentNode, selector: string): Element | null => {
    const direct = root.querySelector(selector);
    if (direct) return direct;
    for (const el of root.querySelectorAll("*")) {
      const shadow = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
      if (shadow) {
        const hit = shadowQuery(shadow, selector);
        if (hit) return hit;
      }
      if (el instanceof HTMLIFrameElement && el.contentDocument) {
        const hit = shadowQuery(el.contentDocument, selector);
        if (hit) return hit;
      }
    }
    return null;
  };

  /** Evaluate one condition node. Pushes failing leaf paths onto `failed`.
   * Throws when a `script` leaf is blocked or the node is malformed — the
   * caller turns that into a fail-closed `blocked` result. */
  const evalCond = async (cond: Record<string, unknown>, path: string): Promise<{ ok: boolean }> => {
    if (typeof cond.urlIncludes === "string") {
      const ok = location.href.includes(cond.urlIncludes);
      if (!ok) failed.push(path);
      if (ok) evidence = location.href;
      return { ok };
    }
    if (cond.settled === true) {
      const ok = settledNow();
      if (!ok) failed.push(path);
      return { ok };
    }
    if (typeof cond.networkIdle === "number") {
      // Both halves matter: nothing in flight AND quiet for long enough. A
      // request that is still out reports 0 quiet time, never idle.
      const quietFor = netState.inFlight === 0 ? Date.now() - netState.lastDoneAt : 0;
      const ok = netState.inFlight === 0 && quietFor >= cond.networkIdle;
      if (!ok) failed.push(path);
      if (ok) evidence = { networkIdleMs: quietFor, inFlight: netState.inFlight };
      return { ok };
    }
    if (typeof cond.selector === "string") {
      const el = shadowQuery(document, cond.selector);
      const visible = !!el && isVisible(el);
      const wantVisible = cond.state !== "hidden";
      const ok = wantVisible ? visible : !visible;
      if (!ok) failed.push(path);
      if (ok) evidence = { selector: cond.selector, found: !!el, visible };
      return { ok };
    }
    if (typeof cond.textPresent === "string") {
      const ok = (document.body?.innerText ?? "").includes(cond.textPresent);
      if (!ok) failed.push(path);
      if (ok) evidence = cond.textPresent;
      return { ok };
    }
    if (cond.script !== undefined && typeof cond.script === "object") {
      const s = cond.script as { code?: unknown; frameId?: unknown };
      if (s.frameId !== undefined && s.frameId !== 0) {
        throw new Error(`script leaf at ${path}: frameId ${JSON.stringify(s.frameId)} is not supported in signal waits (top frame only)`);
      }
      if (typeof s.code !== "string") throw new Error(`script leaf at ${path}: expected { code: string }`);
      let value: unknown;
      try {
        // MAIN world: the extension CSP does not apply; a strict page CSP may
        // still block new Function (same constraint as browser.eval).
        //
        // `bcpDom` is passed as a PARAMETER, with no ladder down to a smaller
        // param set the way browser.eval has one. The ladder is there for
        // arbitrary agent-written code that may declare its own binding; a
        // signal leaf is always compiled as an EXPRESSION (`return (code)`),
        // so a top-level declaration cannot occur at all. What CAN occur is an
        // inner `const bcpDom` shadowing the parameter — silently restoring a
        // hand-copied predicate — and check:books rejects that.
        value = new Function("bcpDom", `"use strict"; return (${s.code});`)(bcpDom);
      } catch (e) {
        throw new Error(`script leaf at ${path} was blocked: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (value && typeof (value as Promise<unknown>).then === "function") {
        value = await (value as Promise<unknown>);
      }
      const ok = !!value;
      if (!ok) failed.push(path);
      if (ok) evidence = value;
      return { ok };
    }
    if (Array.isArray(cond.all)) {
      for (let i = 0; i < cond.all.length; i++) {
        const r = await evalCond(cond.all[i] as Record<string, unknown>, `${path}.all[${i}]`);
        if (!r.ok) return { ok: false };
      }
      return { ok: true };
    }
    if (Array.isArray(cond.any)) {
      let anyOk = false;
      for (let i = 0; i < cond.any.length; i++) {
        const before = failed.length;
        const r = await evalCond(cond.any[i] as Record<string, unknown>, `${path}.any[${i}]`);
        if (r.ok) { anyOk = true; break; }
        failed.length = before; // a branch that failed must not leak its paths
      }
      if (!anyOk) failed.push(path);
      return { ok: anyOk };
    }
    if (cond.not !== undefined) {
      const before = failed.length;
      const r = await evalCond(cond.not as Record<string, unknown>, `${path}.not`);
      const ok = !r.ok;
      failed.length = before; // inner failure is success for `not` — drop its paths
      if (!ok) failed.push(path);
      return { ok };
    }
    throw new Error(`signal condition at ${path}: no recognized discriminator`);
  };

  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: ReturnType<typeof setInterval> | undefined;
    let observer: MutationObserver | undefined;
    const listeners: Array<[EventTarget, string, EventListener]> = [];

    const finish = (r: {
      satisfied: boolean;
      timedOut?: boolean;
      failedPaths?: string[];
      blocked?: string;
      evidence?: unknown;
    }): void => {
      if (done) return;
      done = true;
      observer?.disconnect();
      for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
      if (timer) clearTimeout(timer);
      if (wake) clearInterval(wake);
      resolve({ ...r, url: location.href, pageState: pageStateNow() });
    };

    const evaluate = async (): Promise<void> => {
      if (done || Date.now() >= deadline) return;
      failed.length = 0;
      evidence = undefined;
      try {
        const r = await evalCond(condition as Record<string, unknown>, "condition");
        if (r.ok) finish({ satisfied: true, evidence });
      } catch (e) {
        finish({ satisfied: false, blocked: e instanceof Error ? e.message : String(e) });
      }
    };

    if (document.readyState === "loading") {
      const onReady = () => void evaluate();
      document.addEventListener("DOMContentLoaded", onReady, { once: true });
      listeners.push([document, "DOMContentLoaded", onReady]);
    }
    const onWindowEvent = () => void evaluate();
    for (const type of ["load", "popstate", "hashchange"] as const) {
      window.addEventListener(type, onWindowEvent);
      listeners.push([window, type, onWindowEvent]);
    }
    const root = document.documentElement;
    if (root) {
      observer = new MutationObserver(() => void evaluate());
      // attributes included: SPAs flip readiness via class/style/aria-busy
      // attribute changes with no structural mutation.
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    }
    // Bounded safety wake-up for state that changes without a DOM event.
    wake = setInterval(() => void evaluate(), 500);
    timer = setTimeout(() => {
      finish({
        satisfied: false,
        timedOut: true,
        failedPaths: failed.length ? failed.slice() : undefined,
      });
    }, Math.max(0, deadline - Date.now()));

    void evaluate();
  });
}

/**
 * Waiting primitives handed to `browser.eval` code as `bcpWait`.
 *
 * WHY this exists: a book that needs "wait until the page reacted" had no
 * primitive for it, so 45 hand-written `setTimeout` loops grew inside eval —
 * many of them fixed sleeps that are either too short (flaky) or too long
 * (slow). These helpers give the four shapes that were actually being
 * hand-rolled, bounded and uniform.
 *
 * Self-contained on purpose (like every other bcp* function here): it is
 * stringified and re-created inside the page, which is also what lets the real
 * code path be exercised by `pnpm check:dom`.
 *
 * Every helper REPORTS success instead of throwing — what an un-settled page
 * means is the book's decision, not this layer's — and is bounded by BOTH its
 * own `maxMs` and the caller's `bcpDeadline`, so no helper can overrun the
 * eval budget.
 */
/**
 * DOM primitives handed to `browser.eval` code as `bcpDom`.
 *
 * WHY this exists: books were hand-copying three helpers into every eval block
 * — 81 copies of the visibility predicate, plus `press` — and the copies had
 * DIVERGED into five mutually inconsistent definitions of "visible". Measured
 * against Playwright's definition over the 22 ways CSS/HTML can hide an
 * element, they disagreed on 2-10 rows each (variant C answered `display:none`
 * on an ANCESTOR as visible — an element not in the render tree at all).
 *
 * The definition here is not invented: it is the one `checkVisibility()` gives,
 * which is the only way to see `content-visibility` and a closed `<details>` —
 * both invisible to `getComputedStyle`, and both answered wrong by all seven
 * predicates that existed before. Playwright reaches the same answer the same
 * way (`computeElementStyleVisibilityVisible` in its injected domUtils).
 *
 * Self-contained on purpose, like every other bcp* function here: it is
 * stringified into the page, which is also what lets `pnpm check:dom` exercise
 * the real code path. That self-containment is why the runtime's OWN isVisible
 * (inside bcpDomRuntime) stays a separate copy — a stringified function cannot
 * reach a sibling's closure. The copies are kept honest by running the same
 * 22-row matrix against each of them, not by trying to share one symbol.
 */
export function bcpDomHelpersFactory(bcpDeadline?: number) {
  /** Visible = what the browser itself says, plus a non-empty box.
   *
   *  `checkVisibility` alone is NOT enough in either direction:
   *   - bare `checkVisibility()` leaves `visibilityProperty` OFF, so it answers
   *     `visibility:hidden` as VISIBLE;
   *   - it ignores geometry entirely, so 0x0 / `scale(0)` / `font-size:0` all
   *     come back visible.
   *  Two options are deliberately left OFF:
   *   - `opacityProperty` — an `opacity:0` element still occupies layout and
   *     still receives clicks, so Playwright counts it visible and so do we.
   *     (The old runtime predicate tested `opacity !== "0"` on the element only,
   *     which also meant the same visual result answered differently depending
   *     on whether the author set it on the node or its parent.)
   *   - `contentVisibilityAuto` — a virtualised row scrolled out of view would
   *     become invisible, and that DEADLOCKS the caller: a row the locator
   *     cannot find is a row nobody can scroll to, so "no match" is terminal.
   *     Left visible, the locator resolves it and the click's own scroll
   *     alignment renders it. Playwright makes the same call. NOTE this one is
   *     unverified by check:dom — see the honest-limit note on V-cv-auto-offscreen.
   *
   *  Both the new option names and their older aliases are passed: unknown
   *  dictionary keys are silently ignored, so this is the only spelling that
   *  works on an engine that knows just one of the two sets. */
  const visible = (el: Element): boolean => {
    const check = (el as Element & {
      checkVisibility?: (o?: Record<string, boolean>) => boolean;
    }).checkVisibility;
    if (typeof check === "function") {
      if (!check.call(el, {
        visibilityProperty: true,
        checkVisibilityCSS: true,
      })) return false;
    } else {
      // Pre-checkVisibility fallback, same shape as Playwright's WebKit
      // workaround. It cannot see `content-visibility`; nothing available here
      // can, so that gap is reported by omission rather than papered over.
      const d = el.closest("details,summary");
      if (d && d !== el && d.nodeName === "DETAILS" && !(d as HTMLDetailsElement).open) return false;
      if (getComputedStyle(el).visibility !== "visible") return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  /** Elements whose own text matches and whose children do NOT also contain it —
   *  i.e. the deepest holders of that text.
   *
   *  Returns an ARRAY, and that is the point. The hand-copied book version
   *  sorted by descendant count and returned `[0]`, which silently picks one of
   *  several equally-deep matches — the exact guess that strictness exists to
   *  prevent, and the shape of the 2026-09-08 failure where a click landed on a
   *  row container and still reported ok:true. A caller that wants one element
   *  must now see that there were three. */
  const innermost = (root: ParentNode, text: string, opts?: { exact?: boolean; selector?: string }): HTMLElement[] => {
    const want = text.replace(/[​­]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    const norm = (s: string): string => s.replace(/[​­]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    const hit = (el: Element): boolean => {
      const t = norm(el.textContent || "");
      return t ? (opts?.exact ? t === want : t.includes(want)) : false;
    };
    return [...root.querySelectorAll<HTMLElement>(opts?.selector ?? "*")]
      .filter((el) => hit(el) && visible(el))
      .filter((el) => ![...el.children].some(hit));
  };

  /** Dispatch a pointer sequence at the element's centre.
   *
   *  `pointerenter`/`mouseenter` do NOT bubble, and a real mouse move fires them
   *  on every ancestor along the cursor's path (outermost → innermost). A single
   *  dispatchEvent does not, so a hover-only menu whose listener sits on a
   *  wrapper ABOVE the hit node never hears it — it just looks like "I hovered
   *  and nothing opened" (learn 2026-08-19). Hence the explicit ancestor walk,
   *  which both shapes below share. */
  /** Is the element actually painted at the point we would aim at?
   *  Playwright's rule: the hit passes when it IS the target or a DESCENDANT of
   *  it, since the browser dispatches to whatever covers the point. An ancestor
   *  or an unrelated node means something is on top. */
  const hitTest = (el: Element): { ok: boolean; target: Element; x: number; y: number; cover: string } => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const ok = !!hit && (hit === el || el.contains(hit));
    const cover = ok || !hit ? "" : hit.tagName.toLowerCase() +
      (hit.id ? `#${hit.id}` : (hit as HTMLElement).className && typeof (hit as HTMLElement).className === "string"
        ? `.${(hit as HTMLElement).className.trim().split(/\s+/)[0]}` : "");
    return { ok, target: ok && hit ? hit : el, x, y, cover };
  };

  const sequence = (el: Element, types: string[]): boolean => {
    const { ok: hitOk, target: hitTarget, x, y } = hitTest(el);
    const hit: Element | null = hitOk ? hitTarget : null;
    // Whether the element is actually PAINTED at the point we are about to aim
    // at. Playwright's rule: the hit passes when it is the target or a
    // descendant (the browser dispatches to whatever covers the point); an
    // ancestor or an unrelated node means something is on top.
    //
    // The event is still dispatched when this is false, deliberately — the 32
    // call sites inherited that behaviour and changing it silently would break
    // working books. But the verdict is RETURNED instead of swallowed, because
    // `? hit : el` on its own is exactly the pattern CLAUDE.md records as
    // removed from realClick: it makes a click on a covered element report
    // success. A caller that ignores the return value gets the old behaviour;
    // one that checks it can tell "I clicked" from "I clicked the overlay".
    const covered = !hit;
    const target = hit ?? el;
    const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    const chain: Element[] = [];
    for (let n: Element | null = target; n; n = n.parentElement) chain.push(n);
    for (const n of chain.reverse())
      for (const t of ["pointerenter", "mouseenter"])
        n.dispatchEvent(new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, { ...o, bubbles: false }));
    for (const t of types)
      target.dispatchEvent(new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, o));
    return !covered;
  };

  /** Move the pointer onto the element WITHOUT pressing — for UI that reveals
   *  itself on mouseover (tooltips, row action buttons, flyout menus).
   *
   *  LIMIT, and it is a hard one: this fires the JS events, and that is all it
   *  can do. A layer that opens purely through the CSS `:hover` pseudo-class,
   *  with no listener behind it, will NOT open — a synthetic event cannot put
   *  the engine into hover state. Same class of ceiling as the native file
   *  dialog; only CDP-level input injection clears it, and this project is
   *  deliberately CDP-free. If a menu refuses to open, that is the first thing
   *  to suspect, not your locator. */
  const HOVER_SEQ = ["pointerover", "mouseover", "pointermove", "mousemove"];
  const hover = (el: Element): boolean => sequence(el, HOVER_SEQ);

  /** The full press: the hover sequence, then down/up/click. Kept as one call
   *  because a real click is always preceded by the pointer arriving.
   *
   *  → `true` when the element was really painted at the point aimed at;
   *  `false` when something covered it (the events still went out — see
   *  `sequence`). **Check it.** A `false` you ignore is a click you believe
   *  happened and did not.
   *
   *  SCOPE — this is a LOW-LEVEL dispatcher, not the `click` MCP tool. That
   *  tool routes through `reachTarget`, which additionally waits for the element
   *  to be actionable, scrolls it into view rotating the alignment, RETRIES when
   *  the hit test fails, and finally raises `click intercepted` instead of
   *  guessing. None of that exists here: eval code runs a single synchronous
   *  pass. So when a click needs to survive an overlay, an off-screen position
   *  or a mid-flight animation, drive it with the `click` tool as its own book
   *  step; reach for `bcpDom.press` when you are inside one eval doing many
   *  interactions (matching 21 spec rows, say) and the elements are already
   *  settled and on screen. */
  const PRESS_SEQ = [...HOVER_SEQ, "pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  const press = (el: Element): boolean => sequence(el, PRESS_SEQ);

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(() => r(), ms));
  /** One rendering step. rAF is FROZEN in a background tab, so it is raced with
   *  a timer — otherwise a click in a tab the user is not looking at would hang
   *  until the eval budget killed it. */
  const frame = (): Promise<void> =>
    new Promise((r) => {
      if (document.hidden) return void setTimeout(() => r(), 16);
      let done = false;
      const fire = (): void => { if (!done) { done = true; r(); } };
      requestAnimationFrame(fire);
      setTimeout(fire, 100);
    });

  /** Click that KEEPS TRYING — the eval-side counterpart of the `click` MCP
   *  tool, for the gap that tool cannot cover: interactions that must happen
   *  inside one eval (matching 21 spec rows, walking a table) and therefore
   *  never pass through `reachTarget`.
   *
   *  Each round: check it is visible and enabled → scroll it into view, rotating
   *  the alignment (a sticky header can hide a row aligned one way and not
   *  another) → wait a rendering step → hit-test → dispatch ONLY on a pass.
   *  Dispatching only on a pass is the whole point: `press` fires regardless, so
   *  retrying with it would click two, three, four times.
   *
   *  REPORTS instead of throwing, like every bcpWait helper — what a failed
   *  click means is the book's decision — and is bounded by both its own
   *  timeout and the caller's eval deadline, so it cannot outlive the budget.
   *
   *  → `{ok, attempts, reason}`; `reason` names the cover when something is on
   *  top ("被 div#mask 盖住"), which is the one thing a book cannot find out
   *  for itself afterwards. */
  const click = async (
    el: Element,
    opts?: { timeoutMs?: number },
  ): Promise<{ ok: boolean; attempts: number; reason?: string }> => {
    const cap = typeof bcpDeadline === "number" ? bcpDeadline : Infinity;
    const until = Math.min(Date.now() + (opts?.timeoutMs ?? 3000), cap);
    const ALIGN: ScrollLogicalPosition[] = ["center", "nearest", "start", "end"];
    let why = "";
    for (let attempt = 0; ; attempt++) {
      if (!el.isConnected) {
        why = "目标已从 DOM 移除";
      } else if (!visible(el)) {
        why = "目标不可见";
      } else if ((el as HTMLInputElement).disabled || el.getAttribute("aria-disabled") === "true") {
        why = "目标 disabled";
      } else {
        el.scrollIntoView({ block: ALIGN[attempt % ALIGN.length], inline: "center" });
        await frame();
        const h = hitTest(el);
        if (h.ok) {
          sequence(el, PRESS_SEQ);
          return { ok: true, attempts: attempt + 1 };
        }
        why = h.cover ? `被 ${h.cover} 盖住` : "命中测试落空（目标没画在自己的中心点上）";
      }
      if (Date.now() >= until) return { ok: false, attempts: attempt + 1, reason: why };
      await sleep(100);
    }
  };

  /** Write a value the way a framework-controlled input will accept it.
   *
   *  React (and Vue's `v-model`, and every other library that keeps a shadow
   *  copy of the value) installs its own `value` accessor and treats a plain
   *  `el.value = x` as an external write to be discarded on the next render.
   *  Going through the PROTOTYPE's setter writes the real DOM property without
   *  tripping that guard — which is why the engine's own `type` op has always
   *  done it this way (`setNativeValue` in bcpDomRuntime).
   *
   *  Deliberately dispatches NOTHING. Which events make the framework re-read
   *  the field is the book's call — `input` for most controls, `input`+`change`
   *  for a `<select>`, and sometimes neither (see the `_valueTracker` case in
   *  doudian-after-watch-config step 6, where firing an extra event would race
   *  two queries against each other; learn 2026-09-14). A primitive that fired
   *  events for you would make that case impossible to express. */
  const setValue = (el: Element, value: string): void => {
    const proto =
      typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : typeof HTMLInputElement !== "undefined"
          ? HTMLInputElement.prototype
          : null;
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : undefined;
    if (setter) setter.call(el, value);
    else (el as HTMLInputElement).value = value;
  };

  /** Put files on a `<input type=file>` — the only way to fill one without a
   *  native file dialog (which no extension can drive).
   *
   *  Three things it gets right that the three hand-copied versions in the
   *  books disagreed about:
   *   1. the PROTOTYPE `files` setter, not `el.files = …` — same framework
   *      guard as `setValue`; a plain assignment is what React resets back to
   *      an empty FileList (skill §12, and the 抖店 CSV import that reported
   *      "文件上传失败" until it was fixed);
   *   2. `input` THEN `change`, once each — identical to the engine's own
   *      upload op, which is what the `upload_file` tool already fires at this
   *      very site's uploaders. Two of the three hand-copies sent something
   *      else; nothing made them agree;
   *   3. it RETURNS how many files actually landed, read back from the input.
   *      A framework that rejected the write leaves 0 there, and that is the
   *      difference between "uploaded" and "believed I uploaded". */
  const setFiles = (el: Element, files: File[] | FileList): number => {
    const dt = new DataTransfer();
    for (const f of Array.from(files as ArrayLike<File>)) dt.items.add(f);
    const setter =
      typeof HTMLInputElement !== "undefined"
        ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set
        : undefined;
    if (setter) setter.call(el, dt.files);
    else (el as HTMLInputElement).files = dt.files;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return (el as HTMLInputElement).files?.length ?? 0;
  };

  return { visible, innermost, hover, press, click, setValue, setFiles };
}

export function bcpWaitFactory(bcpDeadline: number) {
  type NetRec = { at: number };
  type Win = { __bcpWaitPatched?: boolean; __bcpWaitNet?: NetRec[] };
  const w = window as unknown as Win;

  // In-flight counter over the page's own fetch/XHR. Requests older than
  // MAX_AGE are dropped from the count ON PURPOSE: a hung request (an
  // ERR_TIMED_OUT can sit in flight for a minute) would otherwise make "idle"
  // never true — the exact failure that made a `networkIdle` gate time out at
  // 30s (learn 2026-09-02: measured in steady state, used to predict transient
  // behaviour).
  const MAX_AGE = 10_000;
  if (!w.__bcpWaitPatched) {
    w.__bcpWaitPatched = true;
    w.__bcpWaitNet = [];
    const open = (): (() => void) => {
      const rec: NetRec = { at: Date.now() };
      w.__bcpWaitNet!.push(rec);
      return () => {
        const i = w.__bcpWaitNet!.indexOf(rec);
        if (i >= 0) w.__bcpWaitNet!.splice(i, 1);
      };
    };
    const origFetch = window.fetch;
    window.fetch = function (this: unknown, ...a: Parameters<typeof fetch>): Promise<Response> {
      let close: () => void;
      try {
        close = open();
      } catch {
        return origFetch.apply(this as never, a); // never break the page's fetch
      }
      return origFetch.apply(this as never, a).then(
        (r) => {
          close();
          return r;
        },
        (e) => {
          close();
          throw e;
        },
      );
    };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest,
      ...a: Parameters<XMLHttpRequest["send"]>
    ): void {
      try {
        const close = open();
        this.addEventListener("loadend", close, { once: true });
      } catch {
        /* never break the page's XHR */
      }
      return origSend.apply(this, a);
    };
  }

  const inflight = (): number => {
    const arr = w.__bcpWaitNet ?? [];
    const cut = Date.now() - MAX_AGE;
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i].at < cut) arr.splice(i, 1);
    return arr.length;
  };
  const endBy = (ms: number): number => Date.now() + Math.max(0, Math.min(ms, bcpDeadline - Date.now()));
  const nap = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, bcpDeadline - Date.now()))));

  return {
    /** Sleep, never past `bcpDeadline`. */
    sleep: nap,

    /** True once no fetch/XHR has been in flight for `quietMs`; false at `maxMs`. */
    netIdle: async (quietMs = 500, maxMs = 5000): Promise<boolean> => {
      const end = endBy(maxMs);
      let quietSince = inflight() === 0 ? Date.now() : 0;
      for (;;) {
        if (inflight() === 0) {
          if (!quietSince) quietSince = Date.now();
          if (Date.now() - quietSince >= quietMs) return true;
        } else quietSince = 0;
        if (Date.now() >= end) return false;
        await nap(50);
      }
    },

    /** True once the DOM has not mutated for `quietMs`; false at `maxMs`. */
    domQuiet: (quietMs = 250, maxMs = 5000): Promise<boolean> =>
      new Promise((resolve) => {
        const end = endBy(maxMs);
        let quiet: ReturnType<typeof setTimeout> | undefined;
        let hard: ReturnType<typeof setTimeout> | undefined;
        const stop = (v: boolean): void => {
          obs.disconnect();
          if (quiet) clearTimeout(quiet);
          if (hard) clearTimeout(hard);
          resolve(v);
        };
        const arm = (): void => {
          // NOT clamped to the remaining budget: a quiet window shortened to fit
          // before `end` would fire at (or just before) the hard timeout and
          // report "settled" for a page that never stopped mutating — the
          // dangerous direction. Too little time left to observe a full window
          // means the answer is simply "not settled", which `hard` reports.
          if (end - Date.now() <= quietMs) return;
          quiet = setTimeout(() => stop(true), quietMs);
        };
        const obs = new MutationObserver(() => {
          if (quiet) clearTimeout(quiet);
          arm();
        });
        hard = setTimeout(() => stop(false), Math.max(0, end - Date.now()));
        const root = document.documentElement;
        // attributes included: SPAs flip readiness via class/style/aria-busy with
        // no structural mutation (same reason bcpSignalWait watches them).
        if (root) obs.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
        arm();
      }),

    /** Poll `fn` until it returns truthy; that value, or null at `maxMs`. */
    until: async <T>(fn: () => T | Promise<T>, maxMs = 5000, pollMs = 100): Promise<T | null> => {
      const end = endBy(maxMs);
      for (;;) {
        try {
          const v = await fn();
          if (v) return v;
        } catch {
          /* a throw is "not yet", not a failure — keep polling */
        }
        if (Date.now() >= end) return null;
        await nap(pollMs);
      }
    },

    /** Read `fn` until the count stops changing for `rounds` consecutive reads;
     * returns the settled count, or the last one seen at `maxMs`. For lazy lists
     * and infinite scroll, where "loaded" means "stopped growing". */
    grew: async (
      fn: () => number,
      opts?: { everyMs?: number; maxMs?: number; rounds?: number },
    ): Promise<number> => {
      const everyMs = opts?.everyMs ?? 400;
      const rounds = opts?.rounds ?? 2;
      const end = endBy(opts?.maxMs ?? 8000);
      let last = NaN;
      let stable = 0;
      for (;;) {
        let n = last;
        try {
          n = Number(fn()) || 0;
        } catch {
          /* keep the previous reading */
        }
        if (n === last) {
          if (++stable >= rounds) return n;
        } else {
          stable = 0;
          last = n;
        }
        if (Date.now() >= end) return last;
        await nap(everyMs);
      }
    },
  };
}
