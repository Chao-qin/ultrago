export const DESKTOP_NATIVE_HOST = 'com.ultrago.desktop';

export interface DesktopConnection {
  version: 1;
  generation: string;
  backendUrl: string;
  token: string;
  /** Version of the extension bundled with the running desktop client. */
  extensionVersion?: string;
}

export function desktopConnection(value: unknown): DesktopConnection | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<DesktopConnection>;
  if (v.version !== 1 || typeof v.generation !== 'string' || !v.generation || typeof v.token !== 'string' || !/^[a-f0-9]{64}$/.test(v.token) || typeof v.backendUrl !== 'string') return null;
  if (v.extensionVersion !== undefined && (typeof v.extensionVersion !== 'string' || !/^[0-9.]{1,32}$/.test(v.extensionVersion))) return null;
  try {
    const url = new URL(v.backendUrl);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) <= 0 || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  } catch { return null; }
  return v as DesktopConnection;
}

/**
 * An unpacked extension keeps running its old files after the desktop client is upgraded in place.
 * Returns the marker to persist before `runtime.reload()`, or null. Each running→bundled pair reloads
 * at most once, so a Chrome that loaded the extension from another folder cannot loop.
 */
export function desktopReloadMarker(bundled: string | undefined, running: string, previous: unknown): string | null {
  if (!bundled || bundled === running) return null;
  const marker = `${running}->${bundled}`;
  return previous === marker ? null : marker;
}

/** Persists the marker before reloading, so the reloaded worker sees it even though reload() never returns. */
export async function reloadForDesktop(
  bundled: string | undefined,
  running: string,
  storage: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> },
  reload: () => void,
): Promise<boolean> {
  const marker = desktopReloadMarker(bundled, running, (await storage.get('bcpDesktopReload')).bcpDesktopReload);
  if (!marker) return false;
  await storage.set({ bcpDesktopReload: marker });
  reload();
  return true;
}
