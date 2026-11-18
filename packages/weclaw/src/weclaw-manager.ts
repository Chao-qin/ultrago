/**
 * WeclawManager — owns the weclaw child process.
 *
 * Lifecycle contract:
 *   start()   — spawns weclaw (idempotent), waits for /health to respond.
 *   stop()    — sends SIGTERM, escalates to SIGKILL after stopTimeoutMs.
 *   status()  — cheap probe, returns the bound account id (or null).
 *
 * The manager is the single source of truth for the sidecar's lifecycle; the
 * backend wires it in main() and shutdown().
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  statSync,
  lstatSync,
  openSync,
  closeSync,
  writeSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { config, PACKAGE_DIR } from "./config.js";
import { WecClient } from "./weclaw-client.js";

type Phase = "stopped" | "starting" | "running" | "stopping";

export interface WecStatus {
  phase: Phase;
  pid: number | null;
  apiUrl: string;
  binaryPath: string;
  binaryVersion: string | null;
  account: string | null;
  uptimeMs: number | null;
}

export class WeclawManager {
  private proc: ChildProcess | null = null;
  /** PID of the long-running daemon (not the launcher). Tracked separately because the
   *  launcher exits code 0 right after forking the daemon into the background. */
  private daemonPid: number | null = null;
  private phase: Phase = "stopped";
  private client: WecClient;
  private startedAt: number | null = null;
  private logFd: number | null = null;
  /** Rolling line buffer for the launcher's stdout, used to extract the daemon PID. */
  private stdoutBuf: string = "";

  constructor() {
    this.client = new WecClient(config.apiUrl);
  }

  /** Idempotent. Returns once the HTTP API is healthy. */
  async start(): Promise<WecStatus> {
    if (this.phase === "running") return this.status();
    if (this.phase === "starting") return this.waitUntilReady();
    if (this.phase === "stopping") {
      // wait for the previous shutdown before starting again
      await this.awaitPhase("stopped", 5_000);
    }
    if (config.disabled) {
      throw new Error("WECLAW_DISABLE=1 — refusing to start weclaw");
    }
    if (!this.binaryPresent()) {
      throw new Error(
        `weclaw binary not found at ${config.bin}. Run: pnpm --filter @bcp/weclaw install:bin`,
      );
    }

    // weclaw hardcodes ~/.weclaw/ — no CLI flag, no env var to override. To keep
    // its state project-local we ensure ~/.weclaw is a symlink to <pkg>/config.
    // Idempotent: no-op when the symlink already points at the right place.
    ensureConfigSymlink();

    this.phase = "starting";
    this.startedAt = Date.now();
    this.daemonPid = null;
    this.stdoutBuf = "";
    this.proc = this.spawnProc();
    this.attachExitHandler();

    try {
      await this.waitUntilReady();
      // If stdout parsing missed the daemon PID (race or older binary), try
      // `weclaw status` as a fallback so stop() has something to kill.
      if (this.daemonPid == null) {
        this.daemonPid = await this.lookupDaemonPid();
      }
      this.phase = "running";
      return this.status();
    } catch (e) {
      this.phase = "stopped";
      this.killProc("SIGTERM");
      throw e;
    }
  }

  /** Idempotent. Kills the daemon (not the launcher); escalates to SIGKILL. */
  async stop(): Promise<void> {
    if (this.phase === "stopped") return;
    this.phase = "stopping";

    // Try the daemon PID first — that's the long-running service.
    if (this.daemonPid != null && isProcessAlive(this.daemonPid)) {
      await this.killPid(this.daemonPid, "SIGTERM", config.stopTimeoutMs);
    } else if (this.proc && this.proc.exitCode === null) {
      // No daemon PID (parsing failed and the launcher is somehow still alive).
      this.killProc("SIGTERM");
      const start = Date.now();
      while (Date.now() - start < config.stopTimeoutMs) {
        if (!this.proc || this.proc.exitCode !== null) break;
        await sleep(50);
      }
      this.killProc("SIGKILL");
    } else {
      // Last resort: ask weclaw itself to stop.
      try {
        execFileSync(config.bin, ["stop"], { encoding: "utf8", timeout: 5_000 });
      } catch (e) {
        console.warn(`[wec] weclaw stop subcommand failed: ${e}`);
      }
    }

    if (this.logFd !== null) {
      try {
        closeSync(this.logFd);
      } catch {
        /* ignore */
      }
      this.logFd = null;
    }
    this.proc = null;
    this.daemonPid = null;
    this.phase = "stopped";
    this.startedAt = null;
  }

  /** Lightweight probe. */
  status(): WecStatus {
    let version: string | null = null;
    try {
      version = execFileSync(config.bin, ["version"], { encoding: "utf8", timeout: 2_000 }).trim();
    } catch {
      /* binary missing / non-exec */
    }
    return {
      phase: this.phase,
      // Daemon PID takes precedence over the (already-exited) launcher PID.
      pid: this.daemonPid ?? this.proc?.pid ?? null,
      apiUrl: config.apiUrl,
      binaryPath: config.bin,
      binaryVersion: version,
      account: this.readBoundAccount(),
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : null,
    };
  }

  // ── The process-agnostic half ───────────────────────────────────────────
  // These two carry no per-process state: `api` talks to weclaw's own loopback
  // listener over HTTP, `defaultRecipient` re-reads user.json on every access.
  // They are correct in ANY process. Everything above — start/stop/status and
  // the phase/pid/uptime they read — is the process-owned half and means
  // nothing outside the process that spawned the daemon. See getManager().

  /** Client is safe to use as soon as start() resolves (in the owning process). */
  get api(): WecClient {
    return this.client;
  }

  /** User-configured recipient used when an MCP caller omits `to`. */
  get defaultRecipient(): string | undefined {
    return config.defaultRecipient;
  }

  // ─── private ──────────────────────────────────────────────────────────────

  private spawnProc(): ChildProcess {
    const logPath = path.join(config.configDir, "weclaw.log");
    this.logFd = openSync(logPath, "a");
    // Prepend the package scripts dir so weclaw's exec.LookPath resolves
    // bare-name agent commands (e.g. `weclaw-noop.sh`) — this keeps config.json
    // free of machine-specific absolute paths; external tools (claude/opencode)
    // resolve from the inherited user PATH.
    const scriptsDir = path.join(PACKAGE_DIR, "scripts");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WECLAW_API_ADDR: config.apiAddr,
      PATH: `${scriptsDir}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    // stdout is piped (not redirected) so we can scan for the daemon PID line.
    // stderr still goes to the log file directly.
    const proc = spawn(config.bin, ["start"], {
      stdio: ["ignore", "pipe", this.logFd],
      env,
      detached: false,
      // Bare argv0, like a PATH invocation: weclaw's runDaemon() sweeps stale
      // processes with `pkill -f "<abs-exe> start"` before daemonizing. With
      // an absolute argv[0] the launcher's own cmdline matches that pattern
      // and pkill SIGTERMs its caller — the launcher dies silently before it
      // can daemonize. The daemon itself is re-exec'd with the absolute path
      // (os.Executable()), so the sweep still catches real stale daemons.
      argv0: "weclaw",
    });
    if (proc.stdout) {
      proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        // Tee to the log file so the on-disk log still has the launcher output.
        if (this.logFd !== null) {
          try {
            writeSync(this.logFd, text);
          } catch {
            /* log file closed mid-shutdown */
          }
        }
        this.stdoutBuf += text;
        // Extract daemon PID from the launcher's "started in background" line.
        if (this.daemonPid == null) {
          const m = this.stdoutBuf.match(/weclaw started in background \(pid=(\d+)\)/);
          if (m) {
            this.daemonPid = parseInt(m[1]!, 10);
            console.log(`[wec] daemon pid=${this.daemonPid} (from launcher stdout)`);
            // Clear the buffer once we've found what we need.
            this.stdoutBuf = "";
          }
        }
        // Keep the buffer bounded — 4 KB is plenty for a single status line.
        if (this.stdoutBuf.length > 4096) {
          this.stdoutBuf = this.stdoutBuf.slice(-4096);
        }
      });
    }
    console.log(`[wec] spawned pid=${proc.pid} bin=${config.bin}`);
    return proc;
  }

  private attachExitHandler(): void {
    if (!this.proc) return;
    this.proc.on("exit", (code, signal) => {
      const clean = code === 0 && signal === null;
      if (this.phase === "stopping") {
        console.log(`[wec] launcher exited (code=${code} signal=${signal})`);
      } else if (clean && this.daemonPid != null) {
        // weclaw start daemonizes: the launcher exits code 0 after forking
        // the daemon. This is the normal happy path, not an error.
        console.log(`[wec] daemonized (daemon pid=${this.daemonPid})`);
      } else if (clean) {
        // Clean exit but we never saw a daemon PID — could be a quick restart
        // or a version that doesn't print the line. Not a panic-worthy event.
        console.log(
          `[wec] launcher exited cleanly (code=0) but daemon pid unknown; phase=${this.phase}`,
        );
      } else {
        console.warn(
          `[wec] unexpected exit (code=${code} signal=${signal}); phase=${this.phase}`,
        );
      }
      // The launcher proc is gone. Keep daemonPid so status()/stop() still work
      // as long as the daemon is alive.
      this.proc = null;
      // Only flip to "stopped" if we're not still in the happy startup path
      // (i.e. we don't have a daemon to talk to).
      if (this.phase === "stopping" || this.daemonPid == null) {
        this.phase = "stopped";
      }
    });
  }

  private killProc(signal: NodeJS.Signals): void {
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  /** Send `signal` to `pid` and wait up to `timeoutMs` for it to exit, then SIGKILL. */
  private async killPid(pid: number, signal: NodeJS.Signals, timeoutMs: number): Promise<void> {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
      return;
    }
    const start = Date.now();
    while (isProcessAlive(pid) && Date.now() - start < timeoutMs) {
      await sleep(50);
    }
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  private async lookupDaemonPid(): Promise<number | null> {
    try {
      const out = execFileSync(config.bin, ["status"], {
        encoding: "utf8",
        timeout: 2_000,
      }).trim();
      const m = out.match(/pid=(\d+)/);
      if (m) {
        const pid = parseInt(m[1]!, 10);
        console.log(`[wec] daemon pid=${pid} (from weclaw status)`);
        return pid;
      }
    } catch {
      /* ignore — daemonPid stays null and stop() falls back to `weclaw stop` */
    }
    return null;
  }

  private async waitUntilReady(): Promise<WecStatus> {
    const start = Date.now();
    let lastErr: unknown = null;
    while (Date.now() - start < config.startTimeoutMs) {
      try {
        await this.client.health();
        return this.status();
      } catch (e) {
        lastErr = e;
      }
      await sleep(200);
    }
    throw new Error(
      `weclaw API not ready after ${config.startTimeoutMs}ms (last error: ${String(lastErr)})`,
    );
  }

  private async awaitPhase(target: Phase, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (this.phase !== target && Date.now() - start < timeoutMs) {
      await sleep(50);
    }
  }

  private binaryPresent(): boolean {
    if (!existsSync(config.bin)) return false;
    try {
      const st = statSync(config.bin);
      return st.isFile();
    } catch {
      return false;
    }
  }

  /** Read the first account id from <configDir>/accounts/*.json (filenames are stable). */
  private readBoundAccount(): string | null {
    try {
      const dir = path.join(config.configDir, "accounts");
      if (!existsSync(dir)) return null;
      const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".sync.json"));
      if (files.length === 0) return null;
      const first = files[0]!;
      const raw = readFileSync(path.join(dir, first), "utf8");
      const obj = JSON.parse(raw) as { id?: string };
      return obj.id ?? first.replace(/-im-bot\.json$/, "@im.bot");
    } catch {
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure `~/.weclaw` is a symlink to <package>/config. weclaw (the binary)
 * hardcodes ~/.weclaw/ with no override; symlinking is the only way to keep
 * its state project-local without forking.
 *
 * On first run with an existing real ~/.weclaw directory, the directory is
 * moved aside (timestamped backup at ~/.weclaw.bak-<ts>) and replaced with
 * a symlink to the project config.
 *
 * Module-level (not a manager method) because the pre-flight login gate must
 * run it BEFORE any manager exists — a login that lands in a real ~/.weclaw
 * would be orphaned by this very backup-and-replace on the next start.
 */
export function ensureConfigSymlink(): void {
  const home = process.env.HOME;
  if (!home) {
    console.warn("[wec] $HOME not set; cannot manage ~/.weclaw symlink");
    return;
  }
  const linkPath = path.join(home, ".weclaw");
  const target = config.configDir;

  // lstat (not stat/existsSync): both follow symlinks, so a healthy link would
  // read as a directory ("backed up" on every start) and a dangling link would
  // read as absent (symlinkSync would then throw EEXIST).
  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(linkPath);
  } catch {
    /* nothing at ~/.weclaw — fall through to create the link */
  }
  if (st) {
    if (st.isSymbolicLink()) {
      const real = readlinkSync(linkPath);
      if (path.resolve(real) === path.resolve(target)) return;
      // Wrong target — replace.
      unlinkSync(linkPath);
    } else if (st.isDirectory()) {
      // Real directory: back it up so the user's existing weclaw state survives.
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const backup = `${linkPath}.bak-${ts}`;
      console.warn(`[wec] backing up ${linkPath} -> ${backup}`);
      renameSync(linkPath, backup);
    } else {
      // Strange (file, socket, etc). Just remove so we can create the symlink.
      unlinkSync(linkPath);
    }
  }

  symlinkSync(target, linkPath, "dir");
  console.log(`[wec] linked ${linkPath} -> ${target}`);
}

/**
 * Singleton-ish factory. PER-PROCESS: `_instance` is module state, so every OS
 * process that imports this gets its OWN manager, with its own `phase` /
 * `daemonPid` / `startedAt`. Only the process that called `start()` owns the
 * daemon. In any other process those three stay at their initial values and
 * `status()` reports `phase:"stopped", pid:null, uptimeMs:null` for a daemon
 * that is in fact running — and, worse, the `apiUrl` / `binaryPath` /
 * `binaryVersion` / `account` fields of that same object ARE correct (they read
 * config, disk and the binary), so the false half looks corroborated.
 *
 * Rule: only the process that spawns weclaw — packages/backend/src/index.ts —
 * may call getManager(). Everything else wants the process-agnostic pieces,
 * `WecClient` + `config`, and should import those directly — as
 * delivery-executor.ts in the console does. (check-session.ts and
 * ensure-login.ts import `config` alone; they need no client.)
 *
 * A cross-process status RPC was considered and rejected: no caller outside the
 * backend needs weclaw status, and the one that does — the `wec_status` MCP
 * tool in weclaw-mcp.ts — already runs in the owning process.
 */
let _instance: WeclawManager | null = null;
export function getManager(): WeclawManager {
  if (!_instance) _instance = new WeclawManager();
  return _instance;
}
