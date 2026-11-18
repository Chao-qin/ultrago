/**
 * Shared session-health helpers for the WeClaw login gates.
 *
 * The weclaw binary exposes no session-validity command: while the bot token is
 * dead its monitor silently logs `[monitor] WARNING: WeChat session expired and
 * cannot be auto-recovered` once per backoff tick, and /api/send keeps
 * returning ok either way. The only trustworthy, side-effect-free signal is
 * that log line — written moments ago by a live daemon means the saved session
 * is dead.
 */
import { existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, statSync, closeSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/** Marker line printed by the monitor when the session cannot be auto-recovered. */
const EXPIRED_MARKER = "WeChat session expired and cannot be auto-recovered";

/**
 * Boot anchor line — printed by the monitor right after a daemon/monitor
 * start. Only expiry markers AFTER the newest anchor count: a marker left by a
 * daemon that was just killed must not poison the check of the fresh daemon.
 */
const BOOT_ANCHOR_MARKER = "starting long-poll loop";

/**
 * How far back an expiry marker may be and still count as "a live daemon is
 * currently reporting the session dead". The monitor re-logs once per ~5s
 * tick, but network errors push it into exponential backoff (cap 60s), so the
 * window must exceed that cap or a slow tick would be mistaken for a healthy
 * session.
 */
const EXPIRED_FRESH_MS = 90_000;

/** Tail size — the monitor spams one line per 5s while expired; 64KB covers ~47min. */
const TAIL_BYTES = 64 * 1024;

/** Parse the `2026/08/12 19:32:47` prefix of a weclaw log line. */
function parseLogTimestamp(line: string): number | null {
  const m = line.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  if (
    y === undefined || mo === undefined || d === undefined ||
    h === undefined || mi === undefined || s === undefined
  ) {
    return null;
  }
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

function readLogTail(): string {
  const logPath = path.join(config.configDir, "weclaw.log");
  try {
    const st = statSync(logPath);
    const fd = openSync(logPath, "r");
    try {
      const start = Math.max(0, st.size - TAIL_BYTES);
      const buf = Buffer.alloc(st.size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Timestamp of the newest boot-anchor line, or null (no log / log truncated). */
export function lastBootAnchorMs(): number | null {
  const tail = readLogTail();
  let last: number | null = null;
  for (const line of tail.split("\n")) {
    if (!line.includes(BOOT_ANCHOR_MARKER)) continue;
    const ts = parseLogTimestamp(line);
    if (ts !== null) last = ts;
  }
  return last;
}

/** Timestamp of the newest unrecoverable-expiry marker line, or null. */
export function lastExpiredAtMs(): number | null {
  const tail = readLogTail();
  let last: number | null = null;
  for (const line of tail.split("\n")) {
    if (!line.includes(EXPIRED_MARKER)) continue;
    const ts = parseLogTimestamp(line);
    if (ts !== null) last = ts;
  }
  return last;
}

/**
 * True when the CURRENT daemon is reporting the session dead: the newest
 * marker is fresh AND newer than the newest boot anchor (so a marker left by a
 * killed daemon doesn't count).
 */
export function isSessionExpired(): boolean {
  const marker = lastExpiredAtMs();
  if (marker === null) return false;
  if (Date.now() - marker >= EXPIRED_FRESH_MS) return false;
  const anchor = lastBootAnchorMs();
  return anchor === null || marker > anchor;
}

/** True when weclaw is disabled by either the script or the backend gate. */
export function isWeclawDisabled(): boolean {
  return config.disabled || process.env.BCP_WECLAW_DISABLE === "1";
}

/**
 * Move stale account credentials aside so the fresh login becomes the only
 * account the daemon will monitor. weclaw starts a monitor per saved
 * credential; a leftover dead-token file would keep the expiry marker fresh
 * forever and re-poison every later session check.
 *
 * Safety rails:
 *  - `.sync.json` buffers are never touched (moving them would make the server
 *    replay the message backlog after re-login).
 *  - With more than one saved account we refuse to move anything — an expired
 *    session is never worth silently breaking a healthy second account — and
 *    just report the situation.
 */
export function clearStaleAccounts(): boolean {
  const dir = path.join(config.configDir, "accounts");
  if (!existsSync(dir)) return true;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".sync.json"));
  if (files.length === 0) return true;
  if (files.length > 1) {
    console.warn(
      `[wec] ${files.length} saved WeChat accounts; refusing to clear them automatically —`,
      "run `weclaw login` manually if the session really is expired.",
    );
    return false;
  }
  const backup = `${dir}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
  mkdirSync(backup, { recursive: true });
  for (const f of files) {
    try {
      renameSync(path.join(dir, f), path.join(backup, f));
    } catch {
      /* best-effort — a leftover file is only a re-check delay, not a break */
    }
  }
  console.log(`[wec] moved ${files.length} stale credential file(s) -> ${backup}`);
  return true;
}
