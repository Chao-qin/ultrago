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
import { RpcMethod, type ActionDelta, type PickOptionParams, type SnapshotElement } from "@bcp/shared";

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

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Snapshot baseline key private to pick_option, so it never moves the agent's own "NEW since" baseline. */
export function pickOptionDeltaKey(sessionKey: string): string {
  return `${sessionKey}.pick`;
}

export async function pickOption(call: PickOptionCall, params: PickOptionParams, deltaKey: string): Promise<PickOptionResult> {
  const { option, tabId, ...trigger } = params;
  if (!option?.trim()) throw new Error("pick_option needs the `option` text to choose");
  type Snap = { elements: SnapshotElement[]; changed?: { added: string[] } };
  const before = (await call(RpcMethod.Snapshot, { tabId, deltaKey, resetDelta: true })) as Snap;
  const open = (await call(RpcMethod.Click, { ...trigger, tabId })) as { delta?: ActionDelta };
  await call(RpcMethod.WaitFor, { ms: LIST_RENDER_MS, tabId });
  const after = (await call(RpcMethod.Snapshot, { tabId, deltaKey })) as Snap;

  const hiddenBefore = new Set(before.elements.filter((e) => e.hidden).map((e) => e.ref));
  const revealed = new Set([
    ...(after.changed?.added ?? []),
    ...after.elements.filter((e) => !e.hidden && hiddenBefore.has(e.ref)).map((e) => e.ref),
  ]);
  const named = after.elements.filter((e) => e.name && !e.hidden);
  const fromRevealedList = named.some((e) => revealed.has(e.ref));
  const pool = fromRevealedList ? named.filter((e) => revealed.has(e.ref)) : named;
  const want = norm(option);
  const exact = pool.filter((e) => norm(e.name) === want);
  const cands = exact.length ? exact : pool.filter((e) => norm(e.name).includes(want));

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

  const r = (await call(RpcMethod.Click, { ref: match.ref, tabId })) as { delta?: ActionDelta };
  return { ok: true, picked: match.name, ref: match.ref, where, fromRevealedList, openDelta: open.delta, delta: r.delta };
}
