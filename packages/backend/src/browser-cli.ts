#!/usr/bin/env node
/**
 * browser-cli — `bcp-browser status|setup|stop`
 *
 * Talks ONLY to the backend's loopback internal HTTP (spec §11.3). It never
 * spawns, kills or adopts browser processes itself — the BrowserSetupService
 * in the backend owns all of that. Requires the backend to be running.
 *
 *   bcp-browser status [--kind chrome] [--instance-id <id>]
 *   bcp-browser setup --kind chrome|firefox [--mode user|managed] [--instance-id <id>] [--wait-ms 30000]
 *   bcp-browser stop --kind chrome|firefox --instance-id <id>
 *
 * `--mode` 缺省为 "user"（安全默认：user 实例永不归后端所有）。
 *
 * Auth: X-BCP-Internal-Token, from BCP_INTERNAL_TOKEN (same default as the
 * backend: bcp-internal-dev-token).
 */
import { config } from "./config.js";

const BASE = process.env.BCP_INTERNAL_URL || "http://127.0.0.1:8789";

function usage(): never {
  console.error(
    [
      "usage:",
      "  bcp-browser status [--kind chrome|firefox] [--instance-id <id>]",
      "  bcp-browser setup --kind chrome|firefox [--mode user|managed] [--instance-id <id>] [--wait-ms 30000]",
      "  bcp-browser stop --kind chrome|firefox --instance-id <id>",
      "",
      "env: BCP_INTERNAL_URL (default http://127.0.0.1:8789), BCP_INTERNAL_TOKEN (default bcp-internal-dev-token)",
    ].join("\n"),
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = args[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        flags.set(key, val);
        i++;
      } else {
        flags.set(key, "true");
      }
    }
  }
  const kind = flags.get("kind");
  const instanceId = flags.get("instance-id");
  const mode = flags.get("mode");
  const waitMs = flags.get("wait-ms");

  const headers = {
    "content-type": "application/json",
    "x-bcp-internal-token": process.env.BCP_INTERNAL_TOKEN || config.internalToken,
  };
  const q = (path: string): string => `${BASE}${path}`;

  try {
    if (cmd === "status") {
      const qs = new URLSearchParams();
      if (kind === "chrome" || kind === "firefox") qs.set("kind", kind);
      if (instanceId) qs.set("instanceId", instanceId);
      const res = await fetch(q(`/internal/browsers/status?${qs}`), { headers });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error(JSON.stringify(body, null, 2));
        process.exit(1);
      }
      console.log(JSON.stringify(body, null, 2));
      return;
    }
    if (cmd === "setup") {
      if (kind !== "chrome" && kind !== "firefox") usage();
      if (mode !== undefined && mode !== "user" && mode !== "managed") usage();
      const res = await fetch(q("/internal/browsers/setup"), {
        method: "POST",
        headers,
        body: JSON.stringify({ kind, mode: mode ?? "user", instanceId, waitMs: waitMs ? Number(waitMs) : undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error(JSON.stringify(body, null, 2));
        process.exit(res.status === 409 || res.status === 422 ? 1 : 1);
      }
      console.log(JSON.stringify(body, null, 2));
      return;
    }
    if (cmd === "stop") {
      if (kind !== "chrome" && kind !== "firefox" || !instanceId) usage();
      const res = await fetch(q("/internal/browsers/stop"), {
        method: "POST",
        headers,
        body: JSON.stringify({ kind, instanceId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error(JSON.stringify(body, null, 2));
        process.exit(1);
      }
      console.log(JSON.stringify(body, null, 2));
      return;
    }
    usage();
  } catch (e) {
    console.error(`failed to reach backend at ${BASE}: ${e instanceof Error ? e.message : String(e)}`);
    console.error("is the backend running? (pnpm dev / pnpm start)");
    process.exit(1);
  }
}

main();
