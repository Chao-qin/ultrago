/**
 * Knowing when a navigation is actually DONE.
 *
 * `tabs.goBack/goForward/reload` resolve as soon as the navigation is
 * INITIATED, so the RPC used to return while the old document was tearing
 * down — and the next RPC injected into it and got "DOM target frame is gone".
 * `navigate` has waited for `complete` since day one; these three never did.
 *
 * The trigger is `onCommitted`, NOT `tab.status`: between announce and commit
 * the tab still reports the OLD document's `complete`, so consulting status
 * there resolves the barrier instantly — precisely in the case the barrier
 * exists for. After a commit, status is safe again, because any `complete`
 * then belongs to the new document.
 *
 * Split out of background.ts so those orderings can be asserted against fake
 * tabs/webNavigation APIs rather than a real browser.
 */

export interface TabLike {
  url?: string;
  title?: string;
  status?: string;
}

type UpdatedListener = (tabId: number, info: { status?: string }, tab: TabLike) => void;
type BeforeNavListener = (d: { tabId: number; frameId: number }) => void;
type CommittedListener = (d: {
  tabId: number;
  frameId: number;
  url: string;
  transitionType: string;
  transitionQualifiers?: string[];
}) => void;

export interface TabsApi {
  onUpdated: { addListener(l: UpdatedListener): void; removeListener(l: UpdatedListener): void };
  get(tabId: number): Promise<TabLike>;
  update(tabId: number, opts: { url: string }): Promise<unknown>;
}

export interface WebNavigationApi {
  onBeforeNavigate: { addListener(l: BeforeNavListener): void; removeListener(l: BeforeNavListener): void };
  onCommitted: { addListener(l: CommittedListener): void; removeListener(l: CommittedListener): void };
  getAllFrames(o: { tabId: number }): Promise<Array<{ frameId: number; url: string }> | null>;
}

export interface NavDeps {
  tabs: TabsApi;
  webNavigation: WebNavigationApi;
  /** Register the tab as driven, from the navigation rather than the first read. */
  markWatched(tabId: number): void;
}

export interface NavTimings {
  /** How long a commit gets to finish loading. */
  barrierMs?: number;
  /** How long a history navigation gets to ANNOUNCE itself before we conclude
   *  none was initiated. goBack/goForward decide locally and instantly. */
  announceMs?: number;
}

export interface HistoryNavResult {
  ok: true;
  navigated: boolean;
  url?: string;
  title?: string;
  transition?: string;
}

export function createNav({ tabs, webNavigation, markWatched }: NavDeps, timings: NavTimings = {}) {
  const BARRIER_MS = timings.barrierMs ?? 15000;
  const ANNOUNCE_MS = timings.announceMs ?? 1000;

  function waitTabComplete(tabId: number, timeoutMs: number, ignoreCurrentStatus = false): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      };
      const listener: UpdatedListener = (id, info) => {
        if (id === tabId && info.status === "complete") finish();
      };
      tabs.onUpdated.addListener(listener);
      const timer = setTimeout(finish, timeoutMs);
      // The tab may already be complete — onUpdated would then never fire. BUT
      // when a navigation was just announced, the tab still reports the OLD
      // document's `complete`, so trusting it resolves the barrier instantly.
      if (!ignoreCurrentStatus) {
        tabs
          .get(tabId)
          .then((t) => {
            if (t.status === "complete") finish();
          })
          .catch(finish);
      }
    });
  }

  /** The frames a tab has RIGHT NOW. "Target frame is gone" used to end the
   *  conversation; whether the ref's frameId is still in this list is what
   *  separates "re-snapshot, your refs are dead" from "the document was swapped
   *  under you" — and only the browser can answer it. */
  async function liveFrames(tabId: number): Promise<{ ids: number[]; listing: string } | null> {
    const frames = await webNavigation.getAllFrames({ tabId }).catch(() => null);
    if (!frames) return null;
    const listing =
      frames.slice(0, 10).map((f) => `  ${f.frameId}${f.frameId === 0 ? " (top)" : ""} ${f.url}`).join("\n") +
      (frames.length > 10 ? `\n  … ${frames.length - 10} more` : "");
    return { ids: frames.map((f) => f.frameId), listing };
  }

  /** Watch a tab's TOP frame for the next navigation. Must be armed BEFORE the
   *  call that should cause one — that ordering is what makes a later commit
   *  attributable to this action rather than to whatever else shares the tab. */
  function watchTopFrameNav(tabId: number) {
    let announced = false;
    let commit: { url: string; transition: string } | null = null;
    let notify: (() => void) | null = null;
    const beforeL: BeforeNavListener = (d) => {
      if (d.tabId === tabId && d.frameId === 0) announced = true;
    };
    const commitL: CommittedListener = (d) => {
      if (d.tabId !== tabId || d.frameId !== 0 || commit) return;
      commit = { url: d.url, transition: [d.transitionType, ...(d.transitionQualifiers ?? [])].join("+") };
      notify?.();
    };
    webNavigation.onBeforeNavigate.addListener(beforeL);
    webNavigation.onCommitted.addListener(commitL);
    return {
      seenAnnounce: () => announced,
      seenCommit: () => commit,
      waitCommit: (ms: number) =>
        new Promise<void>((resolve) => {
          if (commit) return resolve();
          const timer = setTimeout(() => {
            notify = null;
            resolve();
          }, ms);
          notify = () => {
            clearTimeout(timer);
            notify = null;
            resolve();
          };
        }),
      stop: () => {
        webNavigation.onBeforeNavigate.removeListener(beforeL);
        webNavigation.onCommitted.removeListener(commitL);
      },
    };
  }

  async function historyNav(tabId: number, act: () => Promise<void>): Promise<HistoryNavResult> {
    const w = watchTopFrameNav(tabId);
    try {
      await act();
      await w.waitCommit(ANNOUNCE_MS);
      // Announced but not committed yet = a real navigation waiting on the
      // network. Give it the barrier's time rather than calling it a no-op:
      // "nothing happened" is the answer that makes an agent do it twice.
      if (!w.seenCommit() && w.seenAnnounce()) await w.waitCommit(BARRIER_MS);
      const c = w.seenCommit();
      if (!c) return { ok: true, navigated: false };
      // Safe HERE: the commit already happened, so any `complete` belongs to the
      // NEW document — which is exactly what is not true between announce and
      // commit, hence ignoreCurrentStatus on the injection barrier.
      await waitTabComplete(tabId, BARRIER_MS);
      const t = await tabs.get(tabId).catch(() => undefined);
      return {
        ok: true,
        navigated: true,
        url: t?.url ?? c.url,
        // A title read before `complete` is still the OLD document's — omit it
        // rather than report a stale one (this is the timeout path).
        ...(t?.status === "complete" ? { title: t.title ?? "" } : {}),
        transition: c.transition,
      };
    } finally {
      w.stop();
    }
  }

  function navigateAndWait(tabId: number, url: string): Promise<{ tabId: number; url: string; title: string }> {
    // Watch from the navigation itself, not from the first snapshot: a tab the
    // agent sends somewhere and never looks at again is precisely the one whose
    // block would otherwise go unnoticed.
    markWatched(tabId);
    return new Promise((resolve, reject) => {
      const done = (tab: TabLike): void => {
        tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve({ tabId, url: tab.url ?? url, title: tab.title ?? "" });
      };
      const listener: UpdatedListener = (id, info, tab) => {
        if (id === tabId && info.status === "complete") done(tab);
      };
      tabs.onUpdated.addListener(listener);
      const timer = setTimeout(() => {
        tabs.get(tabId).then(done).catch((e) => {
          tabs.onUpdated.removeListener(listener);
          reject(e);
        });
      }, BARRIER_MS);
      tabs.update(tabId, { url }).catch((e) => {
        tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  return { waitTabComplete, liveFrames, watchTopFrameNav, historyNav, navigateAndWait };
}
