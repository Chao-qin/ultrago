import { browserLabel, RpcMethod } from '@bcp/shared';
import type { BrowserTarget, RpcContracts } from '@bcp/shared';
import type { RawBrowserCall } from './browser-mcp-types.js';

// captureVisibleTab 依赖窗口当前标签页，所有截图和 MCP 切页必须共用此锁。
const FOREGROUND_LEASES = new Map<string, Promise<unknown>>();

export function withForegroundLease<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = FOREGROUND_LEASES.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  FOREGROUND_LEASES.set(key, next.then(() => undefined, () => undefined));
  return next;
}

export function captureBrowserScreenshot(
  call: RawBrowserCall,
  target: BrowserTarget,
  params: RpcContracts[typeof RpcMethod.Screenshot]['params'],
  getMode: (instanceId: string) => 'auto' | 'manual',
): Promise<RpcContracts[typeof RpcMethod.Screenshot]['result']> {
  return withForegroundLease(target.instanceId, async () => {
    const { tabId } = params;
    if (tabId == null) return call(RpcMethod.Screenshot, params, target);
    const { tabs } = await call(RpcMethod.ListTabs, {}, target);
    const targetInfo = tabs.find((tab) => tab.id === tabId);
    if (!targetInfo || targetInfo.active) return call(RpcMethod.Screenshot, params, target);
    if (getMode(target.instanceId) === 'manual') {
      throw new Error(
        `tab ${tabId} is not the visible tab and browser "${browserLabel(target)}" is in manual mode — will not switch the user's view to shoot it. Screenshot the active tab, ask the user, or set_browser_mode auto.`,
      );
    }
    const previous = tabs.find((tab) => tab.active && tab.id !== tabId
      && (targetInfo.windowId == null || tab.windowId === targetInfo.windowId));
    await call(RpcMethod.SwitchTab, { tabId, focusWindow: false }, target);
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const { tabs: current } = await call(RpcMethod.ListTabs, {}, target);
      if (!current.find((tab) => tab.id === tabId)?.active) {
        await call(RpcMethod.SwitchTab, { tabId, focusWindow: false }, target);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const shot = await call(RpcMethod.Screenshot, params, target);
      if (!previous) {
        shot.warning = [shot.warning, `previous visible tab unknown — the view was left on tab ${tabId}`]
          .filter(Boolean).join('; ');
      }
      return shot;
    } finally {
      // 用户在截图期间主动切页时，不覆盖用户的新选择。
      if (previous) {
        try {
          const { tabs: end } = await call(RpcMethod.ListTabs, {}, target);
          if (end.find((tab) => tab.id === tabId)?.active) {
            await call(RpcMethod.SwitchTab, {
              tabId: previous.id, focusWindow: false, restoringView: true,
            }, target);
          }
        } catch (error) {
          console.warn(`[browser-screenshot] restore failed for ${target.instanceId} tab ${previous.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  });
}
