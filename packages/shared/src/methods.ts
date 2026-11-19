/**
 * Leaf module holding the RPC / local method name constants.
 *
 * IMPORTANT: this file must have NO imports. It sits at the bottom of the
 * dependency graph so anything can import from it without creating a module
 * cycle at runtime. `index.ts` (the public barrel) re-exports these so
 * consumers keep using `@bcp/shared` as before; `codegen.ts` and
 * `mcp-instructions.ts` import from here directly to avoid the
 * index → mcp-instructions → index cycle that tripped `tsx`'s TDZ check.
 */

/** Browser RPC surface — the methods Claude can invoke via MCP tools.
 * Keep this list == the tools registered in backend/browser-mcp.ts. */
export const RpcMethod = {
  Navigate: "browser.navigate",
  NewTab: "browser.newTab",
  CloseTab: "browser.closeTab",
  NewWindow: "browser.newWindow",
  CloseWindow: "browser.closeWindow",
  SetWindowState: "browser.setWindowState",
  ListTabs: "browser.listTabs",
  Screenshot: "browser.screenshot",
  Snapshot: "browser.snapshot",
  Click: "browser.click",
  Type: "browser.type",
  ReadContent: "browser.readContent",
  WaitFor: "browser.waitFor",
  /** Event-driven wait for a declarative Book v2 signal condition in one tab.
   * Runner-internal (gates), not a client-facing workflow step. */
  WaitSignal: "browser.waitSignal",
  Eval: "browser.eval",
  Download: "browser.download",
  SwitchTab: "browser.switchTab",
  SelectOption: "browser.selectOption",
  PressKey: "browser.pressKey",
  GoBack: "browser.goBack",
  GoForward: "browser.goForward",
  Reload: "browser.reload",
  Scroll: "browser.scroll",
  Drag: "browser.drag",
  Upload: "browser.upload",
  Hover: "browser.hover",
  ClickText: "browser.clickText",
  ContextMenu: "browser.contextMenu",
  DblClick: "browser.dblClick",
  Paste: "browser.paste",
  ReadNetwork: "browser.readNetwork",
  SetNetworkCapture: "browser.setNetworkCapture",
  PageState: "browser.pageState",
  ListWindows: "browser.listWindows",
} as const;

export type RpcMethod = (typeof RpcMethod)[keyof typeof RpcMethod];

/** Steps the BACKEND executes itself instead of forwarding one browser RPC:
 * backend JS, file writes, and composites of several browser RPCs that a
 * playbook must replay as ONE step action. Only `Eval` runs arbitrary code in
 * the backend process, so only it is gated by BCP_LOCAL_EVAL. */
export const LocalMethod = {
  /** Run JS against `results` (this run's PlaybackStepResult[] so far). */
  Eval: "local.eval",
  /** Write a prior step's value to a file under reports/. */
  WriteFile: "local.writeFile",
  /** Open a custom dropdown and choose an option (the pick_option tool). */
  PickOption: "local.pickOption",
} as const;

export type LocalMethod = (typeof LocalMethod)[keyof typeof LocalMethod];