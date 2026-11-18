/**
 * BrowserAdapters — per-kind executable discovery, launch args, launch and
 * OS-visible install-guide actions. The ONLY place platform/browser specifics
 * live; the setup service and dispatcher stay kind-agnostic.
 *
 * Discovery order (spec §8.2): configured path → standard install locations →
 * PATH. Every candidate is realpath'd, permission-checked and version-probed
 * with a fixed `--version` call (bounded timeout). No recursive disk scan, no
 * arbitrary args from callers.
 */
import { execFile, spawn } from "node:child_process";
import { access, realpath, constants } from "node:fs/promises";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  browserError,
  type BrowserError,
  type BrowserExecutableCandidate,
  type BrowserKind,
  type BrowserProfileMode,
  type BrowserTarget,
} from "@bcp/shared";

const execFileP = promisify(execFile);

export interface LaunchedProcess {
  pid: number;
  startTime: number;
  /** The child handle (null when the adapter merely OPENED a user-owned app —
   * user processes are never supervised). */
  child?: unknown;
}

/** OS-visible actions that cannot depend on extension RPC. */
export interface BrowserAdapter {
  kind: BrowserKind;
  discover(): Promise<BrowserExecutableCandidate[]>;
  buildLaunchArgs(input: { mode: BrowserProfileMode; profileDir?: string; artifactDir?: string }): string[];
  /** Launch a browser process (managed mode only — the caller owns the child). */
  launch(input: { executable: string; args: string[] }): Promise<LaunchedProcess>;
  /** Open the user's browser normally (launch if closed, focus if running) —
   * WITHOUT navigating anywhere. The install guide is only for when the
   * extension is genuinely missing; a normal open lets an already-installed
   * extension just handshake. Uses ONLY adapter-built openers, never caller
   * input. */
  openBrowser(input: { executable: string }): Promise<void>;
  /** Open the install guide + artifact dir for the USER to load the unpacked
   * extension. Uses ONLY adapter-built URLs/openers — never caller input. */
  openInstallGuide(input: { executable: string; artifactDir: string }): Promise<void>;
}

/* ----------------------------- shared helpers ----------------------------- */

async function realpathSafe(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

async function probeVersion(exe: string, flag = "--version"): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP(exe, [flag], { timeout: 5_000, windowsHide: true });
    return stdout.split(/\r?\n/)[0]?.trim().slice(0, 200) || undefined;
  } catch {
    return undefined;
  }
}

/** macOS standard install locations (this repo's target platform). */
function macAppPaths(kind: BrowserKind): string[] {
  const root = homedir();
  const names: string[] =
    kind === "chrome"
      ? ["Google Chrome", "Chromium", "Google Chrome Canary"]
      : ["Firefox", "Firefox Developer Edition"];
  const dirs = [
    "/Applications",
    join(root, "Applications"),
    "/Applications/Utilities",
  ];
  const paths: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      paths.push(join(dir, `${name}.app`, "Contents", "MacOS", kind === "chrome" ? "Google Chrome" : "firefox"));
    }
  }
  // Chromium binary name differs from the app bundle name.
  if (kind === "chrome") paths.push(join("/Applications", "Chromium.app", "Contents", "MacOS", "Chromium"));
  return paths;
}

/** macOS `open` wrapper — used for user-mode launch + install guide (visible
 * OS actions; the user's own profile is opened, never supervised). */
function openWith(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("/usr/bin/open", args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`open ${args.join(" ")} exited ${code}`));
    });
  });
}

function isExecutable(p: string): Promise<boolean> {
  return access(p, constants.X_OK).then(() => true, () => false);
}

/* ----------------------------- Chrome ----------------------------- */

class ChromeAdapter implements BrowserAdapter {
  readonly kind: BrowserKind = "chrome";

  async discover(): Promise<BrowserExecutableCandidate[]> {
    const out: BrowserExecutableCandidate[] = [];
    const seen = new Set<string>();
    const add = async (p: string, source: BrowserExecutableCandidate["source"]): Promise<void> => {
      const rp = await realpathSafe(p);
      if (!rp || seen.has(rp)) return;
      seen.add(rp);
      const usable = await isExecutable(rp);
      const version = usable ? await probeVersion(rp) : undefined;
      out.push({
        kind: this.kind,
        path: rp,
        source,
        version,
        usable,
        ...(usable ? {} : { error: browserError("executable_invalid", `not executable: ${rp}`, { retryable: false }) }),
      });
    };
    const standard = process.platform === 'win32'
      ? [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]
        .filter((p): p is string => !!p).map((p) => join(p, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      : macAppPaths('chrome');
    for (const p of standard) await add(p, "standard_path");
    if (process.env.BROWSER_PATH) await add(process.env.BROWSER_PATH, "path");
    return out;
  }

  buildLaunchArgs(input: { mode: BrowserProfileMode; profileDir?: string; artifactDir?: string }): string[] {
    // Managed Chrome: dedicated profile + the built artifact loaded unpacked.
    // The caller can never append args — the adapter owns the command.
    // The occlusion pair is load-bearing, not a tuning knob: when a task window
    // ends up fully covered (a maximized user window on top, or spawned off the
    // visible desktop), Chrome marks it occluded and freezes rAF + timers. The
    // page still answers DOM reads and `document.visibilityState` can still say
    // "visible", so nothing errors — but React never commits, so typed values
    // silently fail to land and lazily-rendered controls never appear. Playwright
    // and Puppeteer ship --disable-backgrounding-occluded-windows by default for
    // exactly this reason; CalculateNativeWinOcclusion (Windows-only) is our addition.
    const args = [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=CalculateNativeWinOcclusion",
      "--disable-backgrounding-occluded-windows",
    ];
    if (input.profileDir) args.push(`--user-data-dir=${input.profileDir}`);
    if (input.artifactDir) {
      args.push(`--load-extension=${input.artifactDir}`);
      // Only the built artifact may load — an unrelated "unpacked extension"
      // pointing at the same profile must not confuse routing.
      args.push(`--disable-extensions-except=${input.artifactDir}`);
    }
    return args;
  }

  launch(input: { executable: string; args: string[] }): Promise<LaunchedProcess> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(input.executable, input.args, { stdio: "ignore", detached: false });
      child.once("error", reject);
      child.once("spawn", () => {
        if (!child.pid) return reject(new Error("chrome did not spawn"));
        resolvePromise({ pid: child.pid, startTime: Date.now(), child });
      });
    });
  }

  async openBrowser(input: { executable: string }): Promise<void> {
    if (process.platform === 'win32') return openUserProcess(input.executable, []);
    await openWith(["-a", input.executable]);
  }

  async openInstallGuide(input: { executable: string; artifactDir: string }): Promise<void> {
    if (process.platform === 'win32') {
      await openUserProcess(input.executable, ['chrome://extensions']);
      await openUserProcess('explorer.exe', [input.artifactDir]);
      return;
    }
    // Open chrome://extensions (where "Load unpacked" lives) and reveal the
    // artifact dir in the OS file manager so the user can point it there.
    await openWith(["-a", input.executable, "chrome://extensions"]);
    await openWith(["-R", join(input.artifactDir, "manifest.json")]);
  }
}

/* ----------------------------- Firefox ----------------------------- */

class FirefoxAdapter implements BrowserAdapter {
  readonly kind: BrowserKind = "firefox";

  async discover(): Promise<BrowserExecutableCandidate[]> {
    const out: BrowserExecutableCandidate[] = [];
    const seen = new Set<string>();
    const add = async (p: string, source: BrowserExecutableCandidate["source"]): Promise<void> => {
      const rp = await realpathSafe(p);
      if (!rp || seen.has(rp)) return;
      seen.add(rp);
      const usable = await isExecutable(rp);
      const version = usable ? await probeVersion(rp, "--version") : undefined;
      out.push({
        kind: this.kind,
        path: rp,
        source,
        version,
        usable,
        ...(usable ? {} : { error: browserError("executable_invalid", `not executable: ${rp}`, { retryable: false }) }),
      });
    };
    for (const p of macAppPaths("firefox")) await add(p, "standard_path");
    return out;
  }

  buildLaunchArgs(input: { mode: BrowserProfileMode; profileDir?: string; artifactDir?: string }): string[] {
    // Firefox managed is unsupported in phase 1 — this should never be called.
    if (input.mode === "managed") {
      throw browserError("unsupported", "firefox managed profiles are not supported (phase 1: user mode only)", { retryable: false });
    }
    return [];
  }

  launch(_input: { executable: string; args: string[] }): Promise<LaunchedProcess> {
    return Promise.reject(browserError("unsupported", "firefox managed launch is not supported (phase 1: user mode only)", { retryable: false }));
  }

  async openBrowser(input: { executable: string }): Promise<void> {
    await openWith(["-a", input.executable]);
  }

  async openInstallGuide(input: { executable: string; artifactDir: string }): Promise<void> {
    // Firefox's "Load Temporary Add-on" lives under about:debugging. Open it
    // plus the artifact dir (the temp-addon picker is a file dialog).
    await openWith(["-a", input.executable, "about:debugging#/runtime/this-firefox"]);
    await openWith(["-R", join(input.artifactDir, "manifest.json")]);
  }
}

/** Discover candidates for both kinds (status response + setup use this). */
export async function discoverAll(): Promise<BrowserExecutableCandidate[]> {
  const [chrome, firefox] = await Promise.all([new ChromeAdapter().discover(), new FirefoxAdapter().discover()]);
  return [...chrome, ...firefox];
}

/** Pick the best usable candidate for a kind, or a structured error. */
export async function pickExecutable(kind: BrowserKind): Promise<{ executable: BrowserExecutableCandidate; error?: undefined } | { executable?: undefined; error: BrowserError }> {
  const adapter = getAdapter(kind);
  const candidates = await adapter.discover();
  const usable = candidates.find((c) => c.usable);
  if (!usable) {
    return {
      error: browserError(
        "executable_missing",
        `no usable ${kind} executable found (looked in standard install locations${process.env.BROWSER_PATH ? ` + BROWSER_PATH=${process.env.BROWSER_PATH}` : ""})`,
        { retryable: true, details: { candidates: candidates.length } },
      ),
    };
  }
  return { executable: usable };
}

export function getAdapter(kind: BrowserKind): BrowserAdapter {
  return kind === "chrome" ? new ChromeAdapter() : new FirefoxAdapter();
}

function openUserProcess(executable: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', fail);
    child.once('spawn', () => { child.unref(); done(); });
  });
}

/** Resolve the built extension output directory for a kind. Auto-detected from
 * the monorepo (packages/extension/.output/<wxt-target>) when BCP_EXTENSION_DIR
 * is unset. Returns null when the build output is missing (caller reports). */
export async function locateExtensionBuild(kind: BrowserKind): Promise<string | null> {
  if (process.env.BCP_EXTENSION_DIR) {
    return realpathSafe(resolve(process.env.BCP_EXTENSION_DIR));
  }
  const candidates: string[] = [];
  const cwd = process.cwd();
  // Common monorepo layouts: running from repo root or from packages/backend.
  for (const base of [cwd, resolve(cwd, ".."), resolve(cwd, "../..")]) {
    const out = join(base, "packages", "extension", ".output");
    candidates.push(
      join(out, kind === "chrome" ? "chrome-mv3" : "firefox-mv2"),
      join(out, kind === "chrome" ? "chrome-mv3-dev" : "firefox-mv2-dev"),
    );
  }
  for (const p of candidates) {
    const rp = await realpathSafe(p);
    if (!rp) continue;
    try {
      await access(join(rp, "manifest.json"));
      return rp;
    } catch {
      /* not a built extension dir */
    }
  }
  return null;
}
