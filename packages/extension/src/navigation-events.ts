import type { BrowserEvent } from '@bcp/shared';

type NavigationDetails = { tabId: number; frameId: number; url: string };
type NavigationSource = { addListener(listener: (details: NavigationDetails) => void): void };

export function installNavigationInvalidation(
  navigation: {
    onBeforeNavigate: NavigationSource;
    onHistoryStateUpdated: NavigationSource;
    onReferenceFragmentUpdated: NavigationSource;
  },
  emit: (event: BrowserEvent) => void,
): void {
  const invalidate = (details: NavigationDetails): void => {
    emit({
      kind: 'navigation_started',
      tabId: details.tabId,
      ts: Date.now(),
      summary: `document changing → ${details.url}`,
      detail: { url: details.url, frameId: details.frameId },
    });
  };
  // navigation 仍表示加载完成；提前复用该事件会唤醒等待页面就绪的调用方。
  navigation.onBeforeNavigate.addListener(invalidate);
  navigation.onHistoryStateUpdated.addListener(invalidate);
  navigation.onReferenceFragmentUpdated.addListener(invalidate);
}
