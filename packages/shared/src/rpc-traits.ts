/**
 * What every browser RPC IS, in one place — every list that used to be kept by hand is derived from this table.
 *
 * Four hand-kept lists described the same methods and drifted apart: the extension's op map knew right_click and
 * double_click while its dispatcher's case list did not (both tools failed with "unhandled RPC method"); only five of
 * the twelve in-page actions got the navigation barrier and page-dialog watch; the two "mutating" sets — the
 * extension's resend guard and the backend's recording set — disagreed on paste, double click and context menu, so
 * a resend after a lost response pasted twice. `satisfies Record<RpcMethod, …>` makes a method added later fail to
 * compile until it is described here, so a new action cannot slip past any of them.
 *
 * Leaf module: imports only methods.ts, so the extension, the backend and the runtime builders can all use it.
 */
import { RpcMethod } from "./methods.js";

/** The injected runtime's op name for an RPC that runs inside the page. */
export type DomOp =
  | "snapshot" | "click" | "type" | "read" | "wait" | "select" | "key" | "scroll" | "drag" | "upload" | "hover"
  | "clickText" | "contextmenu" | "dblclick" | "paste";

export interface RpcTraits {
  /** Runs inside the page, as this op of the injected runtime. */
  domOp?: DomOp;
  /** Only reads: the page, the browser and the session are left as they were. Every other in-page op is an action,
   *  and the extension watches it for what it caused (a navigation commit, a page dialog) to report back. */
  readOnly: boolean;
  /** Acts on the browser in a way a recording plan captures and manual mode guards (the backend's MUTATING). */
  mutating: boolean;
  /** Running it a second time has a second effect, so a resend after a lost response must return the first
   *  result instead of running again. */
  unsafeToRepeat: boolean;
  /** Falls back to the active tab when no tabId is given — the calls that could touch the user's own view. */
  tabScoped: boolean;
}

const read = (o: Partial<RpcTraits> = {}): RpcTraits => ({ readOnly: true, mutating: false, unsafeToRepeat: false, tabScoped: true, ...o });
const act = (o: Partial<RpcTraits> = {}): RpcTraits => ({ readOnly: false, mutating: true, unsafeToRepeat: true, tabScoped: true, ...o });

export const RPC_TRAITS = {
  [RpcMethod.Navigate]: act(),
  [RpcMethod.NewTab]: act({ tabScoped: false }),
  [RpcMethod.CloseTab]: act(),
  [RpcMethod.NewWindow]: act({ tabScoped: false }),
  [RpcMethod.CloseWindow]: act({ mutating: false, tabScoped: false }),
  [RpcMethod.SetWindowState]: act({ unsafeToRepeat: false }),
  [RpcMethod.ListTabs]: read({ tabScoped: false }),
  [RpcMethod.Screenshot]: read(),
  [RpcMethod.Snapshot]: read({ domOp: "snapshot" }),
  [RpcMethod.Click]: act({ domOp: "click" }),
  [RpcMethod.Type]: act({ domOp: "type" }),
  [RpcMethod.ReadContent]: read({ domOp: "read" }),
  [RpcMethod.WaitFor]: read({ domOp: "wait" }),
  [RpcMethod.WaitSignal]: read(),
  // Page JS can do anything, so a resend must not run it again; it is not a recorded action (RECORDABLE_READS
  // captures it), so `mutating` stays false.
  [RpcMethod.Eval]: act({ mutating: false }),
  [RpcMethod.Download]: act({ mutating: false, tabScoped: false }),
  [RpcMethod.SwitchTab]: act({ mutating: false, unsafeToRepeat: false, tabScoped: false }),
  [RpcMethod.SelectOption]: act({ domOp: "select" }),
  [RpcMethod.PressKey]: act({ domOp: "key" }),
  [RpcMethod.GoBack]: act(),
  [RpcMethod.GoForward]: act(),
  [RpcMethod.Reload]: act(),
  // Scrolling twice scrolls twice (and loads twice as much of an infinite list).
  [RpcMethod.Scroll]: act({ domOp: "scroll" }),
  [RpcMethod.Drag]: act({ domOp: "drag" }),
  [RpcMethod.Upload]: act({ domOp: "upload" }),
  // Hovering opens menus and tooltips, so it is watched like any action; hovering again changes nothing, and it is
  // not a recorded step.
  [RpcMethod.Hover]: act({ domOp: "hover", mutating: false, unsafeToRepeat: false }),
  [RpcMethod.ClickText]: act({ domOp: "clickText" }),
  [RpcMethod.ContextMenu]: act({ domOp: "contextmenu" }),
  [RpcMethod.DblClick]: act({ domOp: "dblclick" }),
  [RpcMethod.Paste]: act({ domOp: "paste" }),
  [RpcMethod.ReadNetwork]: read(),
  [RpcMethod.SetNetworkCapture]: act({ mutating: false, unsafeToRepeat: true }),
  [RpcMethod.PageState]: read(),
  [RpcMethod.ListWindows]: read({ tabScoped: false }),
} as const satisfies Record<RpcMethod, RpcTraits>;

const methodsWhere = (pick: (t: RpcTraits) => boolean): RpcMethod[] =>
  (Object.entries(RPC_TRAITS) as [RpcMethod, RpcTraits][]).filter(([, t]) => pick(t)).map(([m]) => m);

/** RPC → the runtime op that runs it, for every in-page RPC. */
export const DOM_OP: Partial<Record<RpcMethod, DomOp>> = Object.fromEntries(
  (Object.entries(RPC_TRAITS) as [RpcMethod, RpcTraits][]).filter(([, t]) => t.domOp).map(([m, t]) => [m, t.domOp!]),
);
/** In-page actions: watched for the navigation and page dialogs they cause. */
export const isPageAction = (m: RpcMethod): boolean => !!RPC_TRAITS[m].domOp && !RPC_TRAITS[m].readOnly;
export const MUTATING_METHODS: readonly RpcMethod[] = methodsWhere((t) => t.mutating);
export const UNSAFE_TO_REPEAT_METHODS: readonly RpcMethod[] = methodsWhere((t) => t.unsafeToRepeat);
export const TAB_SCOPED_METHODS: readonly RpcMethod[] = methodsWhere((t) => t.tabScoped);
