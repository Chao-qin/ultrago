/**
 * Recent XHR/fetch per tab, so `read_network` can confirm a save actually hit
 * the server (status 2xx) instead of the agent inferring it from the UI.
 *
 * Bounded per tab: a long-lived page would otherwise grow this without limit,
 * and only the tail is ever useful.
 */
import type { NetworkRequest } from "@bcp/shared";

export interface NetLog {
  push(tabId: number, r: NetworkRequest): void;
  get(tabId: number): NetworkRequest[];
  forget(tabId: number): void;
}

export function createNetLog(cap = 100): NetLog {
  const byTab = new Map<number, NetworkRequest[]>();
  return {
    push(tabId, r) {
      if (tabId < 0) return; // service-worker / background traffic, not a tab's
      const arr = byTab.get(tabId) ?? [];
      arr.push(r);
      if (arr.length > cap) arr.shift();
      byTab.set(tabId, arr);
    },
    get: (tabId) => byTab.get(tabId) ?? [],
    forget(tabId) {
      byTab.delete(tabId);
    },
  };
}
