/**
 * Who this browser instance says it is.
 *
 * The backend bakes a `runtime-config.json` into the artifact it builds, which
 * is how a managed instance gets a stable identity. A raw dev build has none,
 * and refusing to work in that case would make the extension unloadable by
 * hand — so a self-generated, persisted id stands in.
 */
import type { ExtensionRuntimeConfig } from "@bcp/shared";

export interface IdentityDeps {
  /** Resolve a packaged resource URL (`chrome.runtime.getURL`). */
  getURL(path: string): string;
  /** Fetch it. Never hits the network — it is a local extension resource. */
  fetch(url: string): Promise<{ ok: boolean; json(): Promise<unknown> }>;
  /** `chrome.storage.local`, for the dev fallback id. */
  store: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  /** Injectable so tests do not depend on crypto availability. */
  randomId?: () => string;
}

export async function loadRuntimeConfig(deps: IdentityDeps): Promise<ExtensionRuntimeConfig | null> {
  try {
    const res = await deps.fetch(deps.getURL("runtime-config.json"));
    if (!res.ok) return null;
    const cfg = (await res.json()) as ExtensionRuntimeConfig;
    if (typeof cfg.instanceId !== "string" || !cfg.instanceId) return null;
    return cfg;
  } catch {
    return null;
  }
}

/** Generate + persist a stable instanceId for the dev / manual-load case. */
export async function ensureLocalInstanceId(deps: IdentityDeps): Promise<string> {
  try {
    const got = await deps.store.get("bcpInstanceId");
    if (typeof got.bcpInstanceId === "string" && got.bcpInstanceId) return got.bcpInstanceId;
  } catch {
    /* storage unavailable — an ephemeral id is acceptable in dev */
  }
  const id = (deps.randomId ?? defaultRandomId)();
  try {
    await deps.store.set({ bcpInstanceId: id });
  } catch {
    /* best-effort */
  }
  return id;
}

/** `crypto.randomUUID` may be unavailable in some service-worker contexts. */
function defaultRandomId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().toLowerCase()
    : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
