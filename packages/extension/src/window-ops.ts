/**
 * Opening a task window without stealing the user's screen.
 *
 * Every step here exists because a simpler version failed:
 *   - `focused:false` alone does not keep the new window behind — observed
 *     unreliable at OS-foreground level — so the previously focused window is
 *     snapshotted BEFORE creating and re-raised after.
 *   - Create-time bounds are advisory; Chrome clamps a fully off-screen window
 *     back onto a display, so they are re-asserted afterwards.
 *   - The window state is pinned EXPLICITLY in both directions. An unfocused
 *     create hands back a MINIMIZED window on some platforms, and minimized is
 *     not merely out of sight: Chrome marks it hidden, rendering stops and
 *     timers are throttled hard, which is what made background runs fail at
 *     random.
 *   - A window with no tab throws here rather than handing back `-1`. That
 *     sentinel satisfies the declared `tabId: number`, so nothing downstream
 *     questioned it and the failure surfaced three layers away.
 *
 * Split out of background.ts so these rules can be asserted against a fake
 * windows API instead of a real browser.
 */

export interface WindowLike {
  id?: number;
  focused?: boolean;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  state?: string;
  tabs?: Array<{ id?: number; url?: string }>;
}

export interface WindowBounds {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

/** The slice of `chrome.windows` this needs. */
export interface WindowApi {
  getLastFocused(opts: { windowTypes: string[] }): Promise<WindowLike>;
  create(opts: WindowBounds & { url?: string; focused?: boolean; type?: string }): Promise<WindowLike>;
  update(id: number, opts: WindowBounds & { focused?: boolean; state?: string }): Promise<unknown>;
  get(id: number): Promise<WindowLike>;
}

export interface OpenWindowDeps {
  windows: WindowApi;
  /** Register the tab before its first navigation — a window pushed behind the
   *  user's is occluded from that moment on, and the shim has to be in place. */
  markWatched(tabId: number): Promise<void>;
}

export interface OpenWindowParams extends WindowBounds {
  url?: string;
  focused?: boolean;
  minimized?: boolean;
  restoreFocus?: boolean;
}

export interface OpenWindowResult {
  windowId: number;
  tabId: number;
  url: string;
  bounds?: WindowBounds & { state?: string };
}

export async function openWindow(
  { windows, markWatched }: OpenWindowDeps,
  params: OpenWindowParams,
): Promise<OpenWindowResult> {
  const { url, focused, minimized, left, top, width, height, restoreFocus } = params;

  // Snapshot whichever window currently has OS focus BEFORE creating — there is
  // nothing to restore TO once our own window exists and may already have
  // grabbed the foreground despite focused:false.
  const previousFocused = restoreFocus
    ? await windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null)
    : null;
  const win = await windows.create({ url, focused: focused ?? false, type: "normal", left, top, width, height });

  // Re-raise the window the user was actually looking at.
  if (previousFocused?.id != null && previousFocused.id !== win.id) {
    await windows.update(previousFocused.id, { focused: true }).catch(() => {});
  }
  // macOS can leave a newly-created window focused even after that. Asking for
  // focused:false makes Chrome promote the next window in z-order instead.
  if (restoreFocus && win.id != null) {
    const current = await windows.get(win.id).catch(() => null);
    if (current?.focused) await windows.update(win.id, { focused: false }).catch(() => {});
  }
  // Re-assert bounds: create-time values are advisory.
  if (win.id != null && (left != null || top != null || width != null || height != null)) {
    try {
      await windows.update(win.id, { left, top, width, height });
    } catch {
      /* platform clamped it; reported back below */
    }
  }
  // Pin the state explicitly in BOTH directions — see the header.
  if (win.id != null) await windows.update(win.id, { state: minimized ? "minimized" : "normal" });

  const tab = win.tabs?.[0];
  if (tab?.id == null) throw new Error(`newWindow: created window ${win.id} has no tab to work in`);
  await markWatched(tab.id);

  const placed = win.id != null ? await windows.get(win.id).catch(() => null) : null;
  return {
    windowId: win.id!,
    tabId: tab.id,
    url: url ?? tab.url ?? "",
    bounds: placed
      ? { left: placed.left, top: placed.top, width: placed.width, height: placed.height, state: placed.state }
      : undefined,
  };
}
