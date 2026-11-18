import type { BrowserEvent, ResolvedDelivery } from "@bcp/shared";
import type { RunOutcome } from "./playback.js";

/**
 * Process-global ring buffer of page-originated browser events pushed by the
 * extension over WS. Lives in the Node backend, NOT the service worker, so it
 * SURVIVES service-worker recycles (unlike the SW's in-memory network buffer).
 *
 * Each event gets a monotonic seq on ingest. Clients drain incrementally by
 * "everything after the seq I last saw" — that cursor is what lets each MCP
 * session piggyback only the events new since its previous tool call.
 */
const CAP = 500;

/** A run reached a terminal outcome (success/escalated/failed/cancelled). This
 * is the "execution finished" hook surface — subscribers (the delivery
 * executor, a future book-chain trigger, an agent via wait_for_event) consume
 * it. Distinct from BrowserEvent: not page-originated, not seq-cursor based. */
export interface RunFinishedEvent {
  kind: "run_finished";
  ts: number;
  planId: string;
  runId?: string;
  bookName: string;
  trigger: "manual" | "schedule" | "mcp";
  status: RunOutcome;
  ranSteps: number;
  totalSteps: number;
  durationMs: number;
  error?: string;
  /** The book's produced data — the last local.eval step's value (undefined if
   * none). Consumed by print/webhook/message deliveries. */
  outputs?: unknown;
  deliveries: ResolvedDelivery[];
  artifacts?: Array<{ path: string; kind?: string; size?: number; mimeType?: string | null }>;
}

type RunFinishedListener = (e: RunFinishedEvent) => void | Promise<void>;

/** Called for EVERY ingested browser event. Must not throw the caller's ingest
 * path — push() isolates it, but a listener that blocks would still stall the
 * WS message loop, so real work belongs behind a fire-and-forget. */
type BrowserEventListener = (e: BrowserEvent) => void;

export class EventStore {
  private buf: BrowserEvent[] = [];
  private seq = 0;
  /** Blocked wait_for_event callers, woken when a matching event is pushed. */
  private waiters: Array<{ pred: (e: BrowserEvent) => boolean; settle: (e: BrowserEvent) => void }> = [];
  /** run_finished subscribers — plain pub/sub, independent of the seq buffer. */
  private runListeners = new Set<RunFinishedListener>();
  /** Every-event subscribers. Distinct from `waiters`, which serve ONE caller
   * once and then unregister: a subscriber wants the whole stream, and it is
   * PUSHED to rather than polling the seq buffer — which is what lets a
   * consumer outside any MCP session (the event webhook) learn about a
   * challenge without an agent being connected at all. */
  private eventListeners = new Set<BrowserEventListener>();

  /** Ingest a pushed event, stamping a monotonic seq. */
  push(event: BrowserEvent): void {
    event.seq = ++this.seq;
    this.buf.push(event);
    if (this.buf.length > CAP) this.buf.shift();
    // Wake any wait_for_event caller whose predicate this event satisfies.
    if (this.waiters.length) {
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(event)) return true;
        w.settle(event);
        return false;
      });
    }
    // Fan out to stream subscribers LAST: they are observers, and a throwing
    // one must not cost the buffer or a woken waiter —
    // all of which are already done by this point.
    for (const l of [...this.eventListeners]) {
      try {
        l(event);
      } catch (err) {
        console.error("[events] listener threw:", err);
      }
    }
  }

  /** Subscribe to every ingested event. Returns an unsubscribe function. */
  onEvent(listener: BrowserEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /** Events with seq > afterSeq (optionally filtered to one tab), plus the
   * current max seq so the caller can advance its cursor even when the slice
   * is empty. */
  since(afterSeq: number, tabId?: number): { events: BrowserEvent[]; maxSeq: number } {
    const events = this.buf.filter(
      (e) => (e.seq ?? 0) > afterSeq && (tabId == null || e.tabId === tabId),
    );
    return { events, maxSeq: this.seq };
  }

  /** Block until an event satisfies `pred`, or resolve null after timeoutMs.
   * The long-poll primitive behind wait_for_event: the tool call stays open
   * (no busy-poll) and returns the instant a matching page event arrives. */
  waitFor(pred: (e: BrowserEvent) => boolean, timeoutMs: number): Promise<BrowserEvent | null> {
    return new Promise((resolve) => {
      const settle = (e: BrowserEvent): void => {
        clearTimeout(timer);
        resolve(e);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.settle !== settle);
        resolve(null);
      }, timeoutMs);
      this.waiters.push({ pred, settle });
    });
  }

  /** Subscribe to run_finished events. Returns an unsubscribe function. */
  onRunFinished(listener: RunFinishedListener): () => void {
    this.runListeners.add(listener);
    return () => {
      this.runListeners.delete(listener);
    };
  }

  /** Fan out a run_finished event to every subscriber. A throwing subscriber is
   * caught and logged — one broken delivery must not take down the process or
   * block the other subscribers. */
  emitRunFinished(e: RunFinishedEvent): void {
    for (const l of [...this.runListeners]) {
      void Promise.resolve(l(e)).catch((err) => {
        console.error("[events] run_finished listener threw:", err);
      });
    }
  }
}
