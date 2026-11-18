/**
 * Post-boot session health check, run by scripts/backend.sh right after the
 * stack comes up — in the foreground of the user's terminal.
 *
 * The managed daemon's monitor prints its first unrecoverable "session
 * expired" WARNING within a few seconds of boot when the saved bot token is
 * dead; there is no earlier signal (the credential file exists, /api/send
 * returns ok). This script polls the log until a fresh, post-boot marker shows
 * up (up to MAX_WAIT_MS) and lets the caller react.
 *
 * Exit codes:
 *   0 — session looks healthy (or WeClaw disabled / cannot verify)
 *   2 — session is expired; the caller should tear the stack down, re-login
 *       interactively (see ensure-login --force), then restart it
 *   1 — not used by this script anymore; failures exit 0 with a warning so a
 *       degraded check never tears down a healthy stack
 */
import { config } from "./config.js";
import { isSessionExpired, isWeclawDisabled } from "./session-health.js";

/** How long to wait for the freshly-spawned monitor to print its first expiry marker. */
const MAX_WAIT_MS = 15_000;
const POLL_MS = 1_000;

async function main(): Promise<void> {
  if (isWeclawDisabled()) {
    process.exit(0);
  }

  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    if (isSessionExpired()) {
      if (!process.stdin.isTTY) {
        // No terminal to scan a QR in. Keep the stack running (degraded, like
        // before this check existed) rather than kill it — a supervisor would
        // otherwise restart us into an infinite fail loop.
        console.warn("[wec] session check: FAILED — WeChat session expired, but no interactive terminal for QR login.");
        console.warn("[wec]   fix: run `pnpm --filter @bcp/weclaw run ensure-login --force` in a terminal.");
        process.exit(0);
      }
      console.warn("[wec] session check: FAILED — WeChat session expired (daemon is logging it)");
      process.exit(2);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  console.log("[wec] session check: ok");
  process.exit(0);
}

main().catch((e) => {
  // A check that crashes must never take the stack down with it.
  console.warn("[wec] session check skipped (error):", String(e));
  process.exit(0);
});
