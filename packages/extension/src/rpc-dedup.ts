/**
 * At-least-once delivery, made idempotent.
 *
 * The backend resends an in-flight RPC after a reconnect (it cannot know
 * whether the response was lost on the way back), so the same id can arrive
 * twice. Without dedup a click or a navigate whose reply went missing executes
 * a SECOND time — the failure documented in .agent/learn.md 2026-07-21.
 *
 * Two layers, because the service worker is recycled at will:
 *   - an in-memory map, which also collapses CONCURRENT resends;
 *   - session storage for mutating methods, which is the only layer that
 *     survives a recycle. That is the whole point of learn.md's conclusion
 *     that continuity must be persisted rather than held in memory.
 *
 * Reads are deliberately not persisted: re-running a snapshot is harmless, and
 * writing every read to storage would cost more than it saves.
 */
import type { RpcMethod } from "@bcp/shared";
import type { ExecResponse } from "./messaging";

/** The slice of `chrome.storage.session` this needs. */
export interface DedupStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface RpcDeduperDeps {
  store: DedupStore;
  /** Actually perform the call. Invoked at most once per id. */
  dispatch: (method: RpcMethod, params: unknown) => Promise<ExecResponse>;
  /** Whether a second execution of this method would have a real side effect. */
  isMutating: (method: RpcMethod) => boolean;
  /** In-memory entries kept before the oldest is dropped. */
  cap?: number;
}

export interface RpcDeduper {
  runOnce(id: string, method: RpcMethod, params: unknown): Promise<ExecResponse>;
}

export function createRpcDeduper({ store, dispatch, isMutating, cap = 256 }: RpcDeduperDeps): RpcDeduper {
  const byId = new Map<string, Promise<ExecResponse>>();
  const key = (id: string): string => `rpc:${id}`;

  async function persist(id: string, res: ExecResponse): Promise<void> {
    try {
      await store.set({ [key(id)]: res });
    } catch {
      /* storage full/unavailable — dedup degrades to in-memory only */
    }
  }

  async function recall(id: string): Promise<ExecResponse | undefined> {
    try {
      const got = await store.get(key(id));
      return got[key(id)] as ExecResponse | undefined;
    } catch {
      return undefined;
    }
  }

  return {
    async runOnce(id, method, params) {
      const seen = byId.get(id);
      if (seen) return seen;

      // Reserve the slot SYNCHRONOUSLY — before any await — so two resends that
      // arrive in the same tick both find it. Awaiting first would let the
      // second one through while the first is still checking storage.
      let settle!: (r: ExecResponse) => void;
      const slot = new Promise<ExecResponse>((r) => (settle = r));
      byId.set(id, slot);
      if (byId.size > cap) {
        const oldest = byId.keys().next().value;
        if (oldest !== undefined) byId.delete(oldest);
      }

      if (isMutating(method)) {
        const cached = await recall(id);
        if (cached) {
          settle(cached);
          return cached;
        }
      }
      const res = await dispatch(method, params);
      if (isMutating(method)) void persist(id, res);
      settle(res);
      return res;
    },
  };
}
