/**
 * Photographing a window the user is not looking at.
 *
 * captureVisibleTab usually works on a background window's visible tab, but a
 * window Chrome has stopped compositing (minimized, or fully behind other
 * windows on some platforms) fails with "Failed to capture tab: image readback
 * failed". Bringing that window forward for one retry, then handing the screen
 * back to whatever the user had focused, is better than an agent guessing why
 * the same call works only sometimes.
 *
 * Split out of background.ts so the retry and the hand-back can be asserted
 * against a fake windows API instead of a real browser.
 */

export interface CaptureWindowsApi {
  capture(windowId: number): Promise<string>;
  get(windowId: number): Promise<{ state?: string }>;
  lastFocused(): Promise<{ id?: number; focused?: boolean } | null>;
  update(windowId: number, info: { focused?: boolean; state?: string }): Promise<unknown>;
  wait(ms: number): Promise<void>;
}

/** Only Chrome's own capture failure is worth stealing focus for; a permission or URL error stays put. */
const READBACK = /Failed to capture tab|image readback/i;

/**
 * activated: the window was brought forward for the retry. keptInFront: no window of this browser had focus
 * before (another app, browser or profile did), and no extension API can hand focus back there, so it stays in front.
 */
export async function captureWindow(api: CaptureWindowsApi, windowId: number, allowActivate: boolean): Promise<{ dataUrl: string; activated: boolean; keptInFront?: boolean }> {
  try {
    return { dataUrl: await api.capture(windowId), activated: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!READBACK.test(message)) throw error;
    // Only the caller knows whether raising a window is acceptable (an agent's own shot in auto mode); a webhook
    // or evidence capture, and anything in manual mode, must leave the user's screen alone.
    if (!allowActivate)
      throw new Error(`${message} — Chrome is not drawing this background window (minimized or covered); it was not brought forward for this capture`);
    const last = await api.lastFocused().catch(() => null);
    // Only a Chrome window that had OS focus can be given it back; otherwise refocusing one is just more noise.
    const previous = last?.focused ? last : null;
    const { state } = await api.get(windowId);
    await api.update(windowId, state === "minimized" ? { state: "normal", focused: true } : { focused: true });
    try {
      // The window needs a composited frame before it can be read back.
      await api.wait(300);
      return { dataUrl: await api.capture(windowId), activated: true, ...(previous ? {} : { keptInFront: true }) };
    } finally {
      if (state === "minimized") await api.update(windowId, { state: "minimized" }).catch(() => {});
      if (previous?.id != null && previous.id !== windowId) await api.update(previous.id, { focused: true }).catch(() => {});
    }
  }
}
