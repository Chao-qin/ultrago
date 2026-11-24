/**
 * pick_option: open a custom dropdown and choose an option, as ONE action.
 *
 * Shared by the pick_option tool and both playback channels (MCP run_playbook
 * and the console's internal runner), so a recorded `local.pickOption` step
 * replays through exactly the code that recorded it.
 *
 * The option is searched among the elements the opening click REVEALED — new
 * refs, plus refs that were hidden before and are visible now (component
 * libraries keep a closed list mounted). Searching the whole page instead is
 * how a breadcrumb or another row carrying the same text got picked.
 */
import { RpcMethod, matchGrade, type ActionDelta, type PickOptionParams, type SnapshotElement } from "@bcp/shared";
import { listedByDefault } from "./browser-mcp-render.js";
import { frameOf, ShownLedger } from "./snapshot-ledger.js";

/** The RPCs pick_option needs, typed loosely so both channels can pass their own call. */
export type PickOptionCall = (method: RpcMethod, params: Record<string, unknown>) => Promise<unknown>;

export interface PickOptionResult {
  ok: true;
  /** Visible name of the chosen option and its ref. */
  picked: string;
  ref: string;
  /** Where it sits: its visual zone and up to three ancestors. */
  where: string;
  /** False when the opening click revealed nothing, so the option was matched on the whole page. */
  fromRevealedList: boolean;
  openDelta?: ActionDelta;
  delta?: ActionDelta;
}

/** How long to let the list render after the opening click. */
const LIST_RENDER_MS = 500;


export async function pickOption(call: PickOptionCall, params: PickOptionParams): Promise<PickOptionResult> {
  const { option, tabId, ...trigger } = params;
  if (!option?.trim()) throw new Error("pick_option needs the `option` text to choose");
  type Snap = { url?: string; tabId?: number; elements: SnapshotElement[]; docs?: Record<string, string> };
  const before = (await call(RpcMethod.Snapshot, { tabId })) as Snap;
  // One tab for the whole pick: the one read first. Without a tabId every call resolved "the active tab" on its own.
  const tab = tabId ?? before.tabId;
  const open = (await call(RpcMethod.Click, { ...trigger, tabId: tab })) as { delta?: ActionDelta };
  await call(RpcMethod.WaitFor, { ms: LIST_RENDER_MS, tabId: tab });
  const after = (await call(RpcMethod.Snapshot, { tabId: tab })) as Snap;

  // The list the trigger opened = what is visible now and was not visible before: newly mounted, or rendered up
  // front and merely hidden. Same question the agent's snapshot answers, so the same ledger answers it — and the
  // same predicate decides what counts as visible (a hidden group's container is not an option).
  const seen = new ShownLedger(1);
  const visible = (s: Snap): string[] => s.elements.filter(listedByDefault).map((e) => e.ref);
  // An extension without document ids cannot report a navigation; within one pick, milliseconds apart, assume the
  // same document — what pick_option always assumed before ids existed.
  const docsOf = (s: Snap): Record<string, string> => s.docs ?? { "0": "unknown" };
  seen.read("pick", docsOf(before), before.elements, visible(before)).commit();
  const { diff } = seen.read("pick", docsOf(after), after.elements, visible(after));
  // A new document is not a list the trigger opened: whatever is on it was not chosen from that list, and clicking
  // it would act on a page nobody asked about. Say so instead of picking.
  if (diff.fresh === "navigated")
    throw new Error(`the opening click navigated to a new document${after.url ? ` (${after.url})` : ""}, so it is not what opens this list — nothing was picked. Snapshot the page and pick_option with the control that opens the list.`);
  // A sub-frame that loaded a new document in the meantime (an ad, a widget) is not the list either.
  const reloaded = new Set(diff.framesNavigated);
  const revealed = new Set(diff.appeared.filter((ref) => !reloaded.has(frameOf(ref))));
  const named = after.elements.filter((e) => e.name && listedByDefault(e));
  const fromRevealedList = named.some((e) => revealed.has(e.ref));
  const pool = fromRevealedList ? named.filter((e) => revealed.has(e.ref)) : named;
  // Compared the way query and the verifiers compare names (text-match.ts).
  const exact = pool.filter((e) => matchGrade(e.name, option) === "exact");
  // The option's text as one piece; scattered words ("I agree" in "I don't agree") would pick the wrong option.
  const cands = exact.length ? exact : pool.filter((e) => matchGrade(e.name, option) === "substring");

  if (!cands.length) {
    const shown = pool.slice(0, 30).map((e) => e.name).join(" | ");
    throw new Error(
      `option ${JSON.stringify(option)} not found ${fromRevealedList ? "in the list the trigger opened" : "on the page (the trigger revealed no new elements — the list may not have opened)"}. ` +
        `Visible: ${shown || "(nothing named)"}`,
    );
  }
  if (cands.length > 1) {
    const list = cands.slice(0, 10).map((e) => `  "${e.name}" [${e.ref}]${e.zone ? ` @${e.zone}` : ""}`).join("\n");
    throw new Error(
      `${cands.length} options match ${JSON.stringify(option)}${fromRevealedList ? " in the opened list" : " on the page"} — pass the option's exact full text, ` +
        `or (the list is open now) click the entry you mean by its [ref]:\n${list}`,
    );
  }
  const match = cands[0]!;

  const byRef = new Map(after.elements.map((e) => [e.ref, e] as const));
  const chain: string[] = [];
  for (let p = match.parentRef; p && chain.length < 3; ) {
    const pe = byRef.get(p);
    if (!pe) break;
    chain.push(`${pe.role}${pe.name ? ` "${pe.name.slice(0, 24)}"` : ""}`);
    p = pe.parentRef;
  }
  const where = [match.zone ? `@${match.zone}` : "", chain.length ? `under ${chain.join(" ← ")}` : "at the page root"]
    .filter(Boolean)
    .join(" ");

  // Clicked where it was read — this pick's own snapshot's tab and document, not the agent's last read.
  const frame = /^(\d+)_/.exec(match.ref)?.[1] ?? "0";
  const r = (await call(RpcMethod.Click, { ref: match.ref, tabId: tab, ...(after.docs?.[frame] ? { expectDoc: after.docs[frame] } : {}) })) as { delta?: ActionDelta };
  return { ok: true, picked: match.name, ref: match.ref, where, fromRevealedList, openDelta: open.delta, delta: r.delta };
}
