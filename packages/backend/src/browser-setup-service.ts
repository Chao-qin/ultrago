/**
 * BrowserSetupService — instance directories, extension artifacts, launch/stop,
 * handshake waiting, state and ownership. The ONLY component that starts or
 * stops browsers; everything else (MCP/Console/CLI) talks to it through the
 * dispatcher or the internal HTTP surface.
 *
 * Key invariants (spec §8):
 *  - instanceId is format-validated BEFORE path join (traversal guard).
 *  - managed artifacts + profiles live under <browserRoot>/ and are backend-owned.
 *  - one concurrent setup operation per instanceId (shared operation, one launch).
 *  - user instances are never stopped/adopted/killed by the backend.
 *  - managed Firefox fails as `unsupported` BEFORE any process is created.
 */
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  browserError,
  browserLabel,
  isValidInstanceId,
  type BrowserError,
  type BrowserErrorCode,
  type BrowserExecutableCandidate,
  type BrowserProbe,
  type BrowserProfileMode,
  type BrowserReadiness,
  type BrowserSelector,
  type BrowserSetupRequest,
  type BrowserSetupResult,
  type BrowserStatus,
  type BrowserStatusResponse,
  type BrowserTarget,
  type ExtensionRuntimeConfig,
  type ManagedManifest,
  type ReadyBrowser,
} from "@bcp/shared";
import { config } from "./config.js";
import { WsServer } from "./ws-server.js";
import { getAdapter, locateExtensionBuild, pickExecutable, discoverAll } from "./browser-adapters.js";
import { ProcessSupervisor, processAlive, processStartTime } from "./process-supervisor.js";

const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 5 * 60_000;
/** User-mode grace window: how long to wait for an already-installed extension
 * to handshake BEFORE opening the install guide. Long enough for a running
 * browser's service worker to boot + reconnect; short enough that a genuinely
 * missing extension reaches the guide quickly. */
const GUIDE_GRACE_MS = 4_000;

/** Full state of one configured target instance. */
interface InstanceState {
  target: BrowserTarget;
  mode: BrowserProfileMode;
  readiness: BrowserReadiness;
  executable?: BrowserExecutableCandidate;
  pid?: number;
  profileDir?: string;
  artifactDir?: string;
  artifactHash?: string;
  lastError?: BrowserError;
  checkedAt: number;
}

export class BrowserSetupService {
  private readonly instances = new Map<string, InstanceState>();
  /** instanceId -> in-flight setup promise (concurrent dedupe). */
  private readonly operations = new Map<string, Promise<BrowserSetupResult>>();
  private readonly supervisor = new ProcessSupervisor();

  constructor(private readonly ws: WsServer) {
    // Backend start: reconcile the managed root once (async, non-blocking).
    void this.reconcileRoot().catch((e) =>
      console.warn("[browsers] reconcile failed:", e instanceof Error ? e.message : String(e)),
    );
  }

  get supervisorRef(): ProcessSupervisor {
    return this.supervisor;
  }

  /* ----------------------------- public surface ----------------------------- */

  /** Configured instance state (may exist without a live session). */
  stateOf(target: BrowserTarget): BrowserStatus | undefined {
    const s = this.instances.get(target.instanceId);
    if (!s) return undefined;
    return this.toStatus(s);
  }

  /** Resolve an instance's remembered profile mode (default "user" — never
   * guess-manage an unconfigured target). */
  profileModeOf(target: BrowserTarget): BrowserProfileMode {
    return this.instances.get(target.instanceId)?.mode ?? "user";
  }

  async status(selector?: BrowserSelector): Promise<BrowserStatusResponse> {
    const candidates = await discoverAll();
    let instances = [...this.instances.values()].map((s) => this.toStatus(s));
    if (selector?.kind) instances = instances.filter((i) => i.instance.target.kind === selector.kind);
    if (selector?.instanceId) instances = instances.filter((i) => i.instance.target.instanceId === selector.instanceId);
    return { defaultTarget: this.ws.current() ?? undefined, candidates, instances };
  }

  /**
   * Ensure a target is ready to serve ordinary browser RPCs: an authenticated
   * session that passed the bootstrap probe. If the instance isn't connected
   * yet, run a setup (user mode by default for an unconfigured target) and
   * wait for the ready ack. Returns ReadyBrowser or a structured failure.
   */
  async ensureBrowserReady(target: BrowserTarget, options?: { timeoutMs?: number }): Promise<ReadyBrowser> {
    const timeoutMs = clampWait(options?.timeoutMs);
    if (this.ws.isReady(target)) {
      const probe = await this.bootstrapProbe(target);
      if (!probe.ok) throw this.err("browser_probe_failed", `bootstrap probe failed for ${browserLabel(target)}: ${probe.error?.message ?? "unknown"}`, true);
      return { target, status: this.statusOf(target), probe };
    }
    const mode = this.profileModeOf(target);
    const result = await this.setup({ kind: target.kind, mode, instanceId: target.instanceId, waitMs: timeoutMs });
    if (result.ready && result.status.probe?.ok) {
      return { target, status: result.status, probe: result.status.probe };
    }
    throw this.err(
      result.status.readiness === "waiting_extension" ? "extension_timeout" : "browser_unavailable",
      `browser ${browserLabel(target)} not ready (${result.status.readiness})${result.status.lastError ? `: ${result.status.lastError.message}` : ""}`,
      true,
    );
  }

  /**
   * Setup (start/reuse + handshake wait) for a target. Concurrent calls for
   * the SAME instanceId share one operation — only one launch action ever runs.
   */
  async setup(request: BrowserSetupRequest): Promise<BrowserSetupResult> {
    const kind = request.kind;
    const instanceId = request.instanceId ?? randomUUID();
    if (!isValidInstanceId(instanceId)) {
      throw this.err("profile_invalid", `invalid instanceId ${JSON.stringify(instanceId)}`, false);
    }
    const target: BrowserTarget = { kind, instanceId };
    const waitMs = clampWait(request.waitMs);
    const existing = this.operations.get(instanceId);
    if (existing) return existing;

    const op = this.runSetup(target, request.mode ?? "user", waitMs).finally(() => {
      this.operations.delete(instanceId);
    });
    this.operations.set(instanceId, op);
    return op;
  }

  /** The only controlled probe path: list_windows + list_tabs on an already
   * authenticated session. Must NOT recurse into dispatch/ensure. */
  async bootstrapProbe(target: BrowserTarget): Promise<BrowserProbe> {
    const st = this.instances.get(target.instanceId);
    if (!this.ws.isReady(target)) {
      return { windows: 0, tabs: 0, ok: false, error: browserError("browser_unavailable", `no authenticated session for ${browserLabel(target)}`, { retryable: true }) };
    }
    try {
      const [{ windows }, { tabs }] = await Promise.all([
        this.ws.callBrowser<{ windows: unknown[] }>("browser.listWindows", {}, target),
        this.ws.callBrowser<{ tabs: unknown[] }>("browser.listTabs", {}, target),
      ]);
      const probe: BrowserProbe = { windows: windows.length, tabs: tabs.length, ok: true };
      if (st) {
        st.readiness = "connected";
        st.checkedAt = Date.now();
        st.lastError = undefined;
      }
      return probe;
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      if (st) {
        st.readiness = "browser_probe_failed";
        st.lastError = browserError("browser_probe_failed", err, { retryable: true });
        st.checkedAt = Date.now();
      }
      return { windows: 0, tabs: 0, ok: false, error: browserError("browser_probe_failed", err, { retryable: true }) };
    }
  }

  /** Stop a MANAGED instance the backend owns. User targets / foreign
   * processes / stale PIDs are all refused. */
  async stop(target: BrowserTarget): Promise<BrowserStatus> {
    const st = this.instances.get(target.instanceId);
    if (!st || st.mode !== "managed") {
      throw this.err("stop_rejected", `target ${browserLabel(target)} is not a backend-managed instance — user instances are never stopped by the backend`, false);
    }
    if (st.readiness === "stopped" || st.readiness === "not_configured") return this.toStatus(st);
    if (st.pid != null) {
      try {
        await this.supervisor.stop(st.pid);
      } catch (e) {
        // A process that is already gone (ESRCH) is a clean stop, not an error.
        const msg = e instanceof Error ? e.message : String(e);
        if (!/already gone|ESRCH|not a process this backend owns/.test(msg)) throw e;
      }
      st.pid = undefined;
    }
    st.readiness = "stopped";
    st.checkedAt = Date.now();
    await this.cleanupManaged(target);
    return this.toStatus(st);
  }

  async close(): Promise<void> {
    await this.supervisor.stopAll();
  }

  /* ----------------------------- setup internals ----------------------------- */

  private async runSetup(target: BrowserTarget, mode: BrowserProfileMode, waitMs: number): Promise<BrowserSetupResult> {
    const operationId = randomUUID();
    const st = this.ensureState(target, mode);

    // Fast path: already connected + probed.
    if (this.ws.isReady(target)) {
      const probe = await this.bootstrapProbe(target);
      st.readiness = probe.ok ? "connected" : "browser_probe_failed";
      st.checkedAt = Date.now();
      return { target, status: this.toStatus(st), ready: probe.ok, operationId };
    }

    // Firefox managed is a hard no BEFORE any process/artifact work.
    if (target.kind === "firefox" && mode === "managed") {
      st.readiness = "unsupported";
      st.lastError = this.err("unsupported", "firefox managed profiles are not supported (phase 1: user mode only)", false);
      st.checkedAt = Date.now();
      return { target, status: this.toStatus(st), ready: false, operationId };
    }

    try {
      // 1. Executable.
      const picked = await pickExecutable(target.kind);
      if (!picked.executable) {
        st.readiness = "executable_missing";
        st.lastError = picked.error;
        st.checkedAt = Date.now();
        return { target, status: this.toStatus(st), ready: false, operationId };
      }
      st.executable = picked.executable;
      st.readiness = "starting";
      st.checkedAt = Date.now();

      // 2. Artifact (built extension + runtime config). User mode opens it for
      //    the user to Load unpacked; managed mode launches with --load-extension.
      const artifact = await this.buildArtifact(target);
      st.artifactDir = artifact.directory;
      st.artifactHash = artifact.artifactHash;

      // 3. Launch / open.
      if (mode === "managed") {
        await this.launchManaged(st, artifact.directory);
      } else {
        st.readiness = "waiting_extension";
        st.checkedAt = Date.now();
        // USER MODE: open the browser NORMALLY first (launch if closed, focus
        // if running — no navigation). Give an already-installed extension a
        // short grace window to complete the handshake; only if NOTHING
        // connected in that window do we open the install guide
        // (chrome://extensions + artifact reveal). The guide is for first-time
        // installs — re-opening it on every setup of a working profile would
        // be disruptive noise.
        const adapter = getAdapter(target.kind);
        try {
          await adapter.openBrowser({ executable: st.executable!.path });
        } catch (e) {
          console.warn(
            `[browsers] open browser failed for ${browserLabel(target)}: ${e instanceof Error ? e.message : String(e)} — waiting for a manual ready ack instead`,
          );
        }
        const graceMs = Math.min(GUIDE_GRACE_MS, waitMs);
        const earlyReady = await this.waitReady(target, graceMs);
        if (!earlyReady) await this.openUserGuide(st, artifact.directory);
        const ready = earlyReady || await this.waitReady(target, Math.max(0, waitMs - graceMs));
        if (!ready) {
          st.readiness = "waiting_extension";
          st.checkedAt = Date.now();
          return { target, status: this.toStatus(st), ready: false, operationId };
        }
        const probe = await this.bootstrapProbe(target);
        st.readiness = probe.ok ? "connected" : "browser_probe_failed";
        st.checkedAt = Date.now();
        return { target, status: this.toStatus(st), ready: probe.ok, operationId };
      }

      // 4. Wait for the ready ack (hello → welcome → ready). Managed path only
      // (user mode handled above so the guide can be gated on the grace window).
      const ready = await this.waitReady(target, waitMs);
      if (!ready) {
        st.readiness = "waiting_extension";
        st.checkedAt = Date.now();
        return { target, status: this.toStatus(st), ready: false, operationId };
      }
      const probe = await this.bootstrapProbe(target);
      st.readiness = probe.ok ? "connected" : "browser_probe_failed";
      st.checkedAt = Date.now();
      return { target, status: this.toStatus(st), ready: probe.ok, operationId };
    } catch (e) {
      const err = this.normalizeError(e);
      st.readiness = "failed";
      st.lastError = err;
      st.checkedAt = Date.now();
      // A failed managed launch leaves no supervised process behind.
      if (st.pid != null) {
        try { await this.supervisor.stop(st.pid); } catch { /* best-effort */ }
        st.pid = undefined;
      }
      return { target, status: this.toStatus(st), ready: false, operationId };
    }
  }

  private ensureState(target: BrowserTarget, mode: BrowserProfileMode): InstanceState {
    let st = this.instances.get(target.instanceId);
    if (!st) {
      st = { target, mode, readiness: "not_configured", checkedAt: Date.now() };
      this.instances.set(target.instanceId, st);
    } else {
      st.mode = mode;
    }
    return st;
  }

  private async waitReady(target: BrowserTarget, waitMs: number): Promise<boolean> {
    try {
      await this.ws.waitForReady(target, waitMs);
      return true;
    } catch {
      return false;
    }
  }

  /** User mode: open the browser + install guide, reveal the artifact dir.
   * The backend never claims the user's browser process. A guide-open failure
   * is logged but does NOT fail the setup — the user may still install
   * manually and the ready ack decides the outcome. */
  private async openUserGuide(st: InstanceState, artifactDir: string): Promise<void> {
    const exe = st.executable!.path;
    const adapter = getAdapter(st.target.kind);
    try {
      await adapter.openInstallGuide({ executable: exe, artifactDir });
    } catch (e) {
      console.warn(
        `[browsers] install guide open failed for ${browserLabel(st.target)}: ${e instanceof Error ? e.message : String(e)} — waiting for a manual ready ack instead`,
      );
    }
  }

  /** Managed mode: dedicated profile + supervised launch. */
  private async launchManaged(st: InstanceState, artifactDir: string): Promise<void> {
    const target = st.target;
    const profileDir = await this.prepareManagedProfile(target);
    st.profileDir = profileDir;

    const adapter = getAdapter(target.kind);
    const args = adapter.buildLaunchArgs({ mode: "managed", profileDir, artifactDir });
    const launched = await adapter.launch({ executable: st.executable!.path, args });
    const managed = this.supervisor.register(launched, {
      kind: target.kind,
      profileDir,
      command: `${st.executable!.path} ${args.join(" ")}`,
    });
    st.pid = managed.pid;
    st.profileDir = profileDir;
    st.readiness = "waiting_extension";
    st.checkedAt = Date.now();
    await this.writeManifest(target, profileDir, st.artifactHash!, managed.pid, launched.startTime);
    // Watch for an early crash so status reflects reality.
    const child = launched.child as { on?: (ev: string, cb: () => void) => void } | undefined;
    child?.on?.("exit", () => {
      if (st.pid === managed.pid && !this.ws.isReady(target)) {
        st.readiness = "crashed";
        st.checkedAt = Date.now();
      }
    });
  }

  /** Validate + create a managed profile dir (canonical realpath'd location)
   * and its atomic lock. The root is realpath'd first and the profile path is
   * BUILT FROM THE CANONICAL ROOT — this matters on macOS, where /tmp is a
   * symlink to /private/tmp and a raw-path prefix check would false-reject.
   * An existing profileDir that is a SYMLINK is refused. Returns the canonical
   * profile dir. */
  private async prepareManagedProfile(target: BrowserTarget): Promise<string> {
    const root = config.browserRoot;
    await mkdir(root, { recursive: true });
    const rootReal = await realpath(root);
    const profileDir = join(rootReal, "profiles", target.instanceId);
    const lockPath = join(profileDir, ".lock");
    // The dir must not be a symlink BEFORE we write through it.
    const st = await lstat(profileDir).catch(() => null);
    if (st) {
      if (st.isSymbolicLink()) {
        throw this.err("profile_invalid", `managed profile ${profileDir} is a symlink — refusing`, false);
      }
      if (!st.isDirectory()) {
        throw this.err("profile_invalid", `managed profile ${profileDir} is not a directory`, false);
      }
    } else {
      await mkdir(profileDir, { recursive: true });
    }
    // Atomic lock: fail if the lock file already exists (another backend owns
    // this profile, or a stale lock survives a crash — reconciled at boot).
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        const manifest = await this.readManifestSafe(target);
        throw manifest
          ? this.err("ownership_conflict", `profile ${profileDir} is locked (owner ${manifest.ownerId}, backendPid ${manifest.backendPid})`, false)
          : this.err("profile_locked", `profile ${profileDir} is locked and has no manifest — remove it manually or restart the backend to reconcile`, false);
      }
      throw this.err("profile_invalid", `cannot create profile lock: ${e instanceof Error ? e.message : String(e)}`, false);
    }
    return profileDir;
  }

  private async writeManifest(target: BrowserTarget, profileDir: string, artifactHash: string, browserPid: number, browserStartTime: number): Promise<void> {
    const manifest: ManagedManifest = {
      ownerId: "bcp-backend",
      backendPid: process.pid,
      backendStartTime: processStartMs,
      browserPid,
      browserStartTime,
      target,
      profileDir,
      artifactHash,
      createdAt: Date.now(),
    };
    await writeFile(join(profileDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  }

  private async readManifestSafe(target: BrowserTarget): Promise<ManagedManifest | null> {
    try {
      const raw = await readFile(join(config.browserRoot, "profiles", target.instanceId, "manifest.json"), "utf8");
      return JSON.parse(raw) as ManagedManifest;
    } catch {
      return null;
    }
  }

  private async cleanupManaged(target: BrowserTarget): Promise<void> {
    const profileDir = join(config.browserRoot, "profiles", target.instanceId);
    try {
      await rm(join(profileDir, ".lock"), { force: true });
      await rm(join(profileDir, "manifest.json"), { force: true });
    } catch {
      /* best-effort */
    }
    // Artifacts are content-hashed and reused across restarts — leave them.
  }

  /* ----------------------------- artifacts ----------------------------- */

  /** Build (or reuse) the target-specific artifact: copy the built extension,
   * inject runtime-config.json, hash manifest + bundle + config. */
  private async buildArtifact(target: BrowserTarget): Promise<{ directory: string; artifactHash: string }> {
    const source = await locateExtensionBuild(target.kind);
    if (!source) {
      throw this.err(
        "artifact_mismatch",
        `no built ${target.kind} extension found — build it first (pnpm --filter @bcp/extension build${target.kind === "firefox" ? " build:firefox" : ""}) or set BCP_EXTENSION_DIR`,
        false,
        { source: config.extensionDir || "auto" },
      );
    }
    // Hash the base bundle FIRST (runtime config depends on the hash).
    const baseHash = await hashDir(source);
    const artifactDir = join(config.browserRoot, "artifacts", target.kind, target.instanceId, baseHash);
    const runtimePath = join(artifactDir, "runtime-config.json");
    const runtime: ExtensionRuntimeConfig = {
      backendUrl: `ws://${config.host}:${this.ws.boundPort}`,
      token: config.token,
      browser: target.kind,
      instanceId: target.instanceId,
      artifactHash: baseHash,
    };
    const exists = await fileExists(join(artifactDir, "manifest.json"));
    if (!exists) {
      await mkdir(artifactDir, { recursive: true });
      await cp(source, artifactDir, { recursive: true, force: true });
    }
    await writeFile(runtimePath, JSON.stringify(runtime, null, 2), "utf8");
    // Return the CANONICAL directory: Chrome resolves /tmp → /private/tmp on
    // macOS, and --disable-extensions-except compares exact paths — a raw-path
    // mismatch silently disables the very extension we just loaded.
    const canonical = await realpath(artifactDir);
    return { directory: canonical, artifactHash: baseHash };
  }

  /* ----------------------------- reconcile at boot ----------------------------- */

  /** Scan the backend-owned root at startup: reclaim profiles whose owner
   * backend died and whose managed browser is also gone; adopt a still-running
   * managed browser ONLY when pid/startTime/profileDir/artifactHash all match
   * the manifest; refuse everything else (foreign_process). */
  private async reconcileRoot(): Promise<void> {
    const root = config.browserRoot;
    let entries: string[];
    try {
      await mkdir(root, { recursive: true });
      const rootReal = await realpath(root);
      entries = await readdir(join(rootReal, "profiles"), { withFileTypes: true }).then((e) => e.map((d) => d.name));
    } catch {
      return; // no root yet — nothing to reconcile
    }
    for (const id of entries) {
      if (!isValidInstanceId(id)) continue;
      let manifest: ManagedManifest | null = null;
      try {
        manifest = JSON.parse(await readFile(join(root, "profiles", id, "manifest.json"), "utf8")) as ManagedManifest;
      } catch {
        continue;
      }
      const ownerAlive = await processAlive(manifest.backendPid);
      const browserAlive = manifest.browserPid != null && (await processAlive(manifest.browserPid));
      if (ownerAlive) {
        continue; // a live backend owns this profile — never touch it
      }
      if (!browserAlive) {
        // Owner dead + browser dead → reclaim lock/profile.
        await rm(join(root, "profiles", id, ".lock"), { force: true });
        console.log(`[browsers] reclaimed stale profile ${id} (owner ${manifest.backendPid} gone, browser gone)`);
        continue;
      }
      // Owner dead but a browser process is alive. Adopt ONLY on full match.
      const startTime = await processStartTime(manifest.browserPid!);
      const expectedProfile = join(root, "profiles", id);
      const matches =
        manifest.browserStartTime != null &&
        startTime != null &&
        Math.abs(startTime - manifest.browserStartTime) < 10_000 &&
        // Compare against BOTH the raw and the canonical profile path — on
        // macOS /tmp is a symlink to /private/tmp, and a restart may resolve
        // the root either way.
        (manifest.profileDir === expectedProfile || manifest.profileDir === join(await realpath(root), "profiles", id)) &&
        manifest.target.instanceId === id;
      if (matches) {
        const st: InstanceState = {
          target: manifest.target,
          mode: "managed",
          readiness: "waiting_extension",
          pid: manifest.browserPid,
          profileDir: manifest.profileDir,
          artifactHash: manifest.artifactHash,
          checkedAt: Date.now(),
        };
        this.instances.set(id, st);
        this.supervisor.register({ pid: manifest.browserPid!, startTime: manifest.browserStartTime! }, {
          kind: manifest.target.kind,
          profileDir: manifest.profileDir,
          command: `adopted:${manifest.profileDir}`,
        });
        console.log(`[browsers] adopted managed browser ${id} (pid ${manifest.browserPid}) from dead owner ${manifest.backendPid}`);
      } else {
        const st: InstanceState = {
          target: manifest.target,
          mode: "managed",
          readiness: "failed",
          lastError: this.err("foreign_process", `profile ${id} has a live browser that does not match its manifest (owner ${manifest.backendPid} is gone) — refusing to adopt`, false),
          checkedAt: Date.now(),
        };
        this.instances.set(id, st);
        console.warn(`[browsers] foreign process refused: profile ${id}, pid ${manifest.browserPid}`);
      }
    }
  }

  /* ----------------------------- status shaping ----------------------------- */

  private toStatus(st: InstanceState): BrowserStatus {
    const status: BrowserStatus = {
      instance: { target: st.target, profileMode: st.mode },
      readiness: st.readiness,
      checkedAt: st.checkedAt,
    };
    if (st.executable) status.executable = st.executable;
    if (st.pid != null) status.pid = st.pid;
    if (st.profileDir) status.profileDir = st.profileDir;
    const ext = this.ws.extensionInfo(st.target);
    if (ext) status.extension = ext;
    if (st.artifactHash) {
      status.extension = { ...(status.extension ?? { connected: false }), artifactHash: st.artifactHash };
    }
    if (st.lastError) status.lastError = st.lastError;
    // Live probe evidence only when connected.
    if (st.readiness === "connected" && this.ws.isReady(st.target)) {
      status.probe = { ok: true };
    }
    return status;
  }

  private statusOf(target: BrowserTarget): BrowserStatus {
    return this.toStatus(this.instances.get(target.instanceId) ?? {
      target,
      mode: this.profileModeOf(target),
      readiness: "not_configured",
      checkedAt: Date.now(),
    });
  }

  private err(code: BrowserErrorCode, message: string, retryable: boolean, details?: Record<string, string | number | boolean>): BrowserError {
    return browserError(code, message, { retryable, details });
  }

  private normalizeError(e: unknown): BrowserError {
    if (e && typeof e === "object" && "code" in e && typeof (e as BrowserError).code === "string" && "message" in e) {
      return e as BrowserError;
    }
    return this.err("internal_error", e instanceof Error ? e.message : String(e), false);
  }
}

/* ----------------------------- module helpers ----------------------------- */

const processStartMs = Date.now();

function clampWait(ms: number | undefined): number {
  if (ms == null || !Number.isFinite(ms)) return DEFAULT_WAIT_MS;
  return Math.min(Math.max(Math.floor(ms), 1_000), MAX_WAIT_MS);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** sha256 over every file's content under `dir`, sorted by relative path.
 * Runtime config is written AFTER hashing so the hash is stable. */
async function hashDir(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (rel: string): Promise<void> => {
    const abs = join(dir, rel);
    const st = await lstat(abs);
    if (st.isDirectory()) {
      const names = (await readdir(abs)).sort();
      for (const n of names) await walk(join(rel, n));
    } else if (st.isSymbolicLink()) {
      hash.update(`L:${rel}:${await readlink(abs)}`);
    } else if (st.isFile()) {
      hash.update(`F:${rel}`);
      hash.update(await readFile(abs));
    }
  };
  await walk("");
  return hash.digest("hex").slice(0, 24);
}
