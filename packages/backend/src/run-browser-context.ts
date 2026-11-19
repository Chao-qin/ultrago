import { LocalMethod, RpcMethod } from "@bcp/shared";
import { TAB_SCOPED } from "./recordable-methods.js";

/**
 * One auto-playback run's browser workspace. Actions and verification evidence
 * must route through this same object so they can never disagree about a tab.
 *
 * Book v2: a run may own several logical pages across several tabs/windows.
 * `pageName` is a book-local logical page; the runner binds the tab returned by
 * a `newWindow`/`newTab` action to that step's page, and later actions,
 * evidence reads and signal waits addressed to the page route to the bound tab.
 * The legacy unnamed route (no pageName) stays for plain non-v2 plans: it falls
 * back to the run's active tab, exactly as before.
 */
export class RunBrowserContext {
  private ownedTabs: number[] = [];
  private activeTabId: number | undefined;
  /** Logical page name -> its bound tab. */
  private bindings = new Map<string, { tabId: number; windowId?: number }>();
  /** Reverse index: tabId -> bound page name. */
  private tabToPage = new Map<number, string>();

  /** Resolve the target tab for a method. An explicit `tabId` wins; otherwise
   * the named page's binding; otherwise (legacy plans) the active tab. A page
   * with no binding is a hard error — never fall back to the user's active tab. */
  route(method: string, params: Record<string, unknown>, pageName?: string): Record<string, unknown> {
    const tabScoped = TAB_SCOPED.has(method as RpcMethod) || method === LocalMethod.PickOption;
    if (!tabScoped || (params as { tabId?: number }).tabId != null) return params;
    if (pageName !== undefined) {
      const binding = this.bindings.get(pageName);
      if (!binding) throw new Error(`run has no binding for page "${pageName}"`);
      return { ...params, tabId: binding.tabId };
    }
    if (this.activeTabId == null) throw new Error(`run has no active work tab for ${method}`);
    return { ...params, tabId: this.activeTabId };
  }

  /** Watch a completed call for tab lifecycle: bind pages opened by the step,
   * drop bindings whose tab/window was closed. `pageName` is the step's logical
   * page — a `newWindow`/`newTab` returning a tab binds it to that page. */
  observe(method: string, params: Record<string, unknown>, result: unknown, pageName?: string): void {
    if (method === RpcMethod.NewTab || method === RpcMethod.NewWindow) {
      const tabId = (result as { tabId?: unknown }).tabId;
      if (typeof tabId === "number") {
        if (!this.ownedTabs.includes(tabId)) this.ownedTabs.push(tabId);
        this.activeTabId = tabId;
        if (pageName !== undefined) {
          const windowId = (result as { windowId?: unknown }).windowId;
          this.bindings.set(pageName, { tabId, windowId: typeof windowId === "number" ? windowId : undefined });
          this.tabToPage.set(tabId, pageName);
        }
      }
      return;
    }
    if (method === RpcMethod.CloseTab) {
      const tabId = (params as { tabId?: unknown }).tabId;
      if (typeof tabId !== "number") return;
      this.ownedTabs = this.ownedTabs.filter((id) => id !== tabId);
      if (this.activeTabId === tabId) this.activeTabId = this.ownedTabs.at(-1);
      const page = this.tabToPage.get(tabId);
      if (page) {
        this.bindings.delete(page);
        this.tabToPage.delete(tabId);
      }
      return;
    }
    if (method === RpcMethod.CloseWindow) {
      const windowId = (params as { windowId?: unknown }).windowId;
      if (typeof windowId !== "number") return;
      for (const [page, b] of this.bindings) {
        if (b.windowId === windowId) {
          this.tabToPage.delete(b.tabId);
          this.bindings.delete(page);
        }
      }
    }
  }

  /** Bind a tab to a logical page directly (used by page-scoped bootstrap paths
   * and tests). Overwrites any prior binding for the page. */
  bind(pageName: string, tabId: number, windowId?: number): void {
    const prior = this.tabToPage.get(tabId);
    if (prior && prior !== pageName) this.bindings.delete(prior);
    this.tabToPage.set(tabId, pageName);
    this.bindings.set(pageName, { tabId, windowId });
    if (!this.ownedTabs.includes(tabId)) this.ownedTabs.push(tabId);
  }

  currentTabId(pageName?: string): number | undefined {
    if (pageName !== undefined) return this.bindings.get(pageName)?.tabId;
    return this.activeTabId;
  }

  ownedTabIds(): readonly number[] {
    return this.ownedTabs;
  }

  targetAvailable(pageName?: string): boolean {
    if (pageName !== undefined) return this.bindings.has(pageName);
    return this.activeTabId != null;
  }

  /** Bound logical page names (Book v2). */
  boundPages(): string[] {
    return [...this.bindings.keys()];
  }
}
