import type { BrowserEvent } from "@bcp/shared";
import type { EventStore } from "./event-store.js";

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
 * seq at or below it is settled — shown, or already evicted from the store's
 * ring buffer — and only shown seqs above it are kept in the set.
 */
export class EventInbox {
  private floor = 0;
  private readonly shown = new Set<number>();
  /** Latest store seq when the current tool call began, and the previous one. */
  private callStartSeq = 0;
  private previousCallStartSeq = 0;

  constructor(private readonly store: Pick<EventStore, "since" | "latestSeq">) {}

  /** Mark the start of a tool call (every tool of the session runs through this). */
  beginCall(): void {
    this.previousCallStartSeq = this.callStartSeq;
    this.callStartSeq = this.store.latestSeq();
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

  /** The oldest unshown event `match` accepts that arrived after the previous
   *  tool call began — the window an event caused by the agent's last action
   *  falls in. Older unshown events are history, not something to wait on. */
  recent(match: (e: BrowserEvent) => boolean): BrowserEvent | undefined {
    return this.unshown((e) => e.seq! > this.previousCallStartSeq && match(e))[0];
  }

  /** True when `e` happened before the previous tool call began. */
  isEarlier(e: BrowserEvent): boolean {
    return e.seq! <= this.previousCallStartSeq;
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
