import { useEffect, useState } from "react";
import { Square, Settings2, ExternalLink, Sidebar } from "lucide-react";
import {
  DEFAULT_SETTINGS,
  type ConnState,
  type Settings,
  type SwToUi,
} from "../../messaging";

// Firefox exposes promise-based `browser`; Chrome MV3 exposes promise-based
// `chrome`. Bind whichever the side-panel / sidebar context provides so the
// calls below are promise-based on both. Chrome-only APIs (sidePanel) are
// guarded with optional chaining since Firefox's `browser` has no such member.
const cx: typeof chrome = ((globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome);

const CONN_LABEL: Record<ConnState, string> = {
  connected: '已连接',
  connecting: '连接中…',
  disconnected: '未连接',
};

export function App() {
  // Same UI serves the docked side panel AND a floating popup window (?popup=1).
  const isPopup = new URLSearchParams(location.search).get("popup") === "1";
  const [conn, setConn] = useState<ConnState>("disconnected");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [instanceId, setInstanceId] = useState('');
  const [desktopManaged, setDesktopManaged] = useState(false);

  useEffect(() => {
    let revision = 0;
    let active = true;
    const refresh = () => {
      const requestedRevision = revision;
      void cx.runtime.sendMessage({ kind: 'getState' }).then((s: SwToUi | undefined) => {
        if (!active || requestedRevision !== revision) return;
        if (s?.kind === "state") {
          setConn(s.conn);
          setSettings(s.settings);
          setInstanceId(s.instanceId || '');
          setDesktopManaged(s.desktopManaged === true);
        }
      }).catch(() => { if (active && requestedRevision === revision) setConn('disconnected'); });
    };

    const listener = (msg: SwToUi) => {
      if (msg.kind === 'conn') { revision++; setConn(msg.conn); }
    };
    cx.runtime.onMessage.addListener(listener);
    refresh();
    const visibleRefresh = () => { if (!document.hidden) refresh(); };
    const timer = setInterval(visibleRefresh, 3000);
    document.addEventListener('visibilitychange', visibleRefresh);
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', visibleRefresh); cx.runtime.onMessage.removeListener(listener); };
  }, []);

  // Local panic-stop: rejects new browser actions for a short window.
  const stop = () => cx.runtime.sendMessage({ kind: "interrupt" });

  // Pop out to a floating window AND close the side panel (the two are exclusive).
  const popOut = async () => {
    const w = await cx.windows.getCurrent();
    await cx.windows.create({
      url: cx.runtime.getURL(`sidepanel.html?popup=1&opener=${w.id}`),
      type: "popup",
      width: 420,
      height: 760,
    });
    window.close(); // close this side panel
  };
  // Dock back into the side panel AND close this floating window.
  const dock = () => {
    const openerId = Number(new URLSearchParams(location.search).get("opener"));
    // sidePanel.open must run synchronously in the user gesture — no await before it.
    if (openerId) cx.sidePanel?.open({ windowId: openerId }).catch(() => {});
    window.close(); // close this popup
  };

  return (
    <div className="app">
      <header className="header">
        <img className="logo" src={cx.runtime.getURL("icons/icon-48.png")} alt="" />
        <span className="title">UltraGo</span>
        <span className={`badge badge-${conn}`}>{CONN_LABEL[conn]}</span>
        <button
          className="icon-btn"
          title={isPopup ? "Dock back into the side panel" : "Pop out to a floating window (frees the page's space)"}
          onClick={isPopup ? dock : popOut}
        >
          {isPopup ? <Sidebar size={15} /> : <ExternalLink size={15} />}
        </button>
        <button className="icon-btn" disabled={desktopManaged} title={desktopManaged ? '请在客户端管理连接' : 'Settings'} onClick={() => setShowSettings((v) => !v)}>
          <Settings2 size={16} />
        </button>
      </header>

      {showSettings && (
        <section className="settings">
          <label>
            Backend URL
            <input
              value={settings.backendUrl}
              onChange={(e) => setSettings({ ...settings, backendUrl: e.target.value })}
            />
          </label>
          <label>
            Token
            <input
              value={settings.token}
              onChange={(e) => setSettings({ ...settings, token: e.target.value })}
            />
          </label>
          <button
            className="primary"
            onClick={() => {
              cx.runtime.sendMessage({ kind: "saveSettings", settings });
              setShowSettings(false);
            }}
          >
            Save &amp; reconnect
          </button>
        </section>
      )}

      <div className="status">
        <p className="status-line">
          浏览器执行器<strong>{CONN_LABEL[conn]}</strong>
        </p>
        {instanceId && <p className="status-hint">浏览器编号：<code>{instanceId.slice(0, 8)}</code></p>}
        <p className="status-hint">扩展 {cx.runtime.getManifest().version} · 此状态只表示浏览器连接；MCP 助手状态请在客户端的连接诊断中查看。</p>
        {desktopManaged ? <p className="status-hint">连接由桌面客户端管理。请在客户端确认此浏览器，无需填写端口。</p> : <p className="status-hint">
          There is no built-in agent here. Point your agent at the backend&apos;s MCP endpoint
          (<code>http://127.0.0.1:8788/mcp</code>) and it drives this browser through the
          <code> browser_*</code> tools. The server&apos;s instructions teach it the
          perceive → act → verify loop.
        </p>}
        <button className="ghost stop" onClick={stop} title="Reject new browser actions for a few seconds">
          <Square size={14} /> Stop automation
        </button>
      </div>
    </div>
  );
}
