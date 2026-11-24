/**
 * Tool-reply rendering: how a snapshot, a delta, a page state or a verify
 * outcome is spelled out for the model.
 *
 * Split out of browser-mcp.ts. These are pure string builders — they take a
 * protocol value and return text, touching neither the server nor the session
 * closure — so they are the part of that file that can be read, and tested,
 * on its own.
 */
import { CHROME_RENDERING_FLAGS, RpcMethod, bestGrade, gradeRank, matchGrade, toolNameOf, type MatchGrade, type ActionDelta, type PageState, type SnapshotElement, type StepVerify, type TabInfo } from "@bcp/shared";
import type { RecordingNote } from "./orchestrator.js";
import type { ReadDump } from "./browser-read-dump.js";
import type { ShownDiff } from "./snapshot-ledger.js";

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

/** Several actions taken as one (a multi-file upload): what any of them did is what the whole did — a later file's
 *  reply must not erase the error or navigation an earlier one caused. */
export function mergeDeltas(a: ActionDelta | undefined, b: ActionDelta | undefined): ActionDelta | undefined {
  if (!a || !b) return a ?? b;
  const list = <T>(x?: T[], y?: T[]): T[] | undefined => (x?.length || y?.length ? [...(x ?? []), ...(y ?? [])] : undefined);
  const sum = (x?: number, y?: number): number | undefined => (x || y ? (x ?? 0) + (y ?? 0) : undefined);
  return {
    ...a,
    ...b,
    elementDelta: sum(a.elementDelta, b.elementDelta),
    dialogsOpened: sum(a.dialogsOpened, b.dialogsOpened),
    scrollLocked: a.scrollLocked || b.scrollLocked || undefined,
    overlay: a.overlay || b.overlay || undefined,
    newErrors: list(a.newErrors, b.newErrors),
    stateChanged: list(a.stateChanged, b.stateChanged),
    pageDialogs: list(a.pageDialogs, b.pageDialogs),
    tabsOpened: list(a.tabsOpened, b.tabsOpened),
  };
}

/** Whether what an action was OBSERVED to do means the page the agent read is no longer the page it is on: a new
 *  document, a dialog (in the page or the page's own alert/confirm), a new tab, a selector-free interruption (scroll
 *  lock / center overlay), or new errors. The one rule every action reply and batch applies — a navigation counts
 *  like any of them, whichever action caused it. */
export function deltaGate(delta?: ActionDelta): string | null {
  if (!delta) return null;
  const why: string[] = [];
  if (delta.urlChanged) why.push("the page navigated");
  if (delta.pageDialogs?.length) why.push("the page opened its own dialog");
  if (delta.tabsOpened?.length) why.push("a new tab opened");
  if (delta.dialogsOpened || delta.scrollLocked || delta.overlay) why.push("a dialog/overlay appeared");
  if (delta.newErrors?.length) why.push("new errors showed up");
  return why.length ? why.join(", ") : null;
}

/** One line naming what this reply lists that the caller has not been shown before (see ShownLedger).
 *  A snapshot without it is an undifferentiated full page every time: the caller
 *  has to re-scan everything it already read to find the one control that is
 *  new, and pays that scan on every beat. Refs survive re-snapshots, so
 *  "e37 is new" is a durable statement rather than a renumbering artefact. */
export function renderShownDelta(d?: ShownDiff, opts: { continuation?: boolean } = {}): string {
  if (!d || d.fresh === "first") return "";
  if (d.fresh === "navigated") return "\n\n↳ New document since your last snapshot (navigation or reload) — refs from earlier replies no longer apply.";
  // Facts only — how many of the elements you were shown are gone, which are new or changed. Whether that adds up
  // to "a different view" is the reader's call: it can see both counts.
  const list = (refs: string[]): string => (refs.length <= 12 ? refs.join(", ") : `${refs.length} (first 12: ${refs.slice(0, 12).join(", ")})`);
  const bits: string[] = [];
  // A continuation page lists what earlier pages did not, so "new to you" would just repeat this page's refs.
  if (d.appeared.length && !opts.continuation) bits.push(`NEW to you: ${list(d.appeared)}`);
  if (d.changed.length) bits.push(`CHANGED: ${list(d.changed)}`);
  if (d.gone) bits.push(`${d.gone} of the ${d.known} elements you were shown are gone`);
  if (d.hiddenAgain) bits.push(`${d.hiddenAgain} hidden again`);
  if (d.framesNavigated.length) bits.push(`${d.framesNavigated.length} frame(s) loaded a new document — their earlier refs no longer apply`);
  if (!bits.length) return "";
  return opts.continuation
    ? `\n\n↳ Since your last snapshot: ${bits.join(" · ")}.`
    : `\n\n↳ Since your last snapshot: ${bits.join(" · ")} — start with those; everything else listed here was in an earlier reply.`;
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
  const out: string[] = [];
  const walk = (e: SnapshotElement, depth: number): void => {
    out.push(`${"  ".repeat(depth)}${elementLine(e)}`);
    for (const c of childrenOf.get(e.ref) ?? []) walk(c, depth + 1);
  };
  for (const e of roots) walk(e, 0);
  return out.join("\n");
}

/** The line a reply prints for one element. `geometry: false` drops what only says WHERE it is (its box,
 *  [offscreen]) — what ShownLedger compares, so an element that merely scrolled has not changed, and anything the
 *  line says about it has. */
export function elementLine(e: SnapshotElement, opts: { geometry?: boolean } = {}): string {
  const geometry = opts.geometry ?? true;
  const parts = [`[${e.ref}]`, e.role];
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
  if (geometry && e.inViewport === false) parts.push("[offscreen]");
  if (e.scrollable) parts.push("(scrollable)");
  // Zone last: it reads as a trailing address, so a column of them stays
  // scannable when the agent is looking for "what's in the dialog".
  if (e.zone) parts.push(`@${e.zone}`);
  // Geometry after the zone — this is what ties a thing seen in a screenshot
  // to a ref that can be acted on, and vice versa.
  if (geometry && e.rect) parts.push(`(${e.rect[0]},${e.rect[1]} ${e.rect[2]}×${e.rect[3]})`);
  return parts.join(" ");
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
 *  skip or repeat elements whenever the page added or removed some in between.
 *  `within` lists one element and everything under it or opened by it (`controls`), hidden ones included — it is
 *  how a group from the "Hidden right now" summary is expanded. `full` lists every element, hidden ones included. */
export interface SnapshotView { query?: string; viewportOnly?: boolean; limit?: number; after?: string; within?: string; full?: boolean }

/** One reply of a 2,581-element page came to 116,063 characters and the MCP client refused it outright, so the
 *  agent lost the result and every [ref] in it. Past this size the reply pages instead. */
export const SNAPSHOT_CHAR_BUDGET = 30_000;
/** page_state's count is a lower bound of snapshot's (top frame, no cursor:pointer); past this it suggests narrowing. */
const LARGE_PAGE = 500;

/** A default reply lists what can be acted on now — every visible element — and names the rest instead of
 *  listing it: a hidden element cannot be acted on until it shows, and a hidden group (a closed menu, a collapsed
 *  section) is the container it waits in. What a reply leaves out is decided by visibility alone, never by tag,
 *  role or name, and everything it leaves out is still named by [ref] in the summary — or, once the summary's own
 *  budget runs out, counted with the call that lists it. */
export const listedByDefault = (e: SnapshotElement): boolean => !e.hidden && !e.hiddenGroup;
/** Hidden groups are a device for naming hidden elements, not elements of the page: counts leave them out. */
const countElements = (els: SnapshotElement[]): number => els.reduce((n, e) => n + (e.hiddenGroup ? 0 : 1), 0);
/** Part of a reply the hidden summary may take; past it the summary counts what it no longer names. */
const SUMMARY_CHAR_BUDGET = 3_000;
/** Room kept for the coverage line, which is written once the page is cut. */
const COVERAGE_RESERVE = 600;

/** `root` and everything nested under it or opened by it, in document order; undefined when `root` is gone. */
function subtreeOf(els: SnapshotElement[], root: string): SnapshotElement[] | undefined {
  const byRef = new Map(els.map((e) => [e.ref, e] as const));
  if (!byRef.has(root)) return undefined;
  const kids = new Map<string, string[]>();
  for (const e of els) if (e.parentRef) (kids.get(e.parentRef) ?? kids.set(e.parentRef, []).get(e.parentRef)!).push(e.ref);
  const keep = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const ref = stack.pop()!;
    const e = byRef.get(ref);
    if (!e || keep.has(ref)) continue;
    keep.add(ref);
    stack.push(...(kids.get(ref) ?? []), ...(e.controls ?? []));
  }
  return els.filter((e) => keep.has(e.ref));
}

/** What a default reply left out, one line per hidden subtree: a closed menu is one line with the [ref] that
 *  `within` expands (github's language picker: 848 hidden options), a lone hidden element is its own line. Groups
 *  come first, largest first, so a cut summary still names the most; lone elements follow in document order.
 *  Returns how many hidden elements it named by ref and how many it only counted — the Coverage line says both. */
function renderHiddenSummary(folded: SnapshotElement[], all: SnapshotElement[]): { text: string; named: number; total: number } {
  const byRef = new Map(all.map((e) => [e.ref, e] as const));
  const foldedRefs = new Set(folded.map((e) => e.ref));
  const rootOf = (e: SnapshotElement): SnapshotElement => {
    let r = e;
    while (r.parentRef && foldedRefs.has(r.parentRef)) r = byRef.get(r.parentRef)!;
    return r;
  };
  const held = new Map<string, number>(); // root ref → hidden elements under it, the root included unless only a group
  for (const e of folded) {
    const r = rootOf(e).ref;
    held.set(r, (held.get(r) ?? 0) + (e.hiddenGroup ? 0 : 1));
  }
  const isGroup = ([ref, n]: [string, number]): boolean => n > 1 || !!byRef.get(ref)!.hiddenGroup;
  const entries = [...[...held].filter(isGroup).sort((a, b) => b[1] - a[1]), ...[...held].filter((g) => !isGroup(g))];
  const lines: string[] = [];
  let used = 0;
  let named = 0;
  for (const [ref, n] of entries) {
    const line = `  ${elementLine(byRef.get(ref)!, { geometry: false })}${isGroup([ref, n]) ? ` — holds ${n} hidden` : ""}`;
    if (used + line.length > SUMMARY_CHAR_BUDGET) break;
    lines.push(line);
    used += line.length + 1;
    named += n;
  }
  const total = countElements(folded);
  if (named < total)
    lines.push(`  … ${total - named} more hidden, counted but not named here — query searches them, snapshot({full: true}) lists them`);
  return {
    text: `\n\nHidden right now (${total}, not listed above; listed once visible) — snapshot({within: ref}) lists a group, query searches them all, snapshot({full: true}) lists everything:\n${lines.join("\n")}`,
    named,
    total,
  };
}

const WHOLE_PAGE = "snapshot({full: true}) lists every element, page by page";

/** Renders a snapshot reply (snapshot, or analyze_page's snapshot section), and returns the refs it listed — what
 *  the caller records as shown — and whether it continued an earlier page (`continued`: it started past the first
 *  element, so everything on it is unread by construction).
 *
 *  Every reply opens with one Coverage line in a fixed shape: how many of the page's elements this reply lists and
 *  which ones, how many are hidden and how many of those it names by ref, and the exact call that returns the rest —
 *  so a reader can always tell whether it holds the whole page and how to get it, without inferring it from the list.
 *  Counts are of the page's elements; a hidden group is a device for naming them, not one of them. */
export function renderSnapshotView(
  els: SnapshotElement[],
  view: SnapshotView = {},
): { text: string; shown: string[]; continued: boolean } {
  const total = countElements(els);
  const coverage = (bits: string[]): string => `Coverage: ${bits.join(" · ")}.`;
  if (!els.length) return { text: `${coverage(["the page has no interactable elements"])}\n\n${renderSnapshot(els)}`, shown: [], continued: false };
  const query = view.query?.trim().toLowerCase();
  let matched = els;
  if (view.within) {
    const sub = subtreeOf(els, view.within);
    if (!sub)
      return {
        text: coverage([`0 of the page's ${total} elements listed here ([${view.within}] is no longer on the page — take a fresh snapshot to find what replaced it)`, WHOLE_PAGE]),
        shown: [],
        continued: false,
      };
    matched = sub;
  }
  // A (group) wrapper and a hidden group are named by all the text they hold, so their "name" matches whatever one
  // of their elements matches: the search would return the element and every container around it, and a group that
  // is not one of the page's elements. A query asks for elements by their own name, role, value or options.
  if (query) {
    // Graded the way every other text comparison is (text-match.ts): case and whitespace folded, the words of a
    // several-word query found in any order. Ordered best grade first — an element named exactly what was asked
    // before the hundreds that merely contain it — and in document order within a grade. Nothing is dropped.
    const graded = matched
      .map((e) => ({ e, g: e.container || e.hiddenGroup ? undefined : [e.role, e.name, e.value, ...(e.options ?? [])].reduce<MatchGrade | undefined>((best, v) => bestGrade(best, matchGrade(v, query)), undefined) }))
      .filter((x): x is { e: SnapshotElement; g: MatchGrade } => !!x.g);
    matched = graded.map((x, i) => ({ ...x, i })).sort((a, b) => gradeRank(a.g) - gradeRank(b.g) || a.i - b.i).map((x) => x.e);
  }
  if (view.viewportOnly) matched = matched.filter((e) => e.inViewport === true);
  const narrowed = !!query || !!view.viewportOnly || !!view.within;
  const filter = [view.within ? `within [${view.within}]` : "", query ? `query=${JSON.stringify(view.query)}` : "", view.viewportOnly ? "viewportOnly" : ""].filter(Boolean).join(" ");
  // Searching or opening a group is asking for hidden elements too; only the default view summarises them.
  const folded = view.full || query || view.within ? [] : matched.filter((e) => !listedByDefault(e));
  if (folded.length) matched = matched.filter(listedByDefault);
  let start = 0;
  let restarted = "";
  if (view.after) {
    const at = matched.findIndex((e) => e.ref === view.after);
    if (at < 0) {
      const why = !els.some((e) => e.ref === view.after) ? "is no longer on the page" : folded.some((e) => e.ref === view.after) ? "is hidden now" : "no longer matches";
      restarted = `[${view.after}] ${why}, so this starts again from the first element`;
    } else start = at + 1;
  }
  const hiddenSummary = folded.length ? renderHiddenSummary(folded, els) : undefined;
  // The summary belongs to the first page — including a restarted one; later pages continue the list.
  const summary = hiddenSummary && start === 0 ? hiddenSummary.text : "";
  const budget = SNAPSHOT_CHAR_BUDGET - summary.length - COVERAGE_RESERVE;
  let page = matched.slice(start, view.limit ? start + view.limit : undefined);
  // Measured on the real rendering (indentation included), shrinking until it fits.
  let body = renderSnapshot(page);
  while (body.length > budget && page.length > 1) {
    page = page.slice(0, Math.max(1, Math.floor((page.length * budget) / body.length) - 1));
    body = renderSnapshot(page);
  }
  const end = start + page.length;
  if (!page.length)
    body = narrowed || start
      ? `(nothing to show${filter ? ` for ${filter}` : ""}${start ? ` after [${view.after}]` : ""} — widen the query or drop \`after\`)`
      : "(no visible interactable elements right now)";

  // ---- Coverage ----
  const listed = countElements(page);
  const inScope = countElements(matched);
  const scope = narrowed ? `elements matching ${filter}` : view.full ? "elements, hidden ones included" : "visible elements";
  const paged = start > 0 || end < matched.length;
  const range = !listed
    ? `none of ${inScope} ${scope}`
    : paged
      ? `${countElements(matched.slice(0, start)) + 1}–${countElements(matched.slice(0, end))} of ${inScope} ${scope}`
      : `all ${inScope} ${scope}`;
  const bits = [`${listed} of the page's ${total} elements listed here (${range})`];
  if (restarted) bits.push(restarted);
  if (end < matched.length) {
    // The exact call: `full` and every filter are part of what is being paged — page 2 without them is another view.
    const args: Record<string, unknown> = { after: page[page.length - 1].ref, full: view.full || undefined, query: view.query, viewportOnly: view.viewportOnly || undefined, within: view.within, limit: view.limit };
    bits.push(`next page: snapshot({${Object.entries(args).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")}})`);
  }
  if (hiddenSummary) {
    const where = summary ? `under "Hidden right now" below` : "on the first page";
    const counted = hiddenSummary.total - hiddenSummary.named;
    bits.push(counted ? `${hiddenSummary.total} hidden: ${hiddenSummary.named} named by ref ${where}, ${counted} only counted there` : `${hiddenSummary.total} hidden, all named by ref ${where}`);
  }
  if (listed === total) bits.push("that is the whole page");
  else if (narrowed) bits.push("snapshot({full: true}) with no filter lists every element, page by page");
  else if (!view.full) bits.push(WHOLE_PAGE);
  return { text: `${coverage(bits)}\n\n${body}${summary}`, shown: page.map((e) => e.ref), continued: start > 0 };
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
  if (r.navigated) return `${verb} → ${r.title ? `${r.title} — ` : ""}${r.url ?? "(url unknown)"}${gateNote("the page navigated")}`;
  const why = kind === "reload"
    ? "no new document committed — the reload may have been cancelled by a beforeunload handler"
    : `nothing committed — this tab has no ${kind} history, or a beforeunload handler cancelled the move`;
  return `${verb}: ${why}. The page is unchanged; call page_state to confirm where you are before acting on it.`;
}

export function renderDelta(delta?: ActionDelta): string {
  if (!delta) return "";
  const bits: string[] = [];
  if (delta.urlChanged) bits.push(`navigated → ${delta.urlChanged}`);
  // The page's own alert/confirm/prompt: nobody can see it while an agent drives, so it was answered on the spot —
  // and the answer can be what decided the outcome.
  for (const d of delta.pageDialogs ?? [])
    bits.push(`page ${d.kind}(${JSON.stringify(d.message)})${d.answered ? ` answered ${d.answered}${d.kind !== "alert" && d.answered === "Cancel" ? " — what it guarded did not proceed" : ""}` : ""}`);
  for (const t of delta.tabsOpened ?? []) bits.push(`opened tab ${t.tabId}${t.url ? ` (${t.url})` : ""}`);
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
  if (v.evalUntil != null)
    parts.push(`eval-until (acts each try) \`${v.evalUntil.code}\` ${v.evalUntil.equals != null ? `= "${v.evalUntil.equals}"` : "truthy"}`);
  if (v.noErrors) parts.push("no page errors");
  if (v.settled) parts.push("page settled");
  if (v.dialogOpen) parts.push("a dialog is open");
  if (v.formSubmittable) parts.push("form submittable");
  if (v.assert != null) parts.push(`you confirm (agent-judged): "${v.assert}"`);
  if (v.visualAssert != null) parts.push(`you confirm VISUALLY via screenshot: "${v.visualAssert}"`);
  return parts.length ? parts.join(" AND ") : "(no check declared — this step can't be proven; add a verify)";
}
