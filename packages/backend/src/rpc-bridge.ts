import { randomUUID } from "node:crypto";
import type { RpcErrorInfo, RpcMethod, RpcRequestMessage, RpcResponseMessage } from "@bcp/shared";

/**
 * A failed RPC, with the extension's structured diagnosis still attached.
 *
 * The wire carries `error` (a sentence, for people) and an optional
 * `errorInfo` (a code, for programs). Rejecting with a bare `new Error(msg)`
 * threw the second one away, which left callers no way to tell "this selector
 * no longer matches" from "the browser went away" except by reading the prose.
 */
export interface RpcError extends Error {
  errorInfo?: RpcErrorInfo;
}

export function rpcError(message: string, errorInfo?: RpcErrorInfo): RpcError {
  const e = new Error(message) as RpcError;
  if (errorInfo) e.errorInfo = errorInfo;
  return e;
}

/**
 * The structured diagnosis behind a failure, when the extension sent one.
 *
 * Returns undefined for everything else — timeouts, disconnects, an older
 * extension that predates the field. Callers must treat that as "unknown, so
 * not recoverable" rather than guessing from the message.
 */
export function rpcErrorInfoOf(e: unknown): RpcErrorInfo | undefined {
  return e instanceof Error ? (e as RpcError).errorInfo : undefined;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  /** The exact frame, kept so it can be re-sent to a fresh socket on reconnect. */
  req: RpcRequestMessage;
}

/**
 * Correlates backend-initiated RPC requests with the extension's responses
 * over the single WebSocket. Each request gets a UUID; the matching
 * `rpc_response` frame resolves the promise.
 *
 * Survives reconnects: an in-flight RPC is NOT failed when the socket drops
 * (the extension's service worker may just be respawning). It stays pending,
 * bounded by its timeout, and is re-sent on the next connection. The extension
 * dispatches by id, so a re-send that races a late response is deduped by the
 * `pending` map (first response wins, the rest are ignored).
 */
export class RpcBridge {
  private pending = new Map<string, Pending>();

  constructor(
    private send: (msg: RpcRequestMessage) => void,
    private timeoutMs: number,
  ) {}

  /** Issue an RPC and await the extension's response. */
  request<T = unknown>(method: RpcMethod, params: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const id = randomUUID();
    const req: RpcRequestMessage = { type: "rpc_request", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer, req });
      this.send(req);
    });
  }

  /** Re-send every still-pending request to the (new) active socket. Called
   * after a reconnect so RPCs that were in flight during the drop complete. */
  resend(): void {
    for (const [, p] of this.pending) this.send(p.req);
  }

  /** Route an incoming `rpc_response` frame to its waiting caller. */
  resolve(msg: RpcResponseMessage): void {
    const p = this.pending.get(msg.id);
    if (!p) return; // late/duplicate/timed-out response — ignore
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(rpcError(msg.error, msg.errorInfo));
  }

  close(error = new Error("RPC bridge is shutting down")): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
