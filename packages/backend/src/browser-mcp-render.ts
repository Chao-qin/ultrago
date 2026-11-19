/**
 * Tool-reply rendering: how a snapshot, a delta, a page state or a verify
 * outcome is spelled out for the model.
 *
 * Split out of browser-mcp.ts. These are pure string builders — they take a
 * protocol value and return text, touching neither the server nor the session
 * closure — so they are the part of that file that can be read, and tested,
 * on its own.
 */
import { CHROME_RENDERING_FLAGS, RpcMethod, toolNameOf, type ActionDelta, type PageState, type SnapshotElement, type StepVerify, type TabInfo } from "@bcp/shared";
import type { RecordingNote } from "./orchestrator.js";
import type { ReadDump } from "./browser-read-dump.js";

/** A plain-text tool reply. Every tool answers with one of these two, so they
 *  live beside the renderers rather than in the registration file. */
export const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
export const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

/** Render only dump metadata. The page body stays in backend-owned temporary
 * files so reading it is an explicit, local file operation rather than an
 * automatic addition to the model transcript. */
export function renderReadDump(dump: ReadDump): string {
  const headings = dump.overview.headings.length
    ? dump.overview.headings.join(" → ") + (dump.overview.headingsTruncated ? " → …" : "")
    : "(no visible h1–h6 headings detected)";
  return [
    `Page text dumped to temporary files; body intentionally omitted from this MCP reply.`,
    `Manifest: ${dump.manifestPath}`,
    `Directory: ${dump.directory}`,
    `Chunks: ${dump.chunkCount} × up to ${dump.chunkChars} characters; total: ${dump.totalChars}`,
    `Overview: ${dump.title || "(untitled)"} — headings: ${headings}`,
    `Opening excerpt: ${dump.overview.excerpt || "(empty)"}`,
    `Read the manifest first, then only the chunk file(s) needed for the current question. The dump is deleted before the next browser operation.`,
  ].join("\n");
}

/** How a tool reply names the element it acted on: the ref, the point, or the description it was given. */
export function describeTarget(t: { ref?: string; text?: string; role?: string; name?: string; css?: string; near?: string; x?: number; y?: number }): string {
  if (t.ref) return t.ref;
  if (t.x !== undefined && t.y !== undefined) return `(${t.x},${t.y})`;
  const bits = [
    t.text && `text=${JSON.stringify(t.text)}`,
    t.role && `role=${t.role}`,
    t.name && `name=${JSON.stringify(t.name)}`,
    t.css && `css=${t.css}`,
    t.near && `near=${JSON.stringify(t.near)}`,
  ].filter(Boolean);
  return bits.length ? bits.join(" + ") : "the target";
}

/** A playbook step's action as the tool call that performs it. */
export function describeAction(action: { method: string; params: Record<string, unknown> } | undefined): string {
  if (!action) return "(check-only — nothing to perform)";
  const tool = toolNameOf(action.method);
  const args = JSON.stringify(action.params);
  if (!tool) return `${action.method} ${args} (runner-only — no tool performs it; use mode:"auto")`;
  if (action.method === RpcMethod.ClickText) return `click ${JSON.stringify({ ...action.params })} (text matched innermost-first; pass nth when several match)`;
  return `${tool} ${args}`;
}

/** After a gate-triggering action, the tool result appends this reminder so ANY
 * MCP client (not just an SDK with PostToolUse hooks) is told to re-read the page
 * before acting further. Selective: only appends when `reason` is non-null. This
 * replaces the old side-panel-agent-only PostToolUse verify gate. */
export function gateNote(reason: string | null): string {
  return reason
    ? `\n⚠ Verify gate — ${reason}. Before any further action you MUST re-read the page yourself (\`analyze_page\`, or \`snapshot\`/\`screenshot\`) to confirm it's in the expected state. Mandatory, not a judgment call.`
    : "";
}

/** Gate ③/④: the action's own delta reported a modal, a selector-free
 * interruption (scroll lock / center overlay), or new errors. */
export function deltaGate(delta?: ActionDelta): string | null {
  if (!delta) return null;
  if (delta.dialogsOpened || delta.scrollLocked || delta.overlay || delta.newErrors?.length)
    return "a dialog/overlay appeared or new errors showed up";
  return null;
}

/** One line naming exactly what appeared since this caller's previous snapshot.
 *  A snapshot without it is an undifferentiated full page every time: the caller
 *  has to re-scan everything it already read to find the one control that is
 *  new, and pays that scan on every beat. Refs survive re-snapshots now, so
 *  "e37 is new" is a durable statement rather than a renumbering artefact. */
export function renderSnapshotDelta(changed?: { added: string[]; removed: number }, coverage: { partial?: boolean; previousPartial?: boolean } = {}): string {
  if (!changed) return ""; // first snapshot of this page — nothing to compare against
  const bits: string[] = [];
  if (changed.added.length)
    bits.push(
      changed.added.length <= 12
        ? `NEW since your last snapshot: ${changed.added.join(", ")}`
        : `${changed.added.length} NEW elements since your last snapshot (first 12: ${changed.added.slice(0, 12).join(", ")})`,
    );
  if (changed.removed) bits.push(`${changed.removed} gone`);
  if (!bits.length) return "";
  // "Already read" is only true when the previous reply showed everything and this one does too; after a paged
  // or narrowed reply the agent never saw the rest, and must not be told it did.
  const rest = coverage.partial || coverage.previousPartial
    ? "start with those; earlier replies showed only part of the page, so other elements may still be unread."
    : "start with those; the rest is what you already read.";
  return `\n\n↳ ${bits.join(" · ")} — ${rest}`;
}

export function renderSnapshot(els: SnapshotElement[]): string {
  // An empty snapshot is the sharpest form of "I read the page and don't know what I missed": the answer is
  // not more description, it is naming the instruments that CAN see this page. Snapshot only ever reports
  // link/button/input/[role]/[tabindex]/cursor:pointer, so zero here means no [ref] can exist at all.
  if (els.length === 0)
    return (
      "(no interactable elements found — nothing here matches link/button/input/[role]/[tabindex]/cursor:pointer, " +
      "so no [ref] can exist and re-snapshotting will return this again. `page_state` says whether the page is " +
      "still loading/hydrating, `read_content` reads text that carries no controls, and a screenshot shows a " +
      "canvas/image UI — a control you can only SEE is clickable with click({x,y}).)"
    );
  // An open modal redefines what "the page" is: everything behind it is
  // unreachable until it closes. Listing those elements as if they were
  // actionable is the biggest single reason an agent picks a target it cannot
  // click, then reads "nothing changed" and cannot explain why. Collapse them
  // into one honest line instead — the count stays visible, the noise doesn't.
  // Nest by parentRef so the flat list reads as the structure it came from.
  const byRef = new Map(els.map((e) => [e.ref, e] as const));
  const childrenOf = new Map<string, SnapshotElement[]>();
  const roots: SnapshotElement[] = [];
  for (const e of els) {
    const pr = e.parentRef && byRef.has(e.parentRef) ? e.parentRef : undefined;
    if (pr) (childrenOf.get(pr) ?? childrenOf.set(pr, []).get(pr)!).push(e);
    else roots.push(e);
  }
  const line = (e: SnapshotElement, depth: number): string => {
    const parts = [`${"  ".repeat(depth)}[${e.ref}]`, e.role];
    // A group's name is just its descendants' text concatenated, so show a short
    // form — but only here. The full name stays on the wire because
    // orchestrator's elementName predicate matches against it.
    if (e.name) parts.push(`"${e.container && e.name.length > 30 ? `${e.name.slice(0, 30)}…` : e.name}"`);
    if (e.container) parts.push("(group)");
    if (e.value) parts.push(`value="${e.value}"`);
    if (e.checked !== undefined) parts.push(e.checked ? "[checked]" : "[unchecked]");
    if (e.options) parts.push(`options=[${e.options.join(" | ")}]`);
    if (e.expanded !== undefined) parts.push(e.expanded ? "[expanded]" : "[collapsed]");
    // Right after expanded, because together they are one statement: THAT a
    // disclosure opened, and WHICH ref it opened. Rendered as a trailing
    // annotation rather than as nesting — the tree above is built from parentRef
    // alone, and a second edge type would give a node two parents (a portaled
    // panel is a <body> child AND controlled by a button deep in the page),
    // which no single indentation can express.
    if (e.controls) parts.push(`→[${e.controls.join("][")}]`);
    if (e.invalid) parts.push(e.invalidMessage ? `[invalid: ${e.invalidMessage}]` : "[invalid]");
    if (e.busy) parts.push("[busy]");
    if (e.disabled) parts.push("[disabled]");
    if (e.hidden) parts.push("[hidden]");
    if (e.clickable) parts.push("[clickable]");
    if (e.inViewport === false) parts.push("[offscreen]");
    if (e.scrollable) parts.push("(scrollable)");
    // Zone last: it reads as a trailing address, so a column of them stays
    // scannable when the agent is looking for "what's in the dialog".
    if (e.zone) parts.push(`@${e.zone}`);
    // Geometry after the zone — this is what ties a thing seen in a screenshot
    // to a ref that can be acted on, and vice versa.
    if (e.rect) parts.push(`(${e.rect[0]},${e.rect[1]} ${e.rect[2]}×${e.rect[3]})`);
    return parts.join(" ");
  };
  const out: string[] = [];
  const walk = (e: SnapshotElement, depth: number): void => {
    out.push(line(e, depth));
    for (const c of childrenOf.get(e.ref) ?? []) walk(c, depth + 1);
  };
  for (const e of roots) walk(e, 0);
  return out.join("\n");
}

/** Which window the user is on. The browser reports no focused window whenever none of ITS windows has focus —
 *  another app, another browser, or another profile of the same browser (whose windows it cannot see) may be in
 *  front, so the wording claims only that. The last focused window is then the best answer to "the current page". */
export function windowFocusLabel(windowId: number, focusedWindowId: number | null, lastFocusedWindowId?: number | null): string {
  if (windowId === focusedWindowId) return " (OS-focused — user is here)";
  if (focusedWindowId == null && windowId === lastFocusedWindowId) return " (last focused — no window of this browser is in front right now)";
  return "";
}

export function windowFocusLegend(windowCount: number, focusedWindowId: number | null): string {
  const star = windowCount > 1 ? "* marks each window's own active tab, so several * are normal. " : "";
  return `${star}${focusedWindowId == null ? "No window of this browser has OS focus right now — the user is in something else (another app, browser or profile)." : ""}`.trim();
}

/** Narrowing for a snapshot reply. Every ref stays valid whatever is shown: this narrows the reply, not the page.
 *  `after` continues from a ref rather than a position: each call takes a fresh snapshot, and a position would
 *  skip or repeat elements whenever the page added or removed some in between. */
export interface SnapshotView { query?: string; viewportOnly?: boolean; limit?: number; after?: string }

/** One reply of a 2,581-element page came to 116,063 characters and the MCP client refused it outright, so the
 *  agent lost the result and every [ref] in it. Past this size the reply pages instead. */
export const SNAPSHOT_CHAR_BUDGET = 30_000;
/** page_state's count is a lower bound of snapshot's (top frame, no cursor:pointer); past this it suggests narrowing. */
const LARGE_PAGE = 500;

/** Renders a snapshot reply for `tool`. `partial` says whether this reply left elements out; the caller keeps it
 *  per tab so the next reply's delta does not claim the agent "already read" elements it was never shown. */
export function renderSnapshotView(
  els: SnapshotElement[],
  view: SnapshotView = {},
  opts: { tool?: "snapshot" | "analyze_page"; changed?: { added: string[]; removed: number }; previousPartial?: boolean } = {},
): { text: string; partial: boolean } {
  const tool = opts.tool ?? "snapshot";
  const query = view.query?.trim().toLowerCase();
  let matched = els;
  if (query) matched = matched.filter((e) => [e.role, e.name, e.value, ...(e.options ?? [])].some((v) => v?.toLowerCase().includes(query)));
  if (view.viewportOnly) matched = matched.filter((e) => e.inViewport === true);
  const narrowed = !!query || !!view.viewportOnly;
  const filter = [query ? `query=${JSON.stringify(view.query)}` : "", view.viewportOnly ? "viewportOnly" : ""].filter(Boolean).join(" ");
  let start = 0;
  let restarted = "";
  if (view.after) {
    const at = matched.findIndex((e) => e.ref === view.after);
    if (at < 0) restarted = `[${view.after}] is no longer on the page${narrowed ? " or no longer matches" : ""}, so this starts again from the first element. `;
    else start = at + 1;
  }
  let page = matched.slice(start, view.limit ? start + view.limit : undefined);
  // Measured on the real rendering (indentation included), shrinking until it fits.
  let body = renderSnapshot(page);
  while (body.length > SNAPSHOT_CHAR_BUDGET && page.length > 1) {
    page = page.slice(0, Math.max(1, Math.floor((page.length * SNAPSHOT_CHAR_BUDGET) / body.length) - 1));
    body = renderSnapshot(page);
  }
  const end = start + page.length;
  const partial = narrowed || start > 0 || end < matched.length;
  const delta = renderSnapshotDelta(opts.changed, { partial, previousPartial: !!opts.previousPartial });
  if (!page.length) {
    if (!els.length) return { text: renderSnapshot(els) + delta, partial: false };
    return { text: `(${restarted}nothing to show for ${filter || "this page"}${start ? ` after [${view.after}]` : ""} — ${matched.length} of ${els.length} elements match; widen the query or drop \`after\`)${delta}`, partial: true };
  }
  const notes: string[] = [];
  if (narrowed) notes.push(`${matched.length} of ${els.length} elements match ${filter}`);
  if (start || end < matched.length) notes.push(`showing ${start + 1}–${end} of ${matched.length}`);
  if (end < matched.length) {
    const next = `after: ${JSON.stringify(page[page.length - 1].ref)}`;
    notes.push(tool === "snapshot"
      ? `continue with snapshot({${next}${narrowed ? ", plus the same filters" : ""}})${narrowed ? "" : ", or narrow with query (text/role) / viewportOnly"}`
      : `this snapshot section is paged — call snapshot({${next}}) for the rest, or snapshot({query}) / snapshot({viewportOnly: true}) to narrow`);
  }
  const footer = notes.length ? `\n\n… ${restarted}${notes.join(" · ")}. Refs not shown here still work.` : restarted ? `\n\n… ${restarted.trim()}` : "";
  return { text: body + footer + delta, partial };
}

/** One-line summary of what an action changed, appended after action tools so
 * the agent can verify an outcome without a separate re-snapshot. Empty when
 * nothing observable changed. */
/** `tabs.goBack()` / `goForward()` / `reload()` resolve when Chrome ACCEPTS the
 *  request. At the end of history, or when a beforeunload handler cancels the
 *  move, they resolve identically — so the old fixed "Went back" was true of a
 *  navigation that never happened. Report the commit, and when there wasn't one
 *  say which read settles it rather than leaving the agent to guess. */
export function renderHistoryNav(
  kind: "back" | "forward" | "reload",
  r: { navigated: boolean; url?: string; title?: string },
): string {
  const verb = kind === "reload" ? "Reloaded" : kind === "back" ? "Went back" : "Went forward";
  if (r.navigated) return `${verb} → ${r.title ? `${r.title} — ` : ""}${r.url ?? "(url unknown)"}`;
  const why = kind === "reload"
    ? "no new document committed — the reload may have been cancelled by a beforeunload handler"
    : `nothing committed — this tab has no ${kind} history, or a beforeunload handler cancelled the move`;
  return `${verb}: ${why}. The page is unchanged; call page_state to confirm where you are before acting on it.`;
}

export function renderDelta(delta?: ActionDelta): string {
  if (!delta) return "";
  const bits: string[] = [];
  if (delta.urlChanged) bits.push(`navigated → ${delta.urlChanged}`);
  if (delta.elementDelta) bits.push(`${delta.elementDelta > 0 ? "+" : ""}${delta.elementDelta} elements`);
  if (delta.dialogsOpened) bits.push(`${delta.dialogsOpened} dialog(s) opened`);
  if (delta.scrollLocked) bits.push("page scroll locked (a modal/overlay likely opened)");
  if (delta.overlay) bits.push("a large layer now covers the page center");
  // State flips are what reveal a tab switch or a mode toggle — none of the
  // page-level axes above move for those, so without this line the tool reports
  // "nothing changed" while the whole panel swapped.
  if (delta.stateChanged?.length) bits.push(`state — ${delta.stateChanged.join("; ")}`);
  if (delta.newErrors?.length) bits.push(`NEW errors: ${delta.newErrors.join(" | ")}`);
  else if (delta.errorCount) bits.push(`${delta.errorCount} error(s) on page`);
  // Evidence about the action itself: weaker than a visible change, but it is
  // the difference between "the page reacted" and "the event went nowhere".
  if (delta.defaultPrevented) bits.push("a handler called preventDefault — the page DID react");
  if (delta.dispatchedTo) bits.push(`event landed on ${delta.dispatchedTo}`);
  if (delta.recoveredVia) bits.push(delta.recoveredVia);
  if (delta.valueMismatch)
    bits.push(
      `the field did NOT take what was requested — asked for "${delta.valueMismatch.requested}", ` +
      `it now holds "${delta.valueMismatch.actual}" (an input mask or handler dropped characters)`,
    );
  // Only a definite false is worth a line. `submitted` is absent when the submit
  // navigated and tore the runtime down — the successful case — so saying
  // "not submitted" on absence would push the agent to submit a second time.
  if (delta.submitted === false)
    bits.push("submit was requested but the form was NOT submitted (no enclosing <form>, or a handler swallowed Enter)");

  const changed = bits.length ? `\n↳ changed: ${bits.join("; ")}` : "";
  // Each call is stateless, so the agent cannot know it already did this. A
  // toggle clicked an even number of times is indistinguishable from a dead
  // control unless it is told.
  const repeat =
    delta.repeatedAfterMs !== undefined
      ? `\n⚠ you already acted on this same element ${Math.round(delta.repeatedAfterMs / 1000)}s ago — if it toggles, you may have just reverted your own change. Re-read the page before concluding the control is broken.`
      : "";
  return changed + repeat;
}

/** Render a flat TabInfo[] grouped by window, so multiple visible ("*") tabs in
 * a multi-window browser are attributable. Single window → reads like a flat list. */
export function renderTabsByWindow(tabs: TabInfo[]): string {
  if (!tabs.length) return "(no tabs)";
  const byWin = new Map<number | undefined, TabInfo[]>();
  for (const t of tabs) {
    const arr = byWin.get(t.windowId) ?? [];
    arr.push(t);
    byWin.set(t.windowId, arr);
  }
  if (byWin.size <= 1) {
    return tabs.map((t) => `${t.active ? "*" : " "} [${t.id}] ${t.title} — ${t.url}`).join("\n");
  }
  return [...byWin.entries()]
    .map(([wid, ts]) => `window ${wid ?? "?"}:\n${ts.map((t) => `    ${t.active ? "*" : " "} [${t.id}] ${t.title} — ${t.url}`).join("\n")}`)
    .join("\n");
}

/** Chrome has stopped painting this tab's window although nothing minimized or
 *  hid the tab: it is covered by other windows and Chrome was started without
 *  CHROME_RENDERING_FLAGS. Everything that needs a frame then silently stalls. */
export function renderingStalled(s: Pick<PageState, "framesStalled" | "documentHidden" | "active" | "windowState">): boolean {
  if (s.framesStalled) return true;
  return !!s.documentHidden && s.active && s.windowState != null && s.windowState !== "minimized";
}

export const RENDERING_STALLED =
  `⚠ Chrome is NOT rendering this window (it is covered by other windows): animations freeze, typed values may not land, screenshots come back stale. ` +
  `Chrome must be started with ${CHROME_RENDERING_FLAGS.join(" ")} — tell the user to quit Chrome completely and reopen it with them ` +
  `(launch_browser does this when Chrome is not running; \`pnpm doctor\` checks it). Until then, bring this window to the front before acting.`;

/** Render a PageState into a compact, scannable digest. Reuses renderDelta for
 * the `changed` line so it reads identically to click/type's "↳ changed:". */
export function renderPageState(s: PageState): string {
  const L: string[] = [`# ${s.title || "(untitled)"}`, s.url];
  const flags: string[] = [];
  if (s.loading) flags.push("LOADING");
  if (s.readyState !== "complete") flags.push(`readyState=${s.readyState}`);
  if (s.busy) flags.push(`${s.busy} busy region(s)`);
  if (s.dialogs) flags.push(`${s.dialogs} dialog(s)${s.dialogNames?.length ? ` [${s.dialogNames.join(", ")}]` : ""}`);
  if (s.scrollLocked) flags.push("scroll-locked");
  if (s.overlay) flags.push("center overlay");
  if (s.errorCount) flags.push(`${s.errorCount} error(s)`);
  // Three visibility states: active tab in the FOCUSED window (user is looking
  // at it) / active tab in a BACKGROUND window (visible but unwatched) / a
  // background tab (not visible at all). windowFocused undefined = old extension.
  const vis =
    !s.active ? " (background tab)" : s.windowFocused === false ? " (visible in a background window)" : s.windowFocused ? " (foreground — user is looking at this)" : "";
  L.push(`state: tab ${s.tabId}${vis} · ${s.interactableCount} interactable${flags.length ? " · " + flags.join(" · ") : " · clean"}`);
  if (renderingStalled(s)) L.push(RENDERING_STALLED);
  if (s.interactableCount > LARGE_PAGE) L.push(`large page: narrow snapshot with query (text/role) or viewportOnly:true instead of reading it whole`);

  const scr = s.scroll;
  const pct = scr.height > scr.viewport ? Math.round((scr.y / (scr.height - scr.viewport)) * 100) : 100;
  L.push(`scroll: ${pct}% (y=${scr.y}/${scr.height})${scr.moreAbove ? " ↑more" : ""}${scr.moreBelow ? " ↓more" : ""}`);

  if (s.focus.focused) {
    const f = s.focus;
    const sel = f.selectionStart != null ? ` caret ${f.selectionStart}${f.selectionEnd !== f.selectionStart ? `–${f.selectionEnd}` : ""}${f.valueLength != null ? `/${f.valueLength}` : ""}` : "";
    L.push(`focus: ${f.role} "${f.name}"${f.ref ? ` [${f.ref}]` : ""}${f.isTextEntry ? " (text entry)" : ""}${sel}${f.inIframe ? " (in iframe)" : ""}${f.inShadow ? " (in shadow DOM)" : ""}`);
  } else {
    L.push("focus: none");
  }

  const fm = s.forms;
  if (fm.controls) {
    L.push(`forms: ${fm.filled}/${fm.controls} filled · ${fm.emptyRequired} required-empty · ${fm.invalid} invalid · ${fm.dirty} dirty`);
    if (fm.blockers?.length) {
      for (const b of fm.blockers) L.push(`  ⚠ ${b.name}${b.ref ? ` [${b.ref}]` : ""}: ${b.reason}${b.message ? ` — ${b.message}` : ""}`);
    }
  }

  if (s.errors?.length) L.push(`errors:\n${s.errors.map((e) => `  • ${e}`).join("\n")}`);
  if (s.firstObservation) L.push("(first read of this page — no change baseline yet)");
  L.push(renderDelta(s.changed).trim() || "↳ changed: (nothing since your last page_state)");
  return L.join("\n");
}

/** One line of recording feedback per advanced step — what got captured, plus
 * anything that will make the step un-replayable. Rendered at the beat the
 * judgment is actually made: record_stop's warnings only arrive once the run is
 * over and the step can no longer be redone. "" for a non-recording plan. */
export function describeRecording(n?: RecordingNote): string {
  if (!n) return "";
  const head = n.method
    ? `⏺ recorded this step: ${n.method}`
    : n.observed === 0
      ? "⏺ recorded this step: nothing — saved check-only; auto replay will PAUSE here for you to act (fine if that was a pure check step)"
      : `⏺ recorded this step: nothing usable (${n.observed} actions seen)`;
  return `\n${head}${n.issues.map((i) => `\n  ⚠ ${i}`).join("")}`;
}

/** Human-readable rendering of a step's verify predicate, for plan/advance
 * output so the agent sees exactly what will (and won't) prove a step. */
export function describeVerify(v: StepVerify): string {
  const parts: string[] = [];
  if (v.actionSucceeded) parts.push("action returned successfully");
  if (v.urlIncludes != null) parts.push(`url contains "${v.urlIncludes}"`);
  if (v.textPresent != null) parts.push(`text "${v.textPresent}" visible`);
  if (v.textAbsent != null) parts.push(`text "${v.textAbsent}" gone`);
  if (v.elementName != null) parts.push(`element "${v.elementName}" present`);
  if (v.elementChecked != null) parts.push(`"${v.elementChecked}" checked`);
  if (v.elementEnabled != null) parts.push(`"${v.elementEnabled}" enabled`);
  if (v.elementValue != null)
    parts.push(
      `"${v.elementValue.name}" value ${v.elementValue.equals != null ? `= "${v.elementValue.equals}"` : v.elementValue.includes != null ? `contains "${v.elementValue.includes}"` : "set"}`,
    );
  if (v.networkOk != null)
    parts.push(
      `${v.networkOk.status ?? "2xx"} from "${v.networkOk.urlIncludes}"${v.networkOk.bodyIncludes != null ? ` (body ⊇ "${v.networkOk.bodyIncludes}")` : ""}`,
    );
  if (v.evalCheck != null)
    parts.push(`eval \`${v.evalCheck.code}\` ${v.evalCheck.equals != null ? `= "${v.evalCheck.equals}"` : "truthy"}`);
  if (v.noErrors) parts.push("no page errors");
  if (v.settled) parts.push("page settled");
  if (v.dialogOpen) parts.push("a dialog is open");
  if (v.formSubmittable) parts.push("form submittable");
  if (v.assert != null) parts.push(`you confirm (agent-judged): "${v.assert}"`);
  if (v.visualAssert != null) parts.push(`you confirm VISUALLY via screenshot: "${v.visualAssert}"`);
  return parts.length ? parts.join(" AND ") : "(no check declared — this step can't be proven; add a verify)";
}
