import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MONOREPO_ROOT, type ScriptEntry } from "./script-registry.js";

/** Where a DETACHED script's output goes. Repo root, gitignored, and a single
 *  rolling file rather than one per run: the whole point of the detached path
 *  is that the console is about to die, so nothing in memory survives to tell
 *  us which file to look at afterwards. A fixed name is findable by the next
 *  process to boot. */
const DETACHED_LOG = ".console-script.log";
/** Lines kept per attached run. Oldest go first, and the count of what went is
 *  reported — a build log that silently starts at line 4001 reads like the
 *  build started there. */
const MAX_LINES = 4000;
/** Finished runs kept for inspection. */
const MAX_EXECS = 20;
/** Ceiling on one detached-log read, so tailing a runaway log can't hand the
 *  browser a 200MB string. */
const DETACHED_READ_LIMIT = 256 * 1024;

export type ExecStatus = "running" | "success" | "failed" | "stopped";

/** One attached run, as the UI sees it. */
export interface ScriptExec {
  id: string;
  dir: string;
  pkg: string;
  script: string;
  command: string[];
  status: ExecStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
}

interface ExecState {
  exec: ScriptExec;
  lines: string[];
  /** Total lines ever produced, so a cursor stays meaningful after eviction. */
  produced: number;
  /** Bytes of the current, not-yet-newline-terminated tail of each stream. */
  partial: { out: string; err: string };
  proc: ChildProcess | null;
}

/**
 * Runs package.json scripts on behalf of the settings panel.
 *
 * Two paths, because they have genuinely different failure modes:
 *
 *  - ATTACHED (the default): stdout/stderr are piped into a line buffer that
 *    the page polls with a cursor. Works for anything that does not disturb
 *    this process.
 *  - DETACHED (`ScriptEntry.detach`): the script kills or restarts the console
 *    serving the page, so streaming output back over its own HTTP connection
 *    is not on offer — the connection dies with the process. Output is
 *    redirected to a file on disk instead, and the page tails that file
 *    straight through the restart.
 */
@Injectable()
export class ScriptRunnerService {
  private readonly logger = new Logger(ScriptRunnerService.name);
  private readonly execs = new Map<string, ExecState>();

  /** Start an attached run. Refuses a second copy of the same script while one
   *  is still going — a double click on `build` should not mean two builds
   *  writing the same output directory. */
  start(entry: ScriptEntry): ScriptExec {
    const running = [...this.execs.values()].find(
      (s) => s.exec.status === "running" && s.exec.dir === entry.dir && s.exec.script === entry.script,
    );
    if (running) throw new BadRequestException(`${entry.pkg} 的 ${entry.script} 还在运行中（${running.exec.id}）`);

    const id = randomUUID();
    const state: ExecState = {
      exec: {
        id,
        dir: entry.dir,
        pkg: entry.pkg,
        script: entry.script,
        command: entry.command,
        status: "running",
        exitCode: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
      lines: [],
      produced: 0,
      partial: { out: "", err: "" },
      proc: null,
    };
    this.execs.set(id, state);
    this.evictOld();
    this.push(state, `$ ${entry.command.join(" ")}`);

    const proc = spawn(entry.command[0], entry.command.slice(1), {
      cwd: MONOREPO_ROOT,
      // The console's own env IS the script's env, unlike a user-authored flow
      // script (flow-runner.service.ts deliberately withholds it). These are
      // the repo's own package.json scripts: `pnpm build` and friends read the
      // same `.env` this process loaded, and stripping it would just make them
      // behave differently here than in a terminal.
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so stop() can take down the whole tree. `pnpm run`
      // is a parent of the thing you actually want to stop; signalling only
      // the direct child leaves `tsc`/`vite` running.
      detached: true,
    });
    state.proc = proc;

    proc.stdout?.on("data", (chunk: Buffer) => this.ingest(state, "out", String(chunk)));
    proc.stderr?.on("data", (chunk: Buffer) => this.ingest(state, "err", String(chunk)));
    proc.on("error", (e) => {
      this.push(state, `[console] 启动失败：${e.message}`);
      this.finish(state, "failed", null);
    });
    proc.on("close", (code, signal) => {
      this.flushPartial(state);
      if (state.exec.status !== "running") return; // stop() already settled it
      if (signal) {
        this.push(state, `[console] 被信号 ${signal} 终止`);
        this.finish(state, "stopped", null);
        return;
      }
      this.push(state, `[console] 退出码 ${code}`);
      this.finish(state, code === 0 ? "success" : "failed", code);
    });

    return state.exec;
  }

  /**
   * Start a DETACHED run and return where its output landed. No exec record:
   * the console is expected to be killed by this, and a record that dies with
   * it would be a handle to nothing. The log file is the handle.
   */
  startDetached(entry: ScriptEntry): { logFile: string; command: string[] } {
    const file = path.join(MONOREPO_ROOT, DETACHED_LOG);
    // Truncate: one rolling file means the previous run's output is not what
    // you are looking at while waiting for this one.
    writeFileSync(file, `$ ${entry.command.join(" ")}\n[console] ${new Date().toISOString()} 已 detach 启动\n`, "utf8");
    const fd = openSync(file, "a");
    try {
      const proc = spawn(entry.command[0], entry.command.slice(1), {
        cwd: MONOREPO_ROOT,
        env: process.env,
        stdio: ["ignore", fd, fd],
        detached: true,
      });
      // Let this process exit without waiting on it — which is the whole
      // point, since "this process exits" is the expected outcome.
      proc.unref();
      this.logger.log(`detached ${entry.command.join(" ")} → ${DETACHED_LOG}`);
    } finally {
      // The child dup'd the descriptor at spawn; ours is no longer needed.
      closeSync(fd);
    }
    return { logFile: DETACHED_LOG, command: entry.command };
  }

  list(): ScriptExec[] {
    return [...this.execs.values()].map((s) => s.exec).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Incremental log read. `cursor` is an absolute line index; the response
   *  says how many lines were evicted before what it is returning, so the page
   *  can show the gap instead of pretending it isn't there. */
  logSince(id: string, cursor: number): { exec: ScriptExec; lines: string[]; cursor: number; dropped: number } {
    const state = this.execs.get(id);
    if (!state) throw new NotFoundException(`没有 ${id} 这次执行的记录（内存里只保留最近 ${MAX_EXECS} 次）`);
    const firstAvailable = state.produced - state.lines.length;
    const from = Math.max(cursor, firstAvailable);
    return {
      exec: state.exec,
      lines: state.lines.slice(from - firstAvailable),
      cursor: state.produced,
      dropped: Math.max(0, firstAvailable - cursor),
    };
  }

  stop(id: string): ScriptExec {
    const state = this.execs.get(id);
    if (!state) throw new NotFoundException(`没有 ${id} 这次执行的记录`);
    if (state.exec.status !== "running") return state.exec;
    const proc = state.proc;
    if (proc?.pid !== undefined) {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }
    this.push(state, "[console] 已手动停止");
    return this.finish(state, "stopped", null);
  }

  /** Tail the detached log by byte offset. Survives a console restart because
   *  it holds no state — the file is the state. */
  detachedLog(since: number): { text: string; offset: number; exists: boolean; reset: boolean } {
    const file = path.join(MONOREPO_ROOT, DETACHED_LOG);
    if (!existsSync(file)) return { text: "", offset: 0, exists: false, reset: false };
    const size = statSync(file).size;
    // A smaller file than the caller's offset means a new detached run
    // truncated it; start over rather than reading past the end.
    let from = since > size || since < 0 ? 0 : since;
    let reset = from !== since;
    if (size - from > DETACHED_READ_LIMIT) {
      from = size - DETACHED_READ_LIMIT;
      reset = true;
    }
    const len = size - from;
    if (len === 0) return { text: "", offset: size, exists: true, reset };
    const buf = Buffer.alloc(len);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, len, from);
    } finally {
      closeSync(fd);
    }
    return { text: buf.toString("utf8"), offset: size, exists: true, reset };
  }

  private ingest(state: ExecState, stream: "out" | "err", chunk: string): void {
    const combined = state.partial[stream] + chunk;
    const parts = combined.split("\n");
    // The last element is whatever came after the final newline — not a line
    // yet. Holding it back is what stops a chunk boundary mid-line from
    // showing up as two lines.
    state.partial[stream] = parts.pop() ?? "";
    for (const line of parts) this.push(state, line);
  }

  private flushPartial(state: ExecState): void {
    for (const stream of ["out", "err"] as const) {
      if (state.partial[stream] !== "") {
        this.push(state, state.partial[stream]);
        state.partial[stream] = "";
      }
    }
  }

  private push(state: ExecState, line: string): void {
    state.lines.push(line);
    state.produced += 1;
    if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
  }

  private finish(state: ExecState, status: ExecStatus, exitCode: number | null): ScriptExec {
    state.exec.status = status;
    state.exec.exitCode = exitCode;
    state.exec.finishedAt = new Date().toISOString();
    state.proc = null;
    return state.exec;
  }

  /** Drop the oldest FINISHED runs once there are too many. A running one is
   *  never evicted — its process would keep going with nothing left to stop it
   *  by. */
  private evictOld(): void {
    const finished = [...this.execs.values()]
      .filter((s) => s.exec.status !== "running")
      .sort((a, b) => a.exec.startedAt.localeCompare(b.exec.startedAt));
    let over = this.execs.size - MAX_EXECS;
    for (const s of finished) {
      if (over <= 0) break;
      this.execs.delete(s.exec.id);
      over -= 1;
    }
  }
}
