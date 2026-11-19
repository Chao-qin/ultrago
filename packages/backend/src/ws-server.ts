import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import {
  EVAL_TIMEOUT_MS,
  WAIT_FOR_MAX_MS,
  PROTOCOL_VERSION,
  RpcMethod,
  browserLabel,
  isValidInstanceId,
  type BrowserErrorCode,
  type BrowserEvent,
  type BrowserKind,
  type BrowserStatus,
  type BrowserTarget,
  type ClientMessage,
  type ServerMessage,
} from "@bcp/shared";
import { config } from "./config.js";
import { RpcBridge } from "./rpc-bridge.js";
import { EventStore } from "./event-store.js";

const HEARTBEAT_MS = 15_000;

/** eval's transport ceiling, DERIVED from the page-side cap rather than read
 * from `config.rpcTimeoutMs`. The page timer has to fire first — that is what
 * makes the error attributable and lets the injected async code be collected
 * instead of left running in the page with nobody listening. Reading the
 * configurable value here would let `BCP_RPC_TIMEOUT_MS=10000` invert that
 * ordering silently, with nothing to report it. */
export const EVAL_RPC_TIMEOUT_MS = EVAL_TIMEOUT_MS * 2;
/** Missed pongs tolerated before terminating (× HEARTBEAT_MS ≈ grace window).
 * 3 ≈ 45s, longer than the extension's 30s keepalive-alarm revival. */
const HEARTBEAT_MAX_MISSES = 3;

/** One live extension connection, keyed by its INSTANCE id. ready=false until
 * the extension completes hello → welcome → ready; only a ready session may
 * receive RPCs (the readiness gate lives in BrowserDispatcher, this flag is
 * its ground truth). */
interface ExtSession {
  ws: WebSocket;
  target: BrowserTarget;
  sessionId: string;
  connectedAt: number;
  ready: boolean;
  clientName?: string;
  clientVersion?: string;
  artifactHash?: string;
  protocolVersion?: number;
}

export interface BrowserInfo {
  kind: BrowserKind;
  instanceId: string;
  connectedAt: number;
  current: boolean;
  /** "manual" = the user is personally driving this browser: agents must not
   * switch its tabs or steal its view; operations need an explicit tabId. */
  mode: "auto" | "manual";
  ready: boolean;
}

/** Handshake-rejection notification, fanned out so setup waiters learn WHY a
 * target never became ready (auth_rejected / protocol_incompatible / …). */
export interface HandshakeRejectedEvent {
  kind: BrowserKind;
  instanceId?: string;
  code: BrowserErrorCode;
  message: string;
}

interface ReadyWaiter {
  resolve: (session: ExtSession) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** A WebSocket close reason must fit in 123 bytes (RFC 6455 §5.5.1); `ws` throws
 * RangeError beyond that. Cut on CHARACTER boundaries so a multi-byte character
 * is never split in half, and mark the cut so the reader knows to look at the
 * `reject` frame for the rest. */
function closeReasonOf(reason: string): string {
  const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
  if (bytes(reason) <= 123) return reason;
  let out = "";
  for (const ch of reason) {
    if (bytes(out + ch + "…") > 123) break;
    out += ch;
  }
  return out + "…";
}

/**
 * Owns the WebSocket endpoint and the connected extension sessions. Sessions
 * are keyed by BrowserTarget (kind + instanceId) — a browser LABEL is display
 * only, never a routing key. Several instances of the same kind (Chrome +
 * Chrome with different instanceIds) coexist and are fully isolated: actions,
 * probes, claims and run routing never cross instance boundaries.
 *
 * Handshake (v5): hello(kind, instanceId, artifactHash) → welcome → ready.
 * Only `ready` marks the session authenticated/connected — hello alone is
 * never enough. Handles per-connection heartbeat and demuxes incoming frames
 * into per-session RPC responses.
 */
export class WsServer {
  private wss: WebSocketServer;
  /** Live sessions keyed by instanceId. A reconnect under the same instanceId
   * replaces that session only; a DIFFERENT instanceId never replaces it. */
  private readonly sessions = new Map<string, ExtSession>();
  /** Persistent for the process lifetime so in-flight RPCs survive a reconnect
   * of their browser (send() targets whatever socket holds that instance now). */
  private readonly bridges = new Map<string, RpcBridge>();
  /** Default target all no-explicit-target routing follows. Sticky: a newly
   * connecting instance only becomes the default when there is none yet. */
  private defaultTarget: BrowserTarget | null = null;
  private desktopTarget: BrowserTarget | null = null;

  /** Waiters blocked in waitForReady(target), keyed by instanceId. */
  private readonly readyWaiters = new Map<string, ReadyWaiter[]>();

  /** Page-originated events pushed by the extensions (navigation/dialog/…). */
  readonly events = new EventStore();

  /** Handshake rejections (bad token / protocol / identity). */
  readonly onHandshakeRejected = new EventEmitter();

  /** Per-instance interaction mode; "manual" marks a browser the user drives. */
  private readonly modes = new Map<string, "auto" | "manual">();

  /** Process-wide claim registry (cross-session visibility). Keyed by session
   * id, each claim is bound to an instanceId (claims never cross instances). */
  private readonly claims = new Map<string, { instanceId: string; tabId: number; since: number }>();

  /** Pending debounced browser_offline broadcasts, keyed by instanceId. */
  private readonly pendingOffline = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly OFFLINE_DEBOUNCE_MS = 3_000;

  constructor() {
    this.wss = new WebSocketServer({ host: config.host, port: config.port });
    this.wss.on("connection", (ws) => this.handleConnection(ws));
    this.wss.on("listening", () =>
      console.log(`[ws] listening on ws://127.0.0.1:${this.boundPort}`),
    );
  }

  /** The port the WS server actually bound (useful for tests with BCP_PORT=0). */
  get boundPort(): number {
    const addr = this.wss.address();
    return typeof addr === "object" && addr ? addr.port : config.port;
  }

  async listening(): Promise<number> {
    if (this.wss.address()) return this.boundPort;
    await new Promise<void>((resolve, reject) => {
      const ready = () => { this.wss.off('error', failed); resolve(); };
      const failed = (error: Error) => { this.wss.off('listening', ready); reject(error); };
      this.wss.once('listening', ready);
      this.wss.once('error', failed);
    });
    return this.boundPort;
  }

  /** Whether the default target currently has a live, READY session. */
  get isConnected(): boolean {
    const t = this.current();
    if (!t) return false;
    const s = this.sessions.get(t.instanceId);
    return !!s && s.ready && s.ws.readyState === WebSocket.OPEN;
  }

  /* ----------------------------- topology events ----------------------------- */

  private pushTopo(kind: BrowserEvent["kind"], target: BrowserTarget | undefined, summary: string, detail?: Record<string, unknown>): void {
    this.events.push({
      kind,
      tabId: -1,
      ts: Date.now(),
      summary,
      detail: target ? { ...detail, kind: target.kind, instanceId: target.instanceId } : detail,
      browser: target?.instanceId,
    });
  }

  /* ----------------------------- claims (cross-session) ----------------------------- */

  setClaim(sessionId: string, target: BrowserTarget, tabId: number, since: number): void {
    this.claims.set(sessionId, { instanceId: target.instanceId, tabId, since });
    this.pushTopo("claim_changed", target, `session ${sessionId} claimed tab ${tabId} in ${browserLabel(target)}`, { sessionId, tabId, action: "claim" });
  }

  clearClaim(sessionId: string): void {
    const prev = this.claims.get(sessionId);
    this.claims.delete(sessionId);
    if (prev) {
      const target = { kind: this.sessionKindOf(prev.instanceId), instanceId: prev.instanceId };
      this.pushTopo("claim_changed", target, `session ${sessionId} released tab ${prev.tabId} in ${prev.instanceId}`, { sessionId, tabId: prev.tabId, action: "release" });
    }
  }

  private sessionKindOf(instanceId: string): BrowserKind {
    return this.sessions.get(instanceId)?.target.kind ?? "chrome";
  }

  /** Live claims whose instance is currently connected, each tagged with its
   * owning session id so a caller can exclude its own. READ-only. */
  listClaims(): Array<{ sessionId: string; instanceId: string; tabId: number; since: number }> {
    const out: Array<{ sessionId: string; instanceId: string; tabId: number; since: number }> = [];
    for (const [sessionId, c] of this.claims) {
      if (this.sessions.has(c.instanceId)) out.push({ sessionId, ...c });
    }
    return out;
  }

  /* ----------------------------- registry ----------------------------- */

  /** Connected browsers, oldest first, with the global default flagged. */
  listBrowsers(): BrowserInfo[] {
    return [...this.sessions.values()]
      .sort((a, b) => a.connectedAt - b.connectedAt)
      .map((s) => ({
        kind: s.target.kind,
        instanceId: s.target.instanceId,
        connectedAt: s.connectedAt,
        current: this.current()?.instanceId === s.target.instanceId,
        mode: this.getMode(s.target.instanceId),
        ready: s.ready,
      }));
  }

  /** Live target instances (kind + instanceId) — for the setup service's
   * status view and the dispatcher's candidate probe. */
  listInstances(): Array<{ target: BrowserTarget; ready: boolean }> {
    return [...this.sessions.values()].map((s) => ({ target: s.target, ready: s.ready }));
  }

  /** Throws (with the connected list) unless `target` is a live session. */
  validate(target: BrowserTarget): void {
    if (!this.sessions.has(target.instanceId)) {
      const connected = this.listBrowsers().map((b) => browserLabel(b));
      throw new Error(
        `browser ${browserLabel(target)} is not connected${connected.length ? ` — connected: ${connected.join(", ")}` : " — no browsers connected"}`,
      );
    }
  }

  /** Global default target (sessions without an explicit target follow it). */
  current(): BrowserTarget | null {
    return process.env.BCP_DESKTOP === '1' ? this.desktopTarget : this.defaultTarget;
  }

  selectDesktopTarget(target: BrowserTarget): void {
    this.validate(target);
    if (!this.isReady(target)) throw new Error('selected browser is not ready');
    this.desktopTarget = { ...target };
  }

  /** Whether `target` has a live session that completed hello→welcome→ready. */
  isReady(target: BrowserTarget): boolean {
    const s = this.sessions.get(target.instanceId);
    return !!s && s.ready && s.ws.readyState === WebSocket.OPEN;
  }

  /** Extension identity/state for `target`, as surfaced in BrowserStatus. */
  extensionInfo(target: BrowserTarget): BrowserStatus["extension"] {
    const s = this.sessions.get(target.instanceId);
    if (!s) return undefined;
    return {
      connected: s.ready && s.ws.readyState === WebSocket.OPEN,
      clientName: s.clientName,
      clientVersion: s.clientVersion,
      artifactHash: s.artifactHash,
      protocolVersion: s.protocolVersion,
      sessionId: s.sessionId,
      connectedAt: s.connectedAt,
    };
  }

  /** Wait until `target`'s extension completes hello→welcome→ready, or reject
   * with a structured error on timeout / handshake rejection. The single
   * primitive the setup service's ensureBrowserReady builds on. */
  waitForReady(target: BrowserTarget, timeoutMs: number): Promise<ExtSession> {
    const existing = this.sessions.get(target.instanceId);
    if (existing?.ready && existing.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(existing);
    }
    return new Promise<ExtSession>((resolve, reject) => {
      const settle = (session: ExtSession): void => {
        cleanup();
        resolve(session);
      };
      const fail = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        const arr = this.readyWaiters.get(target.instanceId) ?? [];
        this.readyWaiters.set(target.instanceId, arr.filter((w) => w.resolve !== settle));
        this.onHandshakeRejected.removeListener("rejected", onReject);
      };
      const onReject = (e: HandshakeRejectedEvent): void => {
        if (e.kind === target.kind && (e.instanceId === undefined || e.instanceId === target.instanceId)) {
          fail(
            new Error(
              `${e.code}: ${e.message} (target ${browserLabel(target)}${e.instanceId === undefined ? " rejected before identifying itself" : ""})`,
            ),
          );
        }
      };
      const timer = setTimeout(() => {
        fail(
          new Error(
            `extension_timeout: no ready ack from ${browserLabel(target)} within ${timeoutMs}ms — is the extension installed/loaded?`,
          ),
        );
      }, timeoutMs);
      this.onHandshakeRejected.on("rejected", onReject);
      const w: ReadyWaiter = { resolve: settle, reject: fail, timer };
      const arr = this.readyWaiters.get(target.instanceId) ?? [];
      arr.push(w);
      this.readyWaiters.set(target.instanceId, arr);
    });
  }

  getMode(instanceId: string): "auto" | "manual" {
    return this.modes.get(instanceId) ?? "auto";
  }

  setMode(target: BrowserTarget, mode: "auto" | "manual"): void {
    this.validate(target);
    this.modes.set(target.instanceId, mode);
    console.log(`[ws] ${browserLabel(target)} mode -> ${mode}`);
    this.pushTopo("mode_changed", target, `${browserLabel(target)} switched to ${mode} mode`, { mode });
  }

  async close(timeoutMs = 5_000): Promise<void> {
    for (const t of this.pendingOffline.values()) clearTimeout(t);
    this.pendingOffline.clear();
    for (const bridge of this.bridges.values()) bridge.close();
    for (const socket of this.wss.clients) socket.close(1001, "backend shutting down");
    const closed = new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
    if (this.wss.clients.size > 0) {
      for (const socket of this.wss.clients) socket.terminate();
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
    }
  }

  /** Longer ceilings for RPCs that legitimately take a while. */
  private static readonly RPC_TIMEOUT: Partial<Record<RpcMethod, number>> = {
    [RpcMethod.Navigate]: 45_000,
    [RpcMethod.Upload]: 60_000,
    // The tool rejects anything above WAIT_FOR_MAX_MS; the margin covers dispatch.
    [RpcMethod.WaitFor]: WAIT_FOR_MAX_MS + 5_000,
    // Book signal waits carry their own deadline (signal/gate timeoutMs); the
    // transport ceiling must not cut it short. 3min covers the longest
    // declared signal a book may reasonably use; the wait itself still ends at
    // its own deadline.
    [RpcMethod.WaitSignal]: 180_000,
    [RpcMethod.Eval]: EVAL_RPC_TIMEOUT_MS,
  };

  /** Drive a browser action in a target instance's extension and await its
   * result. `target` may be a BrowserTarget or a bare instanceId (the
   * dispatcher's routing key). Only READY sessions route; a once-ready but
   * momentarily-disconnected instance keeps its bridge (SW respawn) so the
   * RPC queues and re-sends on reconnect. */
  callBrowser<T = unknown>(method: RpcMethod, params: unknown, target?: BrowserTarget | string): Promise<T> {
    const instanceId = target == null ? this.current()?.instanceId : typeof target === "string" ? target : target.instanceId;
    if (!instanceId) {
      return Promise.reject(new Error("No extension connected — open the side panel."));
    }
    if (!this.sessions.has(instanceId) && !this.bridges.has(instanceId)) {
      const connected = this.listBrowsers().map((b) => browserLabel(b));
      return Promise.reject(
        new Error(
          `browser "${instanceId}" is not connected${connected.length ? ` — connected: ${connected.join(", ")}` : " — no browsers connected"}`,
        ),
      );
    }
    return this.request<T>(instanceId, method, params);
  }

  /** Issue the RPC on `instanceId`'s bridge; when it times out while that
   * browser has no live socket, re-attribute the error. */
  private request<T>(instanceId: string, method: RpcMethod, params: unknown): Promise<T> {
    return this.bridgeFor(instanceId)
      .request<T>(method, params, WsServer.RPC_TIMEOUT[method] ?? config.rpcTimeoutMs)
      .catch((e: unknown) => {
        if (e instanceof Error && e.message.includes("timed out") && !this.sessions.has(instanceId)) {
          const connected = [...this.sessions.keys()];
          throw new Error(
            `browser "${instanceId}" is disconnected (${e.message}); connected: ${connected.join(", ") || "none"}${connected.length ? " — use_browser to switch" : ""}`,
          );
        }
        throw e;
      });
  }

  private bridgeFor(instanceId: string): RpcBridge {
    let bridge = this.bridges.get(instanceId);
    if (!bridge) {
      bridge = new RpcBridge((m) => this.sendTo(instanceId, m), config.rpcTimeoutMs);
      this.bridges.set(instanceId, bridge);
    }
    return bridge;
  }

  private sendTo(instanceId: string, msg: ServerMessage): void {
    const s = this.sessions.get(instanceId);
    if (s && s.ready && s.ws.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify(msg));
    }
  }

  /* ----------------------------- connection handling ----------------------------- */

  private handleConnection(ws: WebSocket): void {
    let authed = false;
    let alive = true;
    let session: ExtSession | null = null;

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return; // ignore malformed frames
      }

      // Handshake gate: nothing but `hello` is accepted until authed.
      if (!authed) {
        if (msg.type !== "hello") return;
        session = this.tryHello(ws, msg);
        if (!session) return;
        authed = true;
        return;
      }

      switch (msg.type) {
        case "ready": {
          if (!session) return;
          // ready must match THIS socket's pending handshake — a stale or
          // mismatched ready must never activate a session.
          if (msg.instanceId !== session.target.instanceId || msg.sessionId !== session.sessionId) {
            const code: BrowserErrorCode = "target_mismatch";
            const message = `ready mismatch: expected ${browserLabel(session.target)}/${session.sessionId.slice(0, 8)}, got ${msg.instanceId}/${msg.sessionId.slice(0, 8)}`;
            this.onHandshakeRejected.emit("rejected", { kind: session.target.kind, instanceId: session.target.instanceId, code, message } satisfies HandshakeRejectedEvent);
            this.reject(ws, message);
            return;
          }
          this.activateReady(session);
          break;
        }
        case "pong":
          alive = true;
          break;
        case "rpc_response":
          if (session) this.bridgeFor(session.target.instanceId).resolve(msg);
          break;
        case "event":
          this.events.push({ ...msg.event, browser: session?.target.instanceId });
          break;
      }
    });

    ws.on("close", () => {
      if (session && this.sessions.get(session.target.instanceId)?.ws === ws) {
        this.teardown(session.target.instanceId, "disconnected");
      }
    });
    ws.on("error", () => {
      if (session && this.sessions.get(session.target.instanceId)?.ws === ws) {
        this.teardown(session.target.instanceId, "socket error");
      }
    });

    // Per-connection heartbeat (see ws-server v4 notes — tolerate a few missed
    // pongs before terminating; a single-miss kill caused reconnect churn).
    let missed = 0;
    const hb = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (alive) {
        missed = 0;
      } else if (++missed >= HEARTBEAT_MAX_MISSES) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.send(JSON.stringify({ type: "ping", t: Date.now() } satisfies ServerMessage));
    }, HEARTBEAT_MS);
    ws.on("close", () => clearInterval(hb));
  }

  /** Validate a hello frame and register its pending session. Returns the new
   * pending session, or null after rejecting the socket. */
  private tryHello(ws: WebSocket, msg: ClientMessage & { type: "hello" }): ExtSession | null {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      // Say what to DO, not just what is wrong: the only cause in practice is an
      // extension built before the current checkout, and the fix is always the
      // same two commands. Without them this reads as a mysterious refusal.
      const stale = msg.protocolVersion < PROTOCOL_VERSION;
      const why = `protocol mismatch: server ${PROTOCOL_VERSION}, client ${msg.protocolVersion} — ${
        stale
          ? "the extension is older than this backend. Run `pnpm build`, then reload the extension in the browser."
          : "this backend is older than the extension. Pull/rebuild the backend, or reload an extension built from this checkout."
      }`;
      this.rejectHandshake(msg.browser, undefined, "protocol_incompatible", why);
      this.reject(ws, why);
      return null;
    }
    if (msg.token !== config.token) {
      this.rejectHandshake(msg.browser, undefined, "auth_rejected", "invalid token");
      this.reject(ws, "invalid token");
      return null;
    }
    // v5 identity gate: an extension without a valid instance identity must
    // never enter the connected set (its actions could not be routed).
    if (typeof msg.instanceId !== "string" || !isValidInstanceId(msg.instanceId)) {
      this.rejectHandshake(msg.browser, undefined, "protocol_incompatible", `invalid instanceId ${JSON.stringify(msg.instanceId)} — reinstall the extension (it must carry the backend-issued runtime config)`);
      this.reject(ws, "invalid instanceId");
      return null;
    }
    const target: BrowserTarget = { kind: msg.browser, instanceId: msg.instanceId };
    const session: ExtSession = {
      ws,
      target,
      sessionId: randomUUID(),
      connectedAt: Date.now(),
      ready: false,
      clientName: msg.clientInfo?.name,
      clientVersion: msg.clientInfo?.version,
      artifactHash: msg.clientInfo?.artifactHash,
      protocolVersion: msg.protocolVersion,
    };
    this.adopt(session);
    // Welcome goes DIRECTLY on this socket — sendTo is gated on `ready`, and
    // the welcome is precisely what prompts the ready. Sending through sendTo
    // would deadlock the handshake.
    ws.send(
      JSON.stringify({
        type: "welcome",
        browser: target.kind,
        instanceId: target.instanceId,
        sessionId: session.sessionId,
        protocolVersion: PROTOCOL_VERSION,
        serverVersion: config.serverVersion,
      } satisfies ServerMessage),
    );
    console.log(`[ws] extension hello ok (${browserLabel(target)}, waiting ready)`);
    return session;
  }

  private rejectHandshake(kind: BrowserKind, instanceId: string | undefined, code: BrowserErrorCode, message: string): void {
    this.onHandshakeRejected.emit("rejected", { kind, instanceId, code, message } satisfies HandshakeRejectedEvent);
  }

  /** Register a pending (authed, not-yet-ready) connection under its target.
   * Same instanceId = that browser reconnecting (SW respawn / reload): the
   * previous socket is replaced. Different instanceIds coexist fully isolated. */
  private adopt(session: ExtSession): void {
    const instanceId = session.target.instanceId;
    const prev = this.sessions.get(instanceId);
    if (prev && prev.ws.readyState === WebSocket.OPEN) {
      prev.ws.close(1000, "replaced by new connection");
    }
    this.sessions.set(instanceId, session);
  }

  /** Mark a session connected: hello → welcome → ready complete. */
  private activateReady(session: ExtSession): void {
    const instanceId = session.target.instanceId;
    const current = this.sessions.get(instanceId);
    // A superseded socket's late ready must not activate (its session was
    // replaced by a newer connection).
    if (!current || current !== session || current.ws.readyState !== WebSocket.OPEN) return;
    session.ready = true;
    // A pending offline for this instance = an MV3 SW recycle that reconnected
    // within the debounce window. Cancel it and stay silent.
    const recycling = this.pendingOffline.get(instanceId);
    if (recycling) {
      clearTimeout(recycling);
      this.pendingOffline.delete(instanceId);
    }
    // A genuinely new/returning browser (no pending recycle) is a topology
    // change worth broadcasting.
    if (!recycling) this.pushTopo("browser_online", session.target, `${browserLabel(session.target)} connected`);
    // Sticky default: only claim it when no live default exists.
    const cur = this.defaultTarget ? this.sessions.get(this.defaultTarget.instanceId) : undefined;
    if (!cur || !cur.ready || cur.ws.readyState !== WebSocket.OPEN) {
      if (this.defaultTarget?.instanceId !== instanceId) {
        const from = this.defaultTarget;
        this.defaultTarget = session.target;
        this.pushTopo("target_changed", session.target, `global default target is now ${browserLabel(session.target)}${from ? ` (was ${browserLabel(from)})` : ""}`, { from: from?.instanceId, to: instanceId });
      }
    }
    console.log(`[ws] extension ready (${browserLabel(session.target)}, session ${session.sessionId.slice(0, 8)})`);
    // Re-drive any RPCs that were in flight when this browser's previous socket dropped.
    this.bridgeFor(instanceId).resend();
    // Wake setup waiters.
    const waiters = this.readyWaiters.get(instanceId);
    if (waiters?.length) {
      this.readyWaiters.delete(instanceId);
      for (const w of waiters) w.resolve(session);
    }
  }

  private reject(ws: WebSocket, reason: string): void {
    try {
      ws.send(JSON.stringify({ type: "reject", reason } satisfies ServerMessage));
    } finally {
      // A close reason is capped at 123 BYTES by RFC 6455, and `ws` throws
      // RangeError past it — which would turn "reject this connection" into an
      // uncaught server exception. Truncated here rather than at the call sites
      // so a longer, more helpful reason can never take the server down; the
      // full text already went out in the `reject` frame above.
      ws.close(1008, closeReasonOf(reason));
    }
    console.warn(`[ws] rejected connection: ${reason}`);
  }

  private teardown(instanceId: string, reason: string): void {
    const session = this.sessions.get(instanceId);
    const target = session?.target;
    console.warn(`[ws] ${target ? browserLabel(target) : instanceId} ${reason}`);
    // Keep the persistent bridge and its pending RPCs (SW respawn).
    this.sessions.delete(instanceId);
    // Debounce browser_offline (MV3 SW recycle) — only broadcast if it HASN'T
    // come back within the debounce window (adopt cancels on reconnect).
    if (target && !this.pendingOffline.has(instanceId)) {
      const t = setTimeout(() => {
        this.pendingOffline.delete(instanceId);
        if (!this.sessions.has(instanceId)) this.pushTopo("browser_offline", target, `${browserLabel(target)} disconnected (${reason})`);
      }, WsServer.OFFLINE_DEBOUNCE_MS);
      if (typeof t === "object" && "unref" in t) t.unref();
      this.pendingOffline.set(instanceId, t);
    }
    // Fail over the default target to another live ready browser when one
    // exists; otherwise keep pointing at the dropped instance so a quick
    // reconnect (SW respawn) resumes seamlessly.
    if (process.env.BCP_DESKTOP !== '1' && this.defaultTarget?.instanceId === instanceId) {
      const remaining = [...this.sessions.values()].sort((a, b) => b.connectedAt - a.connectedAt).find((s) => s.ready && s.ws.readyState === WebSocket.OPEN);
      if (remaining) {
        this.defaultTarget = remaining.target;
        console.log(`[ws] tool target failed over to ${browserLabel(remaining.target)}`);
        this.pushTopo("target_changed", remaining.target, `global default target failed over from ${browserLabel(target!)} to ${browserLabel(remaining.target)}`, { from: instanceId, to: remaining.target.instanceId });
      }
    }
    // Fail pending waiters? NO — waiters wait for a ready that may still come
    // on a reconnect; they are bounded by their own timeout.
  }
}
