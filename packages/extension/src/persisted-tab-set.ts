/**
 * A set of tab ids that has to outlive the service worker.
 *
 * MV3 recycles the worker aggressively and an in-memory Set empties every
 * time. Two of these exist — tabs with body capture on, and tabs this
 * extension has driven — and an emptied set is silently wrong in both cases:
 * navigation stops re-arming the capture patch while the agent still believes
 * capture is on, and driven tabs stop reporting challenges nobody asked about.
 *
 * The rule this type exists to enforce: **hydrate before mutating.** Persisting
 * writes the WHOLE set, so adding to a set a recycle just emptied replaces the
 * stored list with a single id and un-watches everything else — worse than not
 * persisting at all. Callers cannot forget, because `add` does it for them.
 */

/** The slice of `chrome.storage.session` this needs. */
export interface SessionStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface PersistedTabSet {
  /** Load the stored ids once. Safe to call repeatedly — the read is shared. */
  hydrate(): Promise<void>;
  /** Hydrates, then adds and persists. No-op for ids already present. */
  add(tabId: number): Promise<void>;
  /** Removes and persists if it was there. Returns whether it was. */
  remove(tabId: number): Promise<boolean>;
  has(tabId: number): boolean;
  values(): number[];
}

export function createPersistedTabSet(key: string, store: SessionStore): PersistedTabSet {
  const ids = new Set<number>();
  let hydration: Promise<void> | undefined;

  async function persist(): Promise<void> {
    try {
      await store.set({ [key]: [...ids] });
    } catch {
      /* storage unavailable — degrades to this worker's lifetime */
    }
  }

  const self: PersistedTabSet = {
    hydrate() {
      hydration ??= (async () => {
        try {
          const got = await store.get(key);
          for (const id of (got[key] as number[] | undefined) ?? []) ids.add(id);
        } catch {
          /* storage unavailable — see the header */
        }
      })();
      return hydration;
    },

    async add(tabId) {
      if (tabId < 0) return;
      await self.hydrate();
      if (ids.has(tabId)) return;
      ids.add(tabId);
      await persist();
    },

    async remove(tabId) {
      await self.hydrate();
      if (!ids.delete(tabId)) return false;
      await persist();
      return true;
    },

    has: (tabId) => ids.has(tabId),
    values: () => [...ids],
  };
  return self;
}
