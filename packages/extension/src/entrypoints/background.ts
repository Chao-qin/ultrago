/**
 * Service worker — the WS client and RPC dispatcher (pure browser executor).
 *
 *   backend  <== WebSocket ==>  [service worker]  <== chrome.tabs/scripting ==>  page
 *                                     |
 *                                     +== chrome.runtime ==>  sidepanel (status + settings)
 *
 * Auto-connects with handshake, reconnects with backoff, answers heartbeats, and
 * turns backend RPC requests into official extension-API actions. There is no
 * agent here: the agent lives in whatever MCP client drives the backend's /mcp
 * endpoint. The side panel is only a connection-status + settings surface.
 */
import {
  PROTOCOL_VERSION,
  RpcMethod,
  DOM_OP,
  RPC_TRAITS,
  UNSAFE_TO_REPEAT_METHODS,
  EVAL_TIMEOUT_MS,
  EVAL_SAFE_BUDGET_MS,
  type BrowserEvent,
  type BrowserKind,
  type ExtensionRuntimeConfig,
  type NetworkRequest,
  type RpcContracts,
  type RpcErrorInfo,
  type ServerMessage,
  type ClientMessage,
} from "@bcp/shared";
import {
  DEFAULT_SETTINGS,
  type ConnState,
  type ExecResponse,
  type Settings,
  type SwToUi,
  type UiToSw,
} from "../messaging";
import { createNetIdleTracker } from "../net-idle";
import { openWindow, type WindowApi } from "../window-ops";
import { createNav, type NavDeps } from "../nav-wait";
import { createWsLink, type SocketLike } from "../ws-link";
import { createInjectDispatch, type InjectDeps } from "../inject-dispatch";
import { createNetLog } from "../net-log";
import { createPersistedTabSet } from "../persisted-tab-set";
import { domOpError, errorInfoOf } from "../rpc-errors";
import { ensureLocalInstanceId, loadRuntimeConfig } from "../runtime-config";
import { createRpcDeduper } from "../rpc-dedup";
import { bcpDomRuntime, bcpOverlay, bcpDialogShim, bcpDialogRestore, bcpEventProbes, bcpMainConsoleProbe, bcpNetworkPatch, bcpSignalWait, bcpWaitFactory, bcpDomHelpersFactory, bcpReadOnlyGuard } from "../content/dom-runtime";
import { compressScreenshot } from '../screenshot-compression';
import { installNavigationInvalidation } from '../navigation-events';
import { DESKTOP_NATIVE_HOST, desktopConnection, reloadForDesktop } from '../desktop-discovery';
import { captureWindow } from '../capture-retry';

// The MV3 background lives entirely inside defineBackground(main): at build
// time WXT only reads this module's default export (main is NOT invoked), so
// nothing here touches browser globals in Node. main() runs only at runtime.
export default defineBackground(() => {
  // Firefox exposes promise-based `browser`; Chrome MV3 exposes promise-based
  // `chrome` (no `browser` global). Bind whichever exists so every call below
  // is promise-based on both. @types/chrome types both identically.
  const cx: typeof chrome = ((globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome);
  // The toolbar button is `action` on MV3 (Chrome) but `browserAction` on MV2
  // (Firefox's default target) — the badge calls below must reach whichever exists.
  const action = cx.action ?? cx.browserAction;

  let settings: Settings = DEFAULT_SETTINGS;

  /* ------------------------- instance identity ------------------------- */

  /** Backend-generated runtime config (injected at artifact build). Absent in
   * dev / when the user loads the raw build — fall back to a self-generated
   * persistent instanceId so the protocol still works. */
  let runtimeConfig: ExtensionRuntimeConfig | null = null;
  let instanceId = "";
  let artifactHash: string | undefined;
  let desktopPaired = false;
  let discoveringDesktop: Promise<void> | null = null;

  function refreshDesktopSettings(): Promise<void> {
    if (import.meta.env.BROWSER !== 'chrome') return Promise.resolve();
    if (discoveringDesktop) return discoveringDesktop;
    discoveringDesktop = (async () => {
      try {
        const reply = await cx.runtime.sendNativeMessage(DESKTOP_NATIVE_HOST, { type: 'discover' });
        const connection = desktopConnection(reply);
        if (!connection) throw new Error('desktop is not ready');
        desktopPaired = true;
        await cx.storage.local.set({ bcpDesktopPaired: true });
        if (await reloadForDesktop(connection.extensionVersion, cx.runtime.getManifest().version, cx.storage.local, () => {
          console.log(`[bcp] desktop ships extension ${connection.extensionVersion}; reloading from disk`);
          cx.runtime.reload();
        })) return;
        const changed = settings.backendUrl !== connection.backendUrl || settings.token !== connection.token;
        settings = { ...settings, backendUrl: connection.backendUrl, token: connection.token };
        if (changed && instanceId) link.reset();
      } catch {
        if (desktopPaired) settings = { ...settings, backendUrl: '', token: '' };
      }
    })().finally(() => { discoveringDesktop = null; });
    return discoveringDesktop;
  }

  const identity = {
    getURL: (path: string) => cx.runtime.getURL(path),
    fetch: (url: string) => fetch(url),
    store: cx.storage.local,
  };

  /**
   * Recent XHR/fetch per tab, so read_network can confirm a save/submit actually
   * hit the server (status 2xx) instead of the agent guessing from the UI. Only
   * metadata — response bodies need CDP, which this extension deliberately avoids.
   * In-memory ring buffer: resets when the SW is recycled (learn 2026-07-21).
   */
  const netLog = createNetLog();
  /** Tabs with fetch/XHR body capture on. The MAIN patch dies with the
   *  document, so it is re-armed on navigation. */
  const captureTabs = createPersistedTabSet("captureTabs", cx.storage.session);
  /** Tabs this extension has driven. Probes are re-installed on each of their
   *  loads so a tab the agent is NOT looking at can still report a challenge.
   *  Deliberately not every tab in the browser: this runs next to the user's
   *  own tabs, and a resident observer does not belong in pages nobody asked
   *  us to drive. */
  const watchedTabs = createPersistedTabSet("watchedTabs", cx.storage.session);
  cx.webRequest.onCompleted.addListener(
    (d) => {
      netLog.push(d.tabId, { method: d.method, url: d.url, status: d.statusCode, type: d.type, ts: d.timeStamp, ok: d.statusCode < 400 });
      // A 4xx/5xx XHR is a failure the agent should learn about without polling.
      if (d.statusCode >= 400 && d.tabId >= 0) {
        emitEvent({
          kind: "network_failed", tabId: d.tabId, ts: Date.now(),
          summary: `${d.statusCode} ${d.method} ${d.url}`,
          detail: { url: d.url, method: d.method, status: d.statusCode },
        });
      }
    },
    { urls: ["<all_urls>"], types: ["xmlhttprequest"] },
  );
  cx.webRequest.onErrorOccurred.addListener(
    (d) => {
      netLog.push(d.tabId, { method: d.method, url: d.url, type: d.type, ts: d.timeStamp, ok: false });
      if (d.tabId >= 0) {
        emitEvent({
          kind: "network_failed", tabId: d.tabId, ts: Date.now(),
          summary: `✗ ${d.method} ${d.url} (${d.error})`,
          detail: { url: d.url, method: d.method, error: d.error },
        });
      }
    },
    { urls: ["<all_urls>"], types: ["xmlhttprequest"] },
  );
  /** HTTP-layer evidence about each tab's CURRENT top document, handed to the
   *  challenge detector when probes are installed. A page cannot see its own
   *  status code or response headers, so without this the detector can only
   *  judge a risk-control interstitial by how it LOOKS — which is how an
   *  ordinary /verify/ page used to be convicted of intercepting an action.
   *
   *  In-memory and per-document by nature: replaced on the next main_frame
   *  response, read once a moment later. A recycled SW loses it and detection
   *  falls back to DOM signals alone (learn.md 2026-07-21 — continuity lives in
   *  persistence, and this deliberately has none because a stale status is
   *  worse than no status). */
  const navEvidence = new Map<number, { status?: number; cfChallenge?: boolean }>();
  cx.webRequest.onCompleted.addListener(
    (d) => {
      // `cf-mitigated: challenge` is Cloudflare declaring the response IS an
      // interstitial. Unlike every DOM heuristic in the detector, it is not an
      // inference and cannot be a false positive — so it convicts on its own.
      const cf = d.responseHeaders?.find((h) => h.name.toLowerCase() === "cf-mitigated");
      navEvidence.set(d.tabId, {
        status: d.statusCode,
        cfChallenge: cf?.value?.toLowerCase() === "challenge" || undefined,
      });
    },
    { urls: ["<all_urls>"], types: ["main_frame"] },
    ["responseHeaders"],
  );

  // ---- Network idle -------------------------------------------------------
  // Playwright synthesizes `networkidle` from its own in-flight set (zero in
  // flight for 500ms) and has NO DOM-mutation readiness heuristic anywhere.
  // That distinction matters: an SPA that renders a skeleton mutates nothing
  // while its XHR is in flight, so a quiet DOM reports "ready" while the data
  // is still on the wire — which is exactly the failure recorded in
  // .agent/learn.md 2026-07-21. settleDom remains, but as the FALLBACK for when
  // this view is not trustworthy.
  // Readiness's PRIMARY signal. The bookkeeping lives in net-idle.ts so it can
  // be tested without a browser; the listeners stay here because MV3 requires
  // them registered on the synchronous startup path.
  const netIdle = createNetIdleTracker();

  cx.webRequest.onBeforeRequest.addListener(
    (d) => netIdle.onRequestStart({ tabId: d.tabId, requestId: d.requestId, type: d.type, url: d.url }),
    { urls: ["<all_urls>"] },
  );
  const netDone = (d: { tabId: number; requestId: string }): void => netIdle.onRequestDone(d);
  cx.webRequest.onCompleted.addListener(netDone, { urls: ["<all_urls>"] });
  cx.webRequest.onErrorOccurred.addListener(netDone, { urls: ["<all_urls>"] });

  const waitNetworkIdle = (tabId: number, timeoutMs?: number): Promise<void> =>
    netIdle.waitIdle(tabId, timeoutMs);

  cx.tabs.onRemoved.addListener((tabId) => {
    netLog.forget(tabId);
    navEvidence.delete(tabId);
    void watchedTabs.remove(tabId);
    void captureTabs.remove(tabId);
    // Tell the backend the tab is gone. Every OTHER signal that would retire
    // per-tab state (navigation, captcha_cleared) originates from the page that
    // just stopped existing, so without this a tab closed while blocked is
    // asserted as blocked for the life of the process.
    emitEvent({ kind: "tab_closed", tabId, ts: Date.now(), summary: `tab ${tabId} closed` });
    netIdle.onTabRemoved(tabId);
  });

  installNavigationInvalidation(cx.webNavigation, emitEvent);

  // Page navigations (full loads + redirects) → push as events so the agent
  // learns a page changed under it without a fresh snapshot.
  cx.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status === "complete" && tab.url && /^https?:/.test(tab.url)) {
      emitEvent({
        kind: "navigation",
        tabId,
        ts: Date.now(),
        summary: `navigated → ${tab.url}`,
        detail: { url: tab.url, title: tab.title ?? "" },
      });
      // Re-arm body capture: the MAIN patch died with the old document. Hydrate
      // first — after a worker recycle the in-memory set is empty and this is
      // the exact moment the re-arm would be skipped forever.
      void captureTabs.hydrate().then(() => {
        if (captureTabs.has(tabId)) void injectNetworkPatch(tabId);
      });
      // Re-install the resident probes for the same reason: they died with the
      // document. This is what makes challenge detection independent of the
      // agent's attention — the tab reports being blocked whether or not
      // anybody is about to snapshot it.
      void watchedTabs.hydrate().then(() => {
        if (watchedTabs.has(tabId)) void injectEventProbes(tabId);
      });
    }
  });

  // 后台节流垫片的重装点。刻意【不】挂在上面那个 onUpdated(complete) 上：那是页面
  // 跑完之后，而垫片必须赶在业务 bundle 之前才能接管它注册的定时器。onCommitted 是
  // 动态注入能拿到的最早时机。
  //
  // 只认主框架（frameId 0）：子框架各自有自己的定时器，但书里的等待都发生在主框架，
  // 给每个 iframe 都装一份 worker + WebRTC 是白付成本。
  //
  // 与 captureTabs / watchedTabs 同样的理由先 hydrate：worker 一次回收就会把内存里
  // 的集合清空，而这正是「navigation 之后再也不重装」的那一刻。
  cx.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    void watchedTabs.hydrate().then(() => {
      if (watchedTabs.has(details.tabId)) void injectKeepAwake(details.tabId);
    });
  });

  // Window lifecycle → topology events, so agents can wait for / be notified of
  // a window opening or closing (multi-window coordination).
  cx.windows.onCreated.addListener((w) => {
    emitEvent({ kind: "window_opened", tabId: -1, ts: Date.now(), summary: `window ${w.id} opened`, detail: { windowId: w.id } });
  });
  cx.windows.onRemoved.addListener((windowId) => {
    emitEvent({ kind: "window_closed", tabId: -1, ts: Date.now(), summary: `window ${windowId} closed`, detail: { windowId } });
  });

  /** Transport + backoff live in ws-link.ts, asserted there against a fake
   *  socket. Protocol meaning (hello / welcome / rpc) stays here. */
  const link = createWsLink({
    url: () => settings.backendUrl,
    open: (url) => new WebSocket(url) as unknown as SocketLike,
    onOpen: () =>
      send({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        role: "extension",
        token: settings.token,
        clientInfo: {
          name: "ultrago-ext",
          version: cx.runtime.getManifest().version,
          ...(artifactHash ? { artifactHash } : {}),
        },
        // Compile-time WXT constant ("chrome" / "firefox"): the backend keys
        // extension sessions by (kind, instanceId) so several instances — even
        // of the same kind — coexist fully isolated.
        browser: import.meta.env.BROWSER as BrowserKind,
        instanceId,
      }),
    onMessage: (msg) => void handleServer(msg as ServerMessage),
    onState: (next) => {
      setConn(next);
      if (next === 'disconnected') void refreshDesktopSettings();
    },
  });
  const connect = (): void => link.connect();

  function toUi(msg: SwToUi): void {
    cx.runtime.sendMessage(msg).catch(() => {
      /* sidepanel closed — fine */
    });
  }
  function setConn(next: ConnState): void {
    toUi({ kind: "conn", conn: next });
    // Toolbar badge: green ON = WS live, yellow … = connecting, red OFF = down.
    const badge: Record<ConnState, { text: string; color: string }> = {
      connected: { text: "✓", color: "#16a34a" },
      connecting: { text: "…", color: "#f59e0b" },
      disconnected: { text: "OFF", color: "#dc2626" },
    };
    void action?.setBadgeText({ text: badge[next].text });
    void action?.setBadgeBackgroundColor({ color: badge[next].color });
    void action?.setTitle({ title: `UltraGo · Chrome ${next === 'connected' ? '已连接到客户端（不代表 AI 助手连接）' : next === 'connecting' ? '正在连接客户端' : '未连接到客户端'}` });
  }

  function send(msg: ClientMessage): void {
    link.send(msg);
  }

  /** Push an unsolicited page event to the backend (fire-and-forget; silently
   * dropped if the socket is down — the backend only tracks events while live). */
  function emitEvent(event: BrowserEvent): void {
    send({ type: "event", event });
  }

  async function handleServer(msg: ServerMessage): Promise<void> {
    switch (msg.type) {
      case "welcome":
        link.handshakeComplete();
        // v5: the backend only treats this session as connected after the
        // `ready` ack. Send it once, matching the welcome's target + session.
        send({ type: "ready", instanceId: msg.instanceId, sessionId: msg.sessionId });
        break;
      case "reject":
        console.warn("[bcp] handshake rejected:", msg.reason);
        break;
      case "ping":
        send({ type: "pong", t: msg.t });
        break;
      case "rpc_request": {
        const res = await runRpcOnce(msg.id, msg.method, msg.params);
        send(res.ok
          ? { type: "rpc_response", id: msg.id, ok: true, result: res.result }
          : { type: "rpc_response", id: msg.id, ok: false, error: res.error, errorInfo: res.errorInfo });
        break;
      }
    }
  }

  /* ------------------------- RPC dispatch ------------------------- */

  /** Stop state. `stoppedUntil` rejects NEW actions; `stopEpoch` lets us discard
   * the result of an action that was already in-flight when the user hit Stop. */
  let stoppedUntil = 0;
  let stopEpoch = 0;
  let statusToken = 0;
  /** Every tab that currently shows the overlay (multi-tab tasks + reliable hide). */
  const overlayTabs = new Set<number>();
  let statusIdleTimer: ReturnType<typeof setTimeout> | null = null;

  async function injectOverlay(tabId: number, show: boolean): Promise<void> {
    try {
      await cx.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: bcpOverlay, args: [show] });
    } catch {
      /* non-scriptable tab (chrome://) — ignore */
    }
  }

  /** Install resident page-event probes (dom_changed/dialog via ISOLATED
   * MutationObserver; console errors via a MAIN probe bridged to ISOLATED)
   * alongside a snapshot. Idempotent per frame; re-installed on the next snapshot
   * after navigation clears them. Fire-and-forget — a non-scriptable frame is ignored. */
  async function injectEventProbes(tabId: number): Promise<void> {
    try {
      await cx.scripting.executeScript({
        target: { tabId, allFrames: true }, world: "ISOLATED", func: bcpEventProbes,
        // Every frame gets the TOP document's evidence; only the top frame reads
        // it (the detector gates that on `window === window.top`). Passing it per
        // frame instead would mean a second webRequest bookkeeping layer for
        // subframes that have no page-level verdict to reach.
        args: [navEvidence.get(tabId) ?? {}],
      });
      await cx.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func: bcpMainConsoleProbe });
      await watchedTabs.add(tabId);
    } catch {
      /* non-scriptable frame — ignore */
    }
  }

  /** 后台节流绕行垫片（public/keep-awake.js）。
   *
   * 【为什么必须有】Chrome 对【完全被遮挡】的窗口和非活动 tab 判 hidden，随后把
   * 定时器节流到约 1 次/分钟（隐藏满 5 分钟起）。而本扩展刻意用 focused:false +
   * restoreFocus 把任务窗口放到用户窗口【后面】——用户的窗口一旦是最大化的，任务
   * 窗口就 100% 被盖住。2026-09-07 实测：同一个 tab、同一段代码，仅可见性不同：
   *   hidden  → 13 次 setTimeout（应 860ms）90 秒跑不完
   *   visible → 914ms
   * 于是书里每个 sleep(50) 实际等约 60 秒，症状是「eval timed out」，与真因隔着
   * 整条链路。垫片把 setInterval/setTimeout 改道到 Worker（worker 不受节流）。
   *
   * 【为什么是 MAIN world】要劫持的是【页面自己】的 setTimeout。装在 ISOLATED 里
   * 只会改到扩展自己那份，页面代码毫发无损——那等于什么都没做，且不会报错。
   *
   * 【为什么是 onCommitted 而不是既有的 onUpdated(complete)】垫片必须赶在业务
   * bundle 之前：它自己的说明写着「注入前就已在跑的原生 interval 接管不了」。
   * complete 时页面早跑完了。onCommitted + injectImmediately 是动态注入能拿到的
   * 最早时机——【诚实标注】它仍不等于声明式 content script 的 document_start，
   * 文档 <head> 里内联脚本抢先注册的定时器接管不到。
   *
   * 【为什么只给 watchedTabs】沿用该集合原有的口径：这是用户的真实浏览器，
   * 「a resident observer does not belong in pages nobody asked us to drive」。
   * 垫片会劫持定时器、开 WebRTC loopback，更不该出现在用户自己浏览的页面里。
   *
   * 幂等：垫片用 Symbol.for('ka.hijacked') 自认领，重复注入直接返回既有句柄。 */
  async function injectKeepAwake(tabId: number): Promise<void> {
    try {
      await cx.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: "MAIN",
        injectImmediately: true,
        files: ["keep-awake.js"],
      });
    } catch {
      /* 非可注入页面（chrome://、扩展页、严格 CSP）——忽略。垫片本身在 worker
         建不起来时也会自行退化为原生定时器，不会把页面弄坏。 */
    }
  }

  /** Enable body capture on a tab: ensure the ISOLATED bridge is present (it
   * relays the MAIN patch's postMessages even if no snapshot ran yet), then arm
   * the MAIN fetch/XHR patch. */
  /** Returns how many frames actually got the MAIN-world patch. Swallowing the
   *  failure and reporting "capture ON" regardless is how a chrome:// or
   *  otherwise non-scriptable page ends up with the agent waiting forever for
   *  bodies that can never arrive. */
  async function injectNetworkPatch(tabId: number): Promise<number> {
    try {
      // Same probe install as injectEventProbes, `nav` argument included.
      await cx.scripting.executeScript({
        target: { tabId, allFrames: true }, world: "ISOLATED", func: bcpEventProbes,
        args: [navEvidence.get(tabId) ?? {}],
      });
      const armed = await cx.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func: bcpNetworkPatch });
      return armed.length;
    } catch {
      /* non-scriptable frame — report zero rather than a silent success */
      return 0;
    }
  }

  /** Disable capture without un-patching: flip the MAIN-world flag so the patch
   * stays installed but stops reporting. */
  async function setNetworkCaptureFlag(tabId: number, on: boolean): Promise<void> {
    try {
      await cx.scripting.executeScript({
        target: { tabId, allFrames: true }, world: "MAIN",
        func: (v: boolean) => { (window as unknown as { __bcpNetOn?: boolean }).__bcpNetOn = v; },
        args: [on],
      });
    } catch {
      /* ignore */
    }
  }

  /** Show/hide the in-page overlay. The overlay follows an explicitly targeted task
   * tab: showing on a new tab first hides it everywhere else. A monotonic token
   * makes a later state supersede an earlier one even across async injections. */
  async function setContentStatus(active: boolean, tabId?: number): Promise<void> {
    const my = ++statusToken;
    if (!active) {
      for (const t of [...overlayTabs]) {
        await injectOverlay(t, false);
        overlayTabs.delete(t);
      }
      return;
    }
    // Global RPCs (new window, list tabs, downloads) have no page target. Falling
    // back to the focused tab makes their status badge appear on an unrelated page.
    if (tabId == null) return;
    const targetId = tabId;
    if (my !== statusToken) return; // superseded while resolving the tab
    for (const t of [...overlayTabs]) {
      if (t !== targetId) {
        await injectOverlay(t, false);
        overlayTabs.delete(t);
      }
    }
    if (my !== statusToken) return; // superseded while hiding others
    await injectOverlay(targetId, true);
    if (my !== statusToken) {
      void injectOverlay(targetId, false); // a newer state won — undo this show
      return;
    }
    overlayTabs.add(targetId);
  }
  function markActive(tabId?: number): void {
    if (Date.now() < stoppedUntil) return; // don't flash the overlay back during a stop
    if (tabId == null) return;
    void setContentStatus(true, tabId);
    if (statusIdleTimer) clearTimeout(statusIdleTimer);
    statusIdleTimer = setTimeout(() => void setContentStatus(false), 4000);
  }

  /** Stop: reject new actions for a window, invalidate in-flight, hide overlay. */
  function stopAutomation(): void {
    stopEpoch++;
    stoppedUntil = Date.now() + 4000;
    if (statusIdleTimer) clearTimeout(statusIdleTimer);
    void setContentStatus(false);
  }

  /**
   * The structured half of a failure, when there is one.
   *
   * `bcpDomRuntime` is serialised into the page and cannot import anything, so
   * it tags locator failures with plain string properties; this is where they
   * re-enter typed code. Anything untagged — an RPC timeout, a vanished tab, a
   * page that navigated mid-action — yields undefined, and the backend then
   * treats the failure as unrecoverable. That default is deliberate: mistaking
   * a disconnected browser for a stale selector would send it into repair.
   */

  async function dispatchRpc(method: RpcMethod, params: unknown): Promise<ExecResponse> {
    if (Date.now() < stoppedUntil) {
      return { ok: false, error: "automation stopped by user" };
    }
    const epoch = stopEpoch;
    // `restoringView` switches hand the view BACK to the user (the screenshot
    // lease's final hop). Badging that tab would mark a page nothing was done
    // to as "being automated", and it would sit there for the 4s idle timer.
    const marked = params as { tabId?: number; restoringView?: boolean };
    if (!marked.restoringView) markActive(marked.tabId);
    try {
      const result = await runRpc(method, params);
      // If the user hit Stop while this action was in-flight, discard its result.
      if (stopEpoch !== epoch) return { ok: false, error: "automation stopped by user" };
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), errorInfo: errorInfoOf(e) };
    }
  }

  /** Dedup executed RPCs by id. The backend re-sends still-pending RPCs on every
   * reconnect (at-least-once delivery), so without this a mutating action
   * (click/navigate/submit) whose response was lost in a socket drop would run
   * TWICE. Return the same in-flight/settled result for a repeated id; bounded FIFO. */
  const RPC_DEDUP_CAP = 256;

  /** Methods whose double-execution has a real side effect (a second click/submit/
   * navigate). Only these need cross-recycle dedup: re-running a read (snapshot/
   * screenshot) is harmless, so we don't persist those. */
  const MUTATING = new Set<RpcMethod>(UNSAFE_TO_REPEAT_METHODS);

  /** Dedup mechanism lives in rpc-dedup.ts so it can be tested without a
   *  browser; the MUTATING policy above stays here, next to the RPC surface it
   *  describes. */
  const deduper = createRpcDeduper({
    store: cx.storage.session,
    dispatch: dispatchRpc,
    isMutating: (m) => MUTATING.has(m),
    cap: RPC_DEDUP_CAP,
  });
  const runRpcOnce = (id: string, method: RpcMethod, params: unknown): Promise<ExecResponse> =>
    deduper.runOnce(id, method, params);

  async function getActiveTab(): Promise<chrome.tabs.Tab> {
    const [tab] = await cx.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error("no active tab in the focused window");
    return tab;
  }

  /** Resolve an explicit tabId (a task's pinned tab) or fall back to the active tab. */
  async function resolveTab(tabId?: number): Promise<chrome.tabs.Tab> {
    return tabId != null ? cx.tabs.get(tabId) : getActiveTab();
  }



  /**
   * Run a DOM operation by INJECTING a self-contained runtime function on demand
   * (chrome.scripting, ISOLATED world). No dependency on a persistent content
   * script, so it works on pre-existing tabs, after an extension reload, and on
   * pages the declarative content script never attached to. The snapshot ref map
   * lives on the isolated-world global — invisible to the page, persistent per frame.
   */

  /** Resolve once the tab reports `complete`, or on timeout. Unlike
   *  navigateAndWait this does not initiate anything — it only waits. */
  const NAV_BARRIER_TIMEOUT_MS = 15000;
  /** Orderings and their rationale live in nav-wait.ts, where they are asserted
   *  against fake tabs/webNavigation instead of a real browser. */
  const { waitTabComplete, liveFrames, historyNav, navigateAndWait } = createNav({
    tabs: cx.tabs as unknown as NavDeps["tabs"],
    webNavigation: cx.webNavigation as unknown as NavDeps["webNavigation"],
    markWatched: (t) => void watchedTabs.add(t),
  });

  /** The barrier's reasoning lives in inject-dispatch.ts, asserted there against
   *  fake scripting/webNavigation. Declared AFTER createNav because it captures
   *  waitTabComplete / liveFrames, which are consts and do not hoist. */
  const viaInject = createInjectDispatch({
    scripting: cx.scripting as unknown as InjectDeps["scripting"],
    webNavigation: cx.webNavigation as unknown as InjectDeps["webNavigation"],
    tabs: cx.tabs as unknown as InjectDeps["tabs"],
    tabCreated: cx.tabs.onCreated as unknown as InjectDeps["tabCreated"],
    resolveTab,
    waitNetworkIdle,
    openRequests: (t) => netIdle.openRequests(t),
    waitTabComplete,
    liveFrames,
    injectEventProbes: (t) => void injectEventProbes(t),
    isMutating: (m) => MUTATING.has(m),
    runtime: { dom: bcpDomRuntime, dialogShim: bcpDialogShim, dialogRestore: bcpDialogRestore },
    domOp: DOM_OP,
    barrierMs: NAV_BARRIER_TIMEOUT_MS,
  });

  async function runRpc(method: RpcMethod, params: unknown): Promise<unknown> {
    // Every in-page RPC runs through the one injection pipeline; which ones are in-page is RPC_TRAITS's to say. A
    // hand-kept case list here missed right_click and double_click, so both tools failed outright.
    if (RPC_TRAITS[method].domOp) return viaInject(method, params);
    switch (method) {
      case RpcMethod.Navigate: {
        const { url, tabId } = params as RpcContracts[typeof RpcMethod.Navigate]["params"];
        const id = tabId ?? (await getActiveTab()).id!;
        return navigateAndWait(id, url);
      }
      case RpcMethod.NewWindow:
        // Rules and their rationale live in window-ops.ts, where they are tested
        // against a fake windows API instead of a real desktop.
        return openWindow(
          { windows: cx.windows as unknown as WindowApi, markWatched: (t) => watchedTabs.add(t) },
          params as RpcContracts[typeof RpcMethod.NewWindow]["params"],
        );
      case RpcMethod.CloseWindow: {
        const { windowId } = params as RpcContracts[typeof RpcMethod.CloseWindow]["params"];
        const id = windowId ?? (await getActiveTab()).windowId;
        await cx.windows.remove(id);
        return { closed: true, windowId: id };
      }
      case RpcMethod.SetWindowState: {
        const { tabId, minimized } = params as RpcContracts[typeof RpcMethod.SetWindowState]["params"];
        const id = tabId ?? (await getActiveTab()).id!;
        const tab = await cx.tabs.get(id);
        const updated = await cx.windows.update(tab.windowId, { state: minimized ? "minimized" : "normal" });
        return { windowId: tab.windowId, state: updated.state ?? (minimized ? "minimized" : "normal") };
      }
      case RpcMethod.NewTab: {
        const { url, active } = params as RpcContracts[typeof RpcMethod.NewTab]["params"];
        const tab = await cx.tabs.create({ url, active: active === true });
        // Same honesty as newWindow above, mirrored: `tab.id!` asserted an id
        // that Chrome types as optional, and an undefined one slips past the
        // run tracker's `typeof === "number"` guard without being recorded —
        // so the tab exists, nothing owns it, and the terminal sweep never
        // closes it. An untrackable tab is a failed newTab.
        if (tab.id == null) throw new Error("newTab: Chrome returned a tab with no id, so the run cannot track or close it");
        // 我们开的 tab 立刻纳入 watchedTabs：keep-awake 垫片的重装点认这个集合，
        // 而登记必须发生在【第一次导航之前】。等到某个动作第一次驱动它才 markWatched
        // 的话，第一次加载就漏掉了 —— 而任务窗口恰恰从第一次加载起就被盖住。
        await watchedTabs.add(tab.id);
        // create() resolves before navigation — prefer the requested url.
        return { tabId: tab.id, url: url ?? tab.url ?? "" };
      }
      case RpcMethod.CloseTab: {
        const { tabId } = params as RpcContracts[typeof RpcMethod.CloseTab]["params"];
        const id = tabId ?? (await getActiveTab()).id!;
        await cx.tabs.remove(id);
        return { closed: true, tabId: id };
      }
      case RpcMethod.Eval: {
        const { code, tabId, frameId, readOnly } = params as RpcContracts[typeof RpcMethod.Eval]["params"];
        // MAIN world (page context) is the ONLY place this can run: an MV3 extension's
        // own CSP forbids new Function / eval in the isolated world, so there is no
        // page-isolated fallback for arbitrary code. Pure chrome.scripting, no CDP.
        // async cap; a strict page CSP or a sync infinite loop can't be caught
        // here. Shared with the backend so the transport ceiling can be derived
        // from it and can never be configured below it.
        const EVAL_MAX_LEN = 200_000; // serialized-result size cap (chars) before truncation
        const tab = await resolveTab(tabId);
        const [res] = await cx.scripting.executeScript({
          target: frameId != null ? { tabId: tab.id!, frameIds: [frameId] } : { tabId: tab.id! },
          world: "MAIN",
          func: async (src: string, timeoutMs: number, maxLen: number, budgetMs: number, waitFactorySrc: string, domFactorySrc: string, readOnlyGuardSrc: string | null) => {
            // Absolute deadline handed to the evaluated code as `bcpDeadline`, so a
            // book expresses "run until you are nearly out of time" without ever
            // restating a millisecond budget of its own.
            const bcpDeadline = Date.now() + budgetMs;
            // `bcpWait` comes from bcpWaitFactory in dom-runtime (injected as source
            // below), so the helpers a book calls are the SAME code `pnpm check:dom`
            // exercises in a real browser — not a copy that can drift from it.
            let bcpWait: unknown;
            try {
              bcpWait = (new Function(`return (${waitFactorySrc})`)() as (d: number) => unknown)(bcpDeadline);
            } catch {
              bcpWait = undefined; // a page CSP that blocks Function() also blocks eval itself
            }
            // `bcpDom` comes from bcpDomHelpersFactory the same way — one source,
            // exercised by check:dom, instead of the 81 hand-copied `vis`/`press`
            // definitions that had drifted into five inconsistent answers for
            // "is this element visible".
            let bcpDom: unknown;
            try {
              bcpDom = (new Function(`return (${domFactorySrc})`)() as (d: number) => unknown)(bcpDeadline);
            } catch {
              bcpDom = undefined;
            }
            const exec = (async () => {
              // Compile forms tried in order. Expression before statement block:
              // the expression form preserves the implicit return of a bare last
              // expression (e.g. `document.title`), like the old completion value.
              // Most params before fewest: injecting `bcpDeadline`/`bcpWait` is what
              // lets a book express "run until nearly out of time" and "wait until
              // the page reacted" with no literals — but code that declares its OWN
              // binding of either name would be a duplicate declaration
              // (SyntaxError), so those forms fall back to a smaller param set
              // rather than surfacing as a generic failure.
              const bodies = [`"use strict"; return (${src});`, `"use strict"; ${src}`];
              // One name dropped per step, most-injected first. A book that
              // declares its OWN `bcpDom` (the hand-copied helpers are still
              // out there, and a local `const bcpDom` would be a duplicate
              // declaration → SyntaxError) falls back to the set without it
              // rather than failing outright.
              const paramSets = [
                ["bcpDeadline", "bcpWait", "bcpDom"],
                ["bcpDeadline", "bcpWait"],
                ["bcpDeadline"],
                [],
              ];
              let fn: ((...a: unknown[]) => unknown) | undefined;
              let args: unknown[] = [];
              let lastErr: unknown;
              for (const names of paramSets) {
                for (const body of bodies) {
                  try {
                    fn = new Function(...names, body) as (...a: unknown[]) => unknown;
                    args = names.map((n) =>
                      n === "bcpDeadline" ? bcpDeadline : n === "bcpWait" ? bcpWait : bcpDom,
                    );
                    break;
                  } catch (e) {
                    lastErr = e;
                  }
                }
                if (fn) break;
              }
              if (!fn) throw lastErr;
              // A read-only evaluation (a plan's evalCheck) runs synchronously
              // inside bcpReadOnlyGuard, which refuses every page effect and
              // any Promise result; everything else may act and is awaited.
              if (readOnlyGuardSrc != null) {
                const runReadOnly = (new Function(`return (${readOnlyGuardSrc})`)() as () => (f: () => unknown, source: string) => unknown)();
                return runReadOnly(() => fn!(...args), src);
              }
              let v: unknown = fn(...args);
              if (v && typeof (v as { then?: unknown }).then === "function") v = await v; // await promises
              return v;
            })();
            const timeout = new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error(`eval timed out after ${timeoutMs}ms`)), timeoutMs),
            );
            try {
              const v = await Promise.race([exec, timeout]);
              if (v === undefined) return { ok: true, value: null };
              // Safe stringify: tolerate cycles / BigInt / DOM nodes / functions
              // instead of throwing (plain JSON.stringify turned those into a
              // misleading "eval failed").
              const seen = new WeakSet<object>();
              let s = JSON.stringify(v, (_k, val) => {
                if (typeof val === "bigint") return `${val}n`;
                if (val instanceof Node) return `[${val.nodeName}]`;
                if (typeof val === "function") return `[Function ${(val as { name?: string }).name || "anonymous"}]`;
                if (val && typeof val === "object") {
                  if (seen.has(val as object)) return "[Circular]";
                  seen.add(val as object);
                }
                return val as unknown;
              });
              if (s === undefined) return { ok: true, value: null }; // serialized to nothing (e.g. a Symbol)
              if (s.length > maxLen) return { ok: true, value: s.slice(0, maxLen), truncated: true }; // string preview; can't reparse a sliced JSON
              return { ok: true, value: JSON.parse(s) };
            } catch (e) {
              return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
          },
          args: [code, EVAL_TIMEOUT_MS, EVAL_MAX_LEN, EVAL_SAFE_BUDGET_MS, bcpWaitFactory.toString(), bcpDomHelpersFactory.toString(), readOnly ? bcpReadOnlyGuard.toString() : null],
        });
        // res is undefined when the target frame vanished (navigation) — distinct from CSP.
        if (!res) {
          // frameId is the caller's OWN input here, so the one thing that turns this
          // from a dead end into a next call is the list of ids that are valid now.
          const live = await liveFrames(tab.id!);
          if (!live)
            throw new Error(`eval: tab ${tab.id} no longer exists. Call list_windows to pick another tab, or new_tab to open one.`);
          const want = frameId ?? 0;
          throw new Error(
            `eval: frame ${want} of tab ${tab.id} returned no result. Frames live now:\n${live.listing}\n` +
              (live.ids.includes(want)
                ? "That frame exists, so its document was replaced while this call was in flight — eval is a read, so just repeat it."
                : `That frame id is not in the list above — pass one of those frameIds (0 is the top frame), or omit frameId to run in the top frame.`),
          );
        }
        const r = res.result as { ok: boolean; value?: unknown; error?: string; truncated?: boolean } | undefined;
        // The injected function catches its own failures and reports them in
        // `error`, so reaching this fallback means it came back with NOTHING —
        // the cause is unknown. The previous text named one ("a strict page CSP
        // may block eval"), which reads as a diagnosis rather than a guess:
        // 2026-09-13 it sent an investigation off to inspect CSP headers on a
        // page that had plainly been reachable moments earlier. State the
        // ignorance instead, and point at the ISOLATED-world reads — whether one
        // of those still works is what separates "the page is gone" from "eval
        // specifically is unavailable", and it is one call away. The method
        // names come from the RpcMethod constants so this sentence cannot start
        // naming a call that no longer exists.
        if (!r?.ok)
          throw new Error(
            r?.error ??
              `eval: the injected function returned no result for tab ${tab.id} (${tab.url ?? "url unknown"}) — cause UNKNOWN, not diagnosed. A page CSP forbidding new Function and a document replaced mid-call both look exactly like this. ${RpcMethod.Snapshot} / ${RpcMethod.ReadContent} run in the ISOLATED world and are unaffected by either: if one of those works here, the page is fine and eval specifically is unavailable.`,
          );
        return { value: r.value ?? null, truncated: r.truncated };
      }
      case RpcMethod.WaitSignal: {
        const { condition, timeoutMs, tabId } = params as RpcContracts[typeof RpcMethod.WaitSignal]["params"];
        const tab = await resolveTab(tabId);
        const id = tab.id!;
        const deadline = Date.now() + (timeoutMs ?? 30_000);
        // Signal evaluation context is the TOP frame (see the spec): selectors
        // pierce open shadow roots and same-origin iframes from there, and
        // `script` leaves run in MAIN world via bcpSignalWait's new Function —
        // the same CSP constraint browser.eval has, and (since the predicate
        // unification) the same injected `bcpDom`. The wait is event-driven:
        // bcpSignalWait evaluates immediately, re-checks on observed DOM/page
        // changes, and resolves by its own deadline.
        //
        // Navigation: a navigation destroys the document the injected wait is
        // running in, so its promise dies with the old document. The committed
        // navigation is watched here, and the wait is re-injected into the new
        // document with the remaining deadline (spec: "discard the old document
        // observer and re-evaluate in the new document before the deadline").
        const frameId = 0;
        let navCommittedUrl: string | undefined;
        const onCommit = (d: { tabId: number; frameId: number; url: string }) => {
          if (d.tabId === id && d.frameId === frameId) navCommittedUrl = d.url;
        };
        cx.webNavigation.onCommitted.addListener(onCommit);
        try {
          for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 50) {
              return { satisfied: false, timedOut: true, url: navCommittedUrl };
            }
            const before = navCommittedUrl;
            let res: chrome.scripting.InjectionResult | undefined;
            let execErr: unknown;
            try {
              [res] = await cx.scripting.executeScript({
                target: { tabId: id, frameIds: [frameId] },
                world: "MAIN",
                func: bcpSignalWait,
                // Same factory source browser.eval injects (see the Eval case):
                // a gate and a step must answer "is this visible" identically.
                args: [condition, remaining, bcpDomHelpersFactory.toString()],
              });
            } catch (e) {
              execErr = e;
            }
            const r = res?.result as
              | { satisfied: boolean; timedOut?: boolean; failedPaths?: string[]; blocked?: string; url?: string; pageState?: unknown; evidence?: unknown }
              | undefined;
            if (r && (r.satisfied || r.timedOut || r.blocked)) return r;
            // No result: the document was replaced mid-wait (navigation killed
            // the injected script), or the frame/tab died. A COMMITTED
            // navigation means re-inject into the new document; anything else
            // fails closed with the usual live-frame diagnosis.
            if (execErr || !res) {
              // Yield once so a navigation the wait's own scripts caused is
              // announced relative to the injection returning.
              await new Promise((r2) => setTimeout(r2, 0));
              if (navCommittedUrl !== before) continue; // navigated: re-inject
              if (!execErr) {
                const live = await liveFrames(id);
                if (!live)
                  throw new Error(`waitSignal: tab ${id} no longer exists. Call list_windows to pick another tab, or new_tab to open one.`);
                throw new Error(
                  `waitSignal: frame ${frameId} of tab ${id} returned no result. Frames live now:\n${live.listing}\n` +
                    (live.ids.includes(frameId)
                      ? "That frame exists, so its document was replaced while this call was in flight — the signal did not satisfy before the swap."
                      : `That frame is gone${navCommittedUrl ? `; the tab committed ${navCommittedUrl}` : ""}.`),
                );
              }
              throw execErr;
            }
            // A result that is not a terminal state (shouldn't happen) — loop.
          }
        } finally {
          cx.webNavigation.onCommitted.removeListener(onCommit);
        }
      }
      case RpcMethod.Download: {
        const { url, filename } = params as RpcContracts[typeof RpcMethod.Download]["params"];
        const downloadId = await cx.downloads.download({ url, filename, conflictAction: "uniquify" });
        // A downloadId only says the request was ACCEPTED. The name reported back was
        // GUESSED from the url — Content-Disposition and conflictAction:"uniquify"
        // both rename the file — and a 404, a DNS failure or a full disk all arrived
        // as "Downloading …" too. There is no download-status RPC to follow up with,
        // so an unverified guess here is the caller's LAST word on the subject. Those
        // failures are fast: wait briefly for a terminal state, then report what
        // chrome.downloads actually holds.
        const DOWNLOAD_SETTLE_MS = 3000;
        await new Promise<void>((resolve) => {
          const done = () => {
            cx.downloads.onChanged.removeListener(onChange);
            clearTimeout(timer);
            resolve();
          };
          const onChange = (d: { id: number; state?: { current?: string } }) => {
            if (d.id === downloadId && (d.state?.current === "complete" || d.state?.current === "interrupted")) done();
          };
          cx.downloads.onChanged.addListener(onChange);
          const timer = setTimeout(done, DOWNLOAD_SETTLE_MS);
        });
        const [item] = await cx.downloads.search({ id: downloadId });
        return {
          downloadId,
          filename: item?.filename || filename || url.split("/").pop()?.split(/[?#]/)[0] || "download",
          state: item?.state ?? "in_progress",
          error: item?.error,
          bytesReceived: item?.bytesReceived,
          totalBytes: item?.totalBytes,
          mime: item?.mime,
          finalUrl: item && item.finalUrl !== item.url ? item.finalUrl : undefined,
        };
      }
      case RpcMethod.SwitchTab: {
        const { tabId, focusWindow } = params as RpcContracts[typeof RpcMethod.SwitchTab]["params"];
        const tab = await cx.tabs.get(tabId);
        await cx.tabs.update(tabId, { active: true });
        // focusWindow=false: activate within the window only (enough for
        // captureVisibleTab) — never raise the window / steal the user's focus.
        if (focusWindow !== false) {
          await cx.windows.update(tab.windowId, { focused: true });
        }
        return { tabId, windowId: tab.windowId };
      }
      case RpcMethod.ListTabs: {
        const tabs = await cx.tabs.query({});
        return {
          tabs: tabs
            .filter((t) => t.id != null)
            .map((t) => ({ id: t.id!, url: t.url ?? "", title: t.title ?? "", active: !!t.active, windowId: t.windowId })),
        };
      }
      case RpcMethod.Screenshot: {
        const { tabId, compress, activate } = params as RpcContracts[typeof RpcMethod.Screenshot]['params'];
        // Capture by window: usually works for a background window's active tab; when Chrome cannot read that
        // window back, captureWindow brings it forward for one retry and then restores the user's window.
        let tab = await resolveTab(tabId);
        const { dataUrl, activated, keptInFront } = await captureWindow({
          capture: (windowId) => cx.tabs.captureVisibleTab(windowId, { format: "png" }),
          get: (windowId) => cx.windows.get(windowId),
          lastFocused: () => cx.windows.getLastFocused({ windowTypes: ["normal"] }),
          update: (windowId, info) => cx.windows.update(windowId, info as Parameters<typeof cx.windows.update>[1]),
          wait: (ms) => new Promise((done) => setTimeout(done, ms)),
        }, tab.windowId, activate === true);
        // Re-read AFTER capturing: a tab switch landing between resolveTab and
        // captureVisibleTab would otherwise return the wrong page with no warning.
        tab = await cx.tabs.get(tab.id!);
        if (!tab.active) {
          // captureVisibleTab can only shoot the window's visible tab — be honest
          // that the image is NOT the requested (background) tab.
          const [visible] = await cx.tabs.query({ active: true, windowId: tab.windowId });
          return {
            dataUrl,
            activated,
            keptInFront,
            warning: `requested tab ${tab.id} is in the background — the image shows the window's visible tab instead ("${visible?.title ?? "unknown"}"). switch_tab first to capture the requested tab.`,
          };
        }
        return { dataUrl: compress ? await compressScreenshot(dataUrl) : dataUrl, activated, keptInFront };
      }
      case RpcMethod.PageState: {
        const p = params as RpcContracts[typeof RpcMethod.PageState]["params"];
        const tab = await resolveTab(p.tabId);
        // page_state is a read too — let the network settle first, for the same
        // reason as snapshot/read. (This path bypasses viaInject deliberately,
        // so the gate has to be repeated here.)
        await waitNetworkIdle(tab.id!);
        // A tab that was never snapshotted or navigated by us has no resident
        // probe, so its events (challenge candidates for the webhook included)
        // would never flow. Install on first contact only — once watched,
        // every load re-installs them.
        await watchedTabs.hydrate();
        if (!watchedTabs.has(tab.id!)) await injectEventProbes(tab.id!);
        // Single top-frame injection: page_state is a coherent, atomic read (it
        // deliberately does NOT pierce frames the way snapshot does — that would
        // break the "one consistent moment" guarantee). One executeScript so
        // every DOM field comes from the same instant.
        const [res] = await cx.scripting.executeScript({
          target: { tabId: tab.id!, frameIds: [0] },
          world: "ISOLATED",
          func: bcpDomRuntime,
          args: ["state", { verbosity: p.verbosity, resetDelta: p.resetDelta, deltaKey: p.deltaKey }],
        });
        const r = res?.result as { value?: Record<string, unknown>; error?: string } | undefined;
        if (r?.error) throw domOpError(r);
        if (!r?.value) {
          // Third instance of the same dead end (viaInject and eval are the other
          // two). page_state is deliberately TOP-FRAME ONLY, so the useful fact is
          // not "which frame" but whether frame 0 is even scriptable right now.
          const live = await liveFrames(tab.id!);
          throw new Error(
            live
              ? `page_state: the top frame of tab ${tab.id} returned nothing. Frames live now:\n${live.listing}\n` +
                `The document was replaced while this read was in flight — every existing [ref] is dead. Repeat this call; if it fails again, snapshot instead (it pierces frames, page_state does not).`
              : `page_state: tab ${tab.id} no longer exists. Call list_windows to pick another tab, or new_tab to open one.`,
          );
        }
        // Stamp tab context from the SW side (chrome.tabs is SW-only). Re-read so
        // `active` reflects the moment of the read, like Screenshot does.
        const fresh = await cx.tabs.get(tab.id!);
        // windowFocused: is this tab's window the OS-foreground one? active alone
        // can't tell "user is looking at it" from "visible in a background window".
        let windowFocused: boolean | undefined;
        let windowState: string | undefined;
        try {
          const win = fresh.windowId != null ? await cx.windows.get(fresh.windowId) : undefined;
          windowFocused = !!win?.focused;
          windowState = win?.state;
        } catch { /* window gone */ }
        return { ...r.value, tabId: fresh.id, windowId: fresh.windowId, active: !!fresh.active, windowFocused, windowState };
      }
      case RpcMethod.ListWindows: {
        const wins = await cx.windows.getAll({ populate: true });
        const windows = wins.map((w) => ({
          windowId: w.id!,
          focused: !!w.focused,
          state: w.state,
          activeTabId: (w.tabs?.find((t) => t.active)?.id) ?? null,
          tabs: (w.tabs ?? [])
            .filter((t) => t.id != null)
            .map((t) => ({ id: t.id!, url: t.url ?? "", title: t.title ?? "", active: !!t.active, windowId: t.windowId })),
        }));
        let lastFocusedWindowId: number | null = null;
        try { lastFocusedWindowId = (await cx.windows.getLastFocused({ windowTypes: ["normal"] })).id ?? null; } catch { /* no normal window */ }
        return { windows, focusedWindowId: wins.find((w) => w.focused)?.id ?? null, lastFocusedWindowId };
      }
      case RpcMethod.ReadNetwork: {
        const { tabId, limit } = params as RpcContracts[typeof RpcMethod.ReadNetwork]["params"];
        const t = await resolveTab(tabId);
        return { tabId: t.id!, requests: netLog.get(t.id!).slice(-(limit ?? 20)) };
      }
      case RpcMethod.SetNetworkCapture: {
        const { tabId, enabled } = params as RpcContracts[typeof RpcMethod.SetNetworkCapture]["params"];
        const id = (await resolveTab(tabId)).id!;
        let armedFrames = 0;
        if (enabled) {
          armedFrames = await injectNetworkPatch(id);
          // Only claim capture for a tab the patch actually reached.
          if (armedFrames > 0) await captureTabs.add(id);
          else await captureTabs.remove(id);
        } else {
          await captureTabs.remove(id);
          await setNetworkCaptureFlag(id, false);
        }
        return { enabled, armedFrames };
      }
      case RpcMethod.GoBack: {
        const t = await resolveTab((params as { tabId?: number }).tabId);
        return historyNav(t.id!, () => cx.tabs.goBack(t.id!));
      }
      case RpcMethod.GoForward: {
        const t = await resolveTab((params as { tabId?: number }).tabId);
        return historyNav(t.id!, () => cx.tabs.goForward(t.id!));
      }
      case RpcMethod.Reload: {
        const t = await resolveTab((params as { tabId?: number }).tabId);
        return historyNav(t.id!, () => cx.tabs.reload(t.id!));
      }
      default:
        throw new Error(`unhandled RPC method: ${method}`);
    }
  }

  /* ------------------------- UI <-> SW ------------------------- */

  // Page-event probes (injected on snapshot) message the SW here; forward each to
  // the backend as a browser event. Separate from the UI channel listener below.
  cx.runtime.onMessage.addListener(
    (msg: { kind?: string; event?: { kind: BrowserEvent["kind"]; summary: string; detail?: Record<string, unknown> } }, sender) => {
      if (msg?.kind !== "bcpPageEvent" || !msg.event) return;
      emitEvent({
        kind: msg.event.kind, tabId: sender.tab?.id ?? -1, ts: Date.now(),
        summary: msg.event.summary,
        // Probes run in EVERY frame (allFrames), so tabId alone does not
        // identify the reporter. Backend state keyed by tab only would let a
        // subframe's "cleared" retire the top frame's verdict.
        //
        // url/title describe the TAB, not the reporting frame — for a subframe
        // report they are the top document's, which is deliberate: a consumer
        // acting on this (a human told "a challenge is blocking you") needs the
        // tab it must go to, and that is the only address that identifies it.
        detail: {
          ...msg.event.detail,
          frameId: sender.frameId ?? 0,
          ...(sender.tab?.url ? { url: sender.tab.url } : {}),
          ...(sender.tab?.title ? { title: sender.tab.title } : {}),
        },
      });
    },
  );

  cx.runtime.onMessage.addListener((msg: UiToSw, _sender, sendResponse) => {
    switch (msg.kind) {
      case "interrupt":
        // Local panic-stop: reject new browser actions for a short window and
        // invalidate any in-flight one. Driver-agnostic (works from the side
        // panel button OR the page overlay).
        stopAutomation();
        break;
      case "getState":
        sendResponse({ kind: 'state', conn: link.state(), settings: desktopPaired ? { backendUrl: '', token: '' } : settings, instanceId, desktopManaged: desktopPaired } satisfies SwToUi);
        return true;
      case "saveSettings":
        settings = msg.settings;
        void cx.storage.local.set({ settings });
        // Detach the old socket's handlers so its async onclose can't schedule a
        // reconnect against the new connection (badge flicker / spurious timer).
        link.reset();
        break;
    }
    return false;
  });

  /* ------------------------- bootstrap ------------------------- */

  /**
   * Keep the MV3 service worker (and its WS connection) alive independently of the
   * side panel, so the backend can drive the browser even when the panel is closed.
   * The WS heartbeat (<30s) keeps the worker awake while connected; this alarm
   * resurrects it and reconnects if it was ever suspended or the socket dropped.
   */
  const KEEPALIVE_ALARM = "bcp-keepalive";

  // Proactive keepalive: while the worker is awake, outbound WS traffic every 20s
  // (< the 30s idle-suspend threshold) resets that timer, so the worker stays
  // alive even with the side panel closed — no more suspend→drop→alarm-revive
  // churn. The alarm below remains the recovery path if the worker is ever killed
  // anyway. A pong is a no-op receipt for the backend (keeps its liveness flag).
  const SELF_PING_MS = 20_000;
  setInterval(() => {
    link.send({ type: "pong", t: Date.now() });
  }, SELF_PING_MS);

  cx.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM && !link.isOpen()) {
      // Not OPEN after 30s covers CLOSED *and* a connect attempt stuck in
      // CONNECTING — which plain connect() would skip forever, hence reset().
      void refreshDesktopSettings().then(() => link.reset());
    }
  });

  async function boot(): Promise<void> {
    cx.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
    const stored = await cx.storage.local.get(['settings', 'bcpDesktopPaired']);
    desktopPaired = stored.bcpDesktopPaired === true;
    if (stored.settings) settings = { ...DEFAULT_SETTINGS, ...stored.settings };
    // Runtime config (when bundled) overrides the UI settings for backendUrl /
    // token — the artifact carries the exact instance identity + backend the
    // setup flow expects; the side panel stays the dev/manual fallback.
    const cfg = await loadRuntimeConfig(identity);
    if (cfg) {
      runtimeConfig = cfg;
      settings = { ...settings, backendUrl: cfg.backendUrl, token: cfg.token };
      instanceId = cfg.instanceId;
      artifactHash = cfg.artifactHash;
      console.log(`[bcp] runtime config loaded (instance ${instanceId}, artifact ${artifactHash.slice(0, 8)})`);
    } else {
      instanceId = await ensureLocalInstanceId(identity);
      console.log(`[bcp] no runtime config — dev mode, instance ${instanceId}`);
    }
    await refreshDesktopSettings();
    connect();
  }

  cx.runtime.onInstalled.addListener(() => {
    cx.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  });
  cx.runtime.onStartup.addListener(() => void boot());
  void boot();

});
