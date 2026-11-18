/**
 * ProcessSupervisor — owns ONLY the managed child processes this backend
 * created and registered. No pkill -f, no port-kill, no fuzzy-name kill:
 * every stop verifies the process's start time (PID-reuse guard) before
 * signaling, and escalates SIGTERM → SIGKILL only for processes we proved we
 * own. User-owned browsers are never registered here.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LaunchedProcess } from "./browser-adapters.js";

const execFileP = promisify(execFile);

export interface ManagedProcess {
  pid: number;
  startTime: number;
  kind: "chrome" | "firefox";
  profileDir: string;
  command: string;
}

/** Read a process's start time via `ps -o lstart=` (macOS/Linux). Returns
 * epoch ms, or null when the process is gone / unreadable. The PID-reuse
 * guard's ground truth. */
export async function processStartTime(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileP("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 2_000 });
    const s = stdout.trim();
    if (!s) return null;
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

export async function processAlive(pid: number): Promise<boolean> {
  return (await processStartTime(pid)) !== null;
}

export class ProcessSupervisor {
  /** Processes THIS backend registered. Keyed by pid. */
  private readonly owned = new Map<number, ManagedProcess>();

  /** Register a process this backend spawned. */
  register(proc: LaunchedProcess, meta: Omit<ManagedProcess, "pid" | "startTime">): ManagedProcess {
    const managed: ManagedProcess = { pid: proc.pid, startTime: proc.startTime, ...meta };
    this.owned.set(proc.pid, managed);
    return managed;
  }

  /** Unregister (after a verified clean stop). */
  unregister(pid: number): void {
    this.owned.delete(pid);
  }

  /** All processes this backend currently claims. */
  list(): ManagedProcess[] {
    return [...this.owned.values()];
  }

  get(pid: number): ManagedProcess | undefined {
    return this.owned.get(pid);
  }

  /**
   * Stop a managed process with full ownership verification:
   *  - pid must be registered by THIS backend,
   *  - the process's CURRENT start time must match registration (PID reuse
   *    would change it → refuse, never kill an innocent process),
   *  - SIGTERM first, escalate to SIGKILL after `graceMs` (only for the
   *    verified-owned pid).
   */
  async stop(pid: number, graceMs = 5_000): Promise<void> {
    const managed = this.owned.get(pid);
    if (!managed) throw new Error(`stop_rejected: pid ${pid} is not a process this backend owns`);
    await this.signalIfOwned(pid, managed.startTime, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      const st = await processStartTime(pid);
      if (st === null) {
        this.owned.delete(pid);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    // Escalate — but re-verify ownership first (the pid may have been reused
    // during our wait; killing the replacement would be a foreign-process kill).
    await this.signalIfOwned(pid, managed.startTime, "SIGKILL");
    this.owned.delete(pid);
  }

  /** Verify current start-time matches `expectedStartTime`, then signal. */
  private async signalIfOwned(pid: number, expectedStartTime: number, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    const now = await processStartTime(pid);
    if (now === null) {
      // Already gone — clean.
      this.owned.delete(pid);
      return;
    }
    if (Math.abs(now - expectedStartTime) > 2_000) {
      throw new Error(
        `foreign_process: pid ${pid} start time ${now} ≠ registered ${expectedStartTime} — PID reused; refusing to signal ${signal}`,
      );
    }
    try {
      process.kill(pid, signal);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/ESRCH/.test(msg)) throw new Error(`stop_rejected: ${msg}`);
    }
  }

  /** Best-effort stop of everything owned (backend shutdown). Never throws. */
  async stopAll(graceMs = 3_000): Promise<void> {
    const pids = [...this.owned.keys()];
    for (const pid of pids) {
      try {
        await this.stop(pid, graceMs);
      } catch {
        /* best-effort at shutdown */
      }
    }
  }

  /** Spawn helper (used by the chrome adapter's launch). */
  static spawn(input: { executable: string; args: string[] }): Promise<LaunchedProcess> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(input.executable, input.args, { stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => {
        if (!child.pid) return reject(new Error("process did not spawn"));
        resolvePromise({ pid: child.pid, startTime: Date.now(), child });
      });
    });
  }
}
