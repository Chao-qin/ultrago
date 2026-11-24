/**
 * Per-tab network quiet detection — the PRIMARY readiness signal.
 *
 * A skeleton screen does not move the DOM while its XHRs are still in flight,
 * so waiting on DOM mutation alone confidently hands back the skeleton
 * (.agent/learn.md 2026-07-21). The network view answers "is this page still
 * fetching", and `settleDom` is only the fallback underneath it.
 *
 * Three rules this encodes, each of which was a bug first:
 *   - Track a SET of requestIds, never a counter. Requests already in flight
 *     when the listener attached deliver a completion with no matching start;
 *     a counter goes negative and then claims idle forever.
 *   - Answer UNKNOWN (null) for a tab we did not watch from its main_frame.
 *     Degrading to "idle" would silently return a half-loaded page — and a
 *     recycled service worker loses the map, so this is the common case.
 *   - Stop counting a request that has been open too long. Long-poll arrives
 *     as `xmlhttprequest` and SSE as `other`, indistinguishable by type from a
 *     real load, so any chat or live dashboard would otherwise keep one
 *     request in flight forever and burn the full wait on every read.
 */

/** Request types that may legitimately never finish. NOT sufficient on its own
 *  — see `streamAfterMs`. */
const NEVER_SETTLES = new Set(["websocket", "media", "ping", "csp_report", "other"]);

export interface NetIdleOptions {
  /** Quiet window before a tab counts as idle. */
  idleMs?: number;
  /** Older than this: the request hung — forget it entirely. */
  maxAgeMs?: number;
  /** Older than this: treat as a stream, not a pending load. */
  streamAfterMs?: number;
  /** Default ceiling for `waitIdle`. */
  waitMs?: number;
  /** Injectable clock (tests drive time instead of sleeping). */
  now?: () => number;
  /** Injectable sleep, so `waitIdle` can be stepped in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestStart {
  tabId: number;
  requestId: string;
  type: string;
  url: string;
}

export interface NetIdleTracker {
  onRequestStart(d: RequestStart): void;
  onRequestDone(d: { tabId: number; requestId: string }): void;
  onTabRemoved(tabId: number): void;
  /** Requests still open right now (hung ones excluded), with the oldest — what a read reports instead of quietly
   *  treating a request past `streamAfterMs` as a stream: it may be a slow search the page is still waiting on.
   *  Null when the view is not trustworthy. */
  openRequests(tabId: number): { count: number; oldestMs: number; oldestUrl: string } | null;
  /** In-flight count, or null when the view is not trustworthy. */
  inflightCount(tabId: number): number | null;
  waitIdle(tabId: number, timeoutMs?: number): Promise<void>;
}

export function createNetIdleTracker(opts: NetIdleOptions = {}): NetIdleTracker {
  const idleMs = opts.idleMs ?? 500;
  const maxAgeMs = opts.maxAgeMs ?? 10_000;
  const streamAfterMs = opts.streamAfterMs ?? 2500;
  const waitMs = opts.waitMs ?? 5000;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** tabId -> (requestId -> startedAt, url) */
  const inflight = new Map<number, Map<string, { at: number; url: string }>>();
  /** Tabs whose in-flight view we actually hold (watched from main_frame). */
  const seen = new Set<number>();
  /** Last time anything started or finished, so a long-quiet page need not pay
   *  the idle window again on every read. */
  const lastActivity = new Map<number, number>();

  return {
    onRequestStart({ tabId, requestId, type, url }) {
      if (tabId < 0) return; // service-worker / background traffic, not a tab's
      // Only a main_frame request proves we watched this page from its start.
      // Also drops the previous document's set, the way Playwright does on commit.
      if (type === "main_frame") {
        seen.add(tabId);
        inflight.get(tabId)?.clear();
      }
      lastActivity.set(tabId, now());
      if (NEVER_SETTLES.has(type)) return;
      if (/\/favicon\.ico(\?|$)/.test(url)) return; // phantom request on every navigation
      let m = inflight.get(tabId);
      if (!m) inflight.set(tabId, (m = new Map()));
      m.set(requestId, { at: now(), url });
    },

    onRequestDone({ tabId, requestId }) {
      if (tabId < 0) return;
      inflight.get(tabId)?.delete(requestId);
      lastActivity.set(tabId, now());
    },

    onTabRemoved(tabId) {
      inflight.delete(tabId);
      seen.delete(tabId);
      lastActivity.delete(tabId);
    },

    inflightCount(tabId) {
      if (!seen.has(tabId)) return null;
      const m = inflight.get(tabId);
      if (!m) return 0;
      const t = now();
      const drop = t - maxAgeMs;
      const stream = t - streamAfterMs;
      let live = 0;
      for (const [id, { at }] of m) {
        if (at < drop) {
          m.delete(id); // hung: forget it entirely
          continue;
        }
        if (at >= stream) live++; // older than that is a stream, not a pending load
      }
      return live;
    },

    openRequests(tabId) {
      if (!seen.has(tabId)) return null;
      const t = now();
      let count = 0;
      let oldest: { at: number; url: string } | undefined;
      for (const r of inflight.get(tabId)?.values() ?? []) {
        if (r.at < t - maxAgeMs) continue; // hung: inflightCount forgets it
        count++;
        if (!oldest || r.at < oldest.at) oldest = r;
      }
      return oldest ? { count, oldestMs: t - oldest.at, oldestUrl: oldest.url } : { count: 0, oldestMs: 0, oldestUrl: "" };
    },

    async waitIdle(tabId, timeoutMs = waitMs) {
      if (this.inflightCount(tabId) === null) return;
      const deadline = now() + timeoutMs;
      // Seed the quiet window from the last OBSERVED activity, not from now: a
      // page that went quiet minutes ago has nothing left to wait for, and
      // starting the clock at call time charged every read a flat idleMs.
      let quietSince: number | null =
        this.inflightCount(tabId) === 0 ? (lastActivity.get(tabId) ?? 0) : null;
      for (;;) {
        const n = this.inflightCount(tabId);
        if (n === null) return;
        if (n === 0) {
          quietSince ??= now();
          if (now() - quietSince >= idleMs) return;
        } else {
          quietSince = null;
        }
        if (now() >= deadline) return;
        await sleep(50);
      }
    },
  };
}
