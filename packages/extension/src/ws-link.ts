/**
 * The socket to the backend, and getting it back after it drops.
 *
 * Two things the platform does not give us:
 *   - A native WebSocket has NO connect timeout. A CONNECTING attempt can hang
 *     until TCP gives up, which on some networks is minutes — so an attempt is
 *     killed after a fixed window and the normal close path takes over.
 *   - Nothing coalesces reconnect attempts. Without the pending-timer guard,
 *     every close and every failed construct would queue another one.
 *
 * The backoff resets on a successful handshake rather than on connect: the
 * socket opening proves nothing, since a backend that rejects us closes it
 * again immediately, and resetting there would spin at the floor.
 *
 * Split out of background.ts so the sequencing can be asserted against a fake
 * socket rather than a real backend.
 */
import type { ConnState } from "./messaging";

/** The slice of WebSocket this needs. Numeric states match the platform. */
export interface SocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export const CONNECTING = 0;
export const OPEN = 1;

export interface WsLinkDeps {
  /** Read at connect time, so a settings change takes effect on reconnect. */
  url(): string;
  /** Construct a socket. May throw — a bad URL must not kill the worker. */
  open(url: string): SocketLike;
  /** The socket just opened: send the handshake. */
  onOpen(): void;
  /** A parsed message arrived. Unparseable frames never reach here. */
  onMessage(msg: unknown): void;
  onState(next: ConnState): void;
}

export interface WsLinkTimings {
  connectTimeoutMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  backoffFactor?: number;
}

export interface WsLink {
  connect(): void;
  /** Serialise and send. Returns false when the socket is not open — callers
   *  that must not lose the message have to notice. */
  send(msg: unknown): boolean;
  /** Call on a successful handshake, not merely on open. */
  handshakeComplete(): void;
  state(): ConnState;
  /** Current backoff, exposed for diagnostics and tests. */
  backoffMs(): number;
  isOpen(): boolean;
  /** Tear the socket down WITHOUT letting it schedule a backoff, then reconnect
   *  from the floor. For a settings change and for the keepalive's liveness
   *  check — both know the current socket is not the one they want, so going
   *  through the normal close path would only add a delay. */
  reset(): void;
}

export function createWsLink(deps: WsLinkDeps, timings: WsLinkTimings = {}): WsLink {
  const CONNECT_TIMEOUT_MS = timings.connectTimeoutMs ?? 10_000;
  const BACKOFF_INITIAL = timings.backoffInitialMs ?? 1000;
  const BACKOFF_MAX = timings.backoffMaxMs ?? 15_000;
  const BACKOFF_FACTOR = timings.backoffFactor ?? 1.5;

  let ws: SocketLike | null = null;
  let conn: ConnState = "disconnected";
  let backoff = BACKOFF_INITIAL;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function setConn(next: ConnState): void {
    conn = next;
    deps.onState(next);
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return; // already queued — do not stack attempts
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      link.connect();
    }, backoff);
    backoff = Math.min(Math.round(backoff * BACKOFF_FACTOR), BACKOFF_MAX);
  }

  const link: WsLink = {
    connect() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws && (ws.readyState === OPEN || ws.readyState === CONNECTING)) return;

      setConn("connecting");
      let socket: SocketLike;
      try {
        socket = deps.open(deps.url());
      } catch {
        scheduleReconnect();
        return;
      }
      ws = socket;

      const connectTimeout = setTimeout(() => {
        if (socket.readyState === CONNECTING) socket.close();
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        clearTimeout(connectTimeout);
        deps.onOpen();
      };
      socket.onmessage = (ev) => {
        let msg: unknown;
        try {
          msg = JSON.parse(ev.data as string);
        } catch {
          return; // a frame we cannot read is not a reason to tear anything down
        }
        deps.onMessage(msg);
      };
      socket.onclose = () => {
        clearTimeout(connectTimeout);
        setConn("disconnected");
        scheduleReconnect();
      };
      socket.onerror = () => {
        /* the close handler runs next and schedules the reconnect */
      };
    },

    send(msg) {
      if (ws?.readyState !== OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },

    handshakeComplete() {
      if (ws?.readyState !== OPEN) return;
      backoff = BACKOFF_INITIAL;
      setConn('connected');
    },

    state: () => conn,
    backoffMs: () => backoff,
    isOpen: () => ws?.readyState === OPEN,

    reset() {
      if (ws) {
        ws.onclose = null; // do not let the teardown queue a backoff
        ws.onerror = null;
        ws.close();
        ws = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      backoff = BACKOFF_INITIAL;
      link.connect();
    },
  };
  return link;
}
