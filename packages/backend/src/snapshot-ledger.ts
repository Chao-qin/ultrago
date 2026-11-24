/**
 * What each observer has been SHOWN of a page, so a snapshot reply can say what is new to it.
 *
 * "New since your last snapshot" used to mean "not in the DOM at the observer's previous read", tracked inside
 * the page. That is a different question, and every way a reply leaves elements out made the two disagree: a
 * menu rendered up front and merely hidden by CSS was not "new" when it opened, although the agent had never
 * seen it; elements cut by paging or a query counted as read. Only the code that decides what a reply shows can
 * keep this record, so it lives here, beside the renderer, and records exactly the refs a reply listed — and only
 * once the reply is actually delivered (`commit`), so a tool that fails after rendering never counts as seen.
 *
 * Refs are numbered per document, so every comparison starts by comparing documents (`docs`, one id per frame).
 * Anything this cannot compare safely degrades to "nothing is new / nothing was seen", never to a false
 * "you already read this".
 */
import type { SnapshotElement } from "@bcp/shared";
import { elementLine } from "./browser-mcp-render.js";

export interface ShownDiff {
  /** Nothing earlier to compare with: the first read of this tab, or the top document changed. */
  fresh?: "first" | "navigated";
  /** Listed now, never listed to this observer in this document — newly added, or just became visible. */
  appeared: string[];
  /** Listed before and now, but what its line says (state, value, name, hidden …) changed. */
  changed: string[];
  /** Listed before, no longer on the page. */
  gone: number;
  /** Listed while visible before, hidden now. */
  hiddenAgain: number;
  /** Sub-frames (frameIds, as in `docs`) whose document changed; their earlier refs are gone. */
  framesNavigated: string[];
  /** How many refs this observer had been shown before this read. */
  known: number;
}

/** A read compared with the record, not yet recorded: `commit` once the reply carrying it is delivered. */
export interface ShownRead { diff: ShownDiff; commit(): void }

/** What the reply's line says about an element, minus where it is: CHANGED means the line the reader has would now
 *  read differently — no more (a name changed past what the line shows), no less (a field the line shows). An
 *  element that merely scrolled has not changed. */
const signature = (e: SnapshotElement): string => elementLine(e, { geometry: false });

/** Frame a ref belongs to, in the same keys as `docs`: sub-frame refs carry their frameId as a prefix. */
export const frameOf = (ref: string): string => /^(\d+)_/.exec(ref)?.[1] ?? "0";

/** Per listed ref: its line, and whether it was hidden when listed (query/within/full list hidden elements). */
interface Seen { docs: Record<string, string>; shown: Map<string, { sig: string; hidden: boolean }> }

export class ShownLedger {
  private readonly tabs = new Map<string, Seen>();

  /** Tabs remembered per observer; the least recently read is forgotten first, and forgetting only means its
   *  next read counts as a first read. */
  constructor(private readonly maxTabs = 32) {}

  /**
   * Compare a reply that lists `shown` (refs of `elements`) with what this observer was listed before. Nothing is
   * recorded until `commit()`. `reset` ignores the history (a reply that lists everything). Without `docs` (an
   * extension older than document ids) refs cannot be compared across reads at all: the diff is empty and
   * `commit` forgets this tab rather than recording anything.
   */
  read(key: string, docs: Record<string, string> | undefined, elements: SnapshotElement[], shown: Iterable<string>, opts: { reset?: boolean } = {}): ShownRead {
    const prev = this.tabs.get(key);
    const diff: ShownDiff = { appeared: [], changed: [], gone: 0, hiddenAgain: 0, framesNavigated: [], known: prev?.shown.size ?? 0 };
    if (!docs) return { diff: { ...diff, fresh: "first", known: 0 }, commit: () => void this.tabs.delete(key) };

    const byRef = new Map(elements.map((e) => [e.ref, e] as const));
    // A hidden group is a device for naming hidden elements, not one of the page's elements: recording it would
    // count its disappearance (the menu opened) as an element gone, against the Coverage line's own count.
    const shownNow = [...shown].filter((ref) => byRef.has(ref) && !byRef.get(ref)!.hiddenGroup);
    const listedNow = new Set(shownNow);
    const next: Seen = { docs, shown: new Map() };
    if (!prev || opts.reset) diff.fresh = "first";
    else if (prev.docs["0"] !== docs["0"]) diff.fresh = "navigated";
    else {
      // A frame that is gone entirely is not "navigated": its refs fall through and count as gone.
      const navigated = new Set(Object.keys(prev.docs).filter((f) => f in docs && prev.docs[f] !== docs[f]));
      diff.framesNavigated = [...navigated];
      for (const [ref, seen] of prev.shown) {
        if (navigated.has(frameOf(ref))) continue;
        const e = byRef.get(ref);
        if (!e) diff.gone++;
        // Listed while visible, hidden now: forgotten, so that showing it again later counts as new — the agent has
        // no reason to look for it there. One that was already hidden when listed (by a query) has not changed.
        else if (e.hidden && !seen.hidden && !listedNow.has(ref)) diff.hiddenAgain++;
        else next.shown.set(ref, seen);
      }
    }

    for (const ref of shownNow) {
      const e = byRef.get(ref)!;
      const sig = signature(e);
      const before = next.shown.get(ref);
      if (!diff.fresh) {
        if (before === undefined) diff.appeared.push(ref);
        else if (before.sig !== sig) diff.changed.push(ref);
      }
      next.shown.set(ref, { sig, hidden: !!e.hidden });
    }

    return {
      diff,
      commit: () => {
        this.tabs.delete(key);
        this.tabs.set(key, next);
        while (this.tabs.size > this.maxTabs) this.tabs.delete(this.tabs.keys().next().value!);
      },
    };
  }
}
