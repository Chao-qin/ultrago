/**
 * Pre-flight WeChat login gate, run by scripts/backend.sh before the backend
 * spawns (`pnpm start`).
 *
 * The managed `weclaw start` writes all output to a log file and the stack
 * kills everything when port 18011 isn't ready in time — so a QR login prompt
 * inside the managed flow is both invisible and unscannable. This script runs
 * in the foreground of the user's terminal instead:
 *   - default: with a saved account it exits 0 silently; without one it runs
 *     `weclaw login` so the QR renders where the user can actually scan it.
 *     NOTE: a saved credential file does NOT prove the session is alive —
 *     that is verified post-boot by `check-session`.
 *   - `--force`: drop the saved account(s) and re-run `weclaw login`. Used by
 *     backend.sh after check-session reports an expired session.
 *
 * Exit codes: 0 = account present (or just added), non-zero = no account and
 * login impossible/failed — backend.sh aborts the start.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { ensureConfigSymlink } from "./weclaw-manager.js";
import { clearStaleAccounts, isWeclawDisabled } from "./session-health.js";

/** QR codes expire after ~1-2min; retry with a fresh code if one dies. */
const LOGIN_ATTEMPTS = 3;

/** Same credential-file shape readBoundAccount() uses: <id>.json, excluding <id>.sync.json buffers. */
function hasAccount(): boolean {
  const dir = path.join(config.configDir, "accounts");
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => f.endsWith(".json") && !f.endsWith(".sync.json"));
}

/** Foreground `weclaw login` (QR renders in the terminal). True on success. */
function runLogin(): boolean {
  for (let attempt = 1; attempt <= LOGIN_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      console.log(`[wec] QR expired or login failed — trying again (${attempt}/${LOGIN_ATTEMPTS})`);
    }
    const r = spawnSync(config.bin, ["login"], { stdio: "inherit" });
    if (r.status === 0) return true;
    // Ctrl+C / SIGINT leaves status null — don't loop after an interrupt.
    if (r.status === null) return false;
  }
  return false;
}

// The symlink must exist BEFORE `weclaw login`, or credentials land in a real
// ~/.weclaw that the manager will back up and orphan on the next start.
ensureConfigSymlink();

if (isWeclawDisabled()) {
  process.exit(0);
}

const force = process.argv.includes("--force");
if (!hasAccount() || force) {
  if (force && hasAccount()) {
    console.log("[wec] re-login requested — dropping saved account(s) for a fresh QR login");
    if (!clearStaleAccounts()) {
      // Multiple accounts: we refused to clear, so a blind `login` would just
      // ADD a third credential. Ask the user to sort it out manually.
      console.error("[wec] aborting: re-login needs exactly one saved account; move or remove extra credential files in config/accounts/ first.");
      process.exit(1);
    }
  }
  if (!process.stdin.isTTY) {
    console.error("[wec] no WeChat account and no interactive terminal for QR login.");
    console.error(
      `[wec]   fix: run \`${config.bin} login\` in a terminal, or set BCP_WECLAW_DISABLE=1 to skip WeClaw.`,
    );
    process.exit(1);
  }
  console.log(force ? "[wec] starting fresh QR login — scan with WeChat on your phone." : "[wec] no WeChat account — starting QR login; scan with WeChat on your phone.");
  process.exit(runLogin() ? 0 : 1);
}
