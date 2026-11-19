import type { BrowserEvent } from "@bcp/shared";
import type { EventStore } from "./event-store.js";

/** What one tool call may treat as "recent": events after the previous call began. */
export interface CallWindow {
  previousStartSeq: number;
}

/**
 * Which buffered browser events one MCP session has been shown.
 *
 * Replies only show the events of the tab they acted on, and wait_for_event
 * looks for events that already arrived. Both need "has the agent seen this
 * event?" per event. A single seq cursor cannot answer that: advancing it past
 * the events a reply filtered out silently drops them (a popup tab opened by
 * the click the reply was about, then never found by wait_for_event), and not
 * advancing it re-shows everything.
 *
 * So the inbox records shown events by seq. `floor` keeps it bounded: every
 * seq at or below it is settled — shown, from before the session began, or
 * already evicted from the store's ring buffer — and only shown seqs above it
 * are kept in the set.
 *
 * A session starts at the present: events from before it existed are not
 * "unseen events of this session".
 */
export class EventInbox {
  private floor: number;
  private readonly shown = new Set<number>();
  /** Latest store seq when the most recently started tool call began. */
  private lastStartSeq: number;

  constructor(private readonly store: Pick<EventStore, "since" | "latestSeq">) {
    this.floor = store.latestSeq();
    this.lastStartSeq = this.floor;
  }

  /** Open a tool call. Calls may overlap, so each gets its own window: what
   *  arrived after the call that started before it. */
  beginCall(): CallWindow {
    const window = { previousStartSeq: this.lastStartSeq };
    this.lastStartSeq = this.store.latestSeq();
    return window;
  }

  /** Buffered events not yet shown that `match` accepts, oldest first. */
  unshown(match: (e: BrowserEvent) => boolean): BrowserEvent[] {
    return this.store.since(this.floor).events.filter((e) => !this.shown.has(e.seq!) && match(e));
  }

  /** The unshown events `match` accepts, now marked shown — what a reply carries. */
  take(match: (e: BrowserEvent) => boolean): BrowserEvent[] {
    const events = this.unshown(match);
    this.markShown(events);
    return events;
  }

  /** The oldest unshown event `match` accepts within `window` — where an event
   *  caused by the agent's last action falls. Older unshown events are
   *  history, not something to wait on. */
  recent(match: (e: BrowserEvent) => boolean, window: CallWindow): BrowserEvent | undefined {
    return this.unshown((e) => e.seq! > window.previousStartSeq && match(e))[0];
  }

  /** True when `e` happened before `window` opened. */
  isEarlier(e: BrowserEvent, window: CallWindow): boolean {
    return e.seq! <= window.previousStartSeq;
  }

  markShown(events: BrowserEvent[]): void {
    for (const e of events) if (e.seq! > this.floor) this.shown.add(e.seq!);
    const buffered = this.store.since(this.floor).events;
    // Evicted seqs can never be shown again: start the floor below the oldest one still buffered.
    const oldest = buffered.length ? buffered[0]!.seq! : this.store.latestSeq() + 1;
    if (this.floor < oldest - 1) this.floor = oldest - 1;
    while (this.shown.has(this.floor + 1)) this.floor++;
    for (const seq of this.shown) if (seq <= this.floor) this.shown.delete(seq);
  }
}
