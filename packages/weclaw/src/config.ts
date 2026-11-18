/**
 * Runtime config for @bcp/weclaw sidecar.
 * All values env-overridable; defaults keep the sidecar fully project-local.
 */
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/ → package root
export const PACKAGE_DIR = path.resolve(__dirname, "..");

const userConfigSchema = z.object({
  default_recipient: z.string().optional(),
}).passthrough();

export function readDefaultRecipient(configDir: string): string | undefined {
  const filePath = path.join(configDir, "user.json");
  if (!existsSync(filePath)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Invalid WeClaw user config: ${filePath}`, { cause: error });
  }

  const value = userConfigSchema.parse(parsed).default_recipient?.trim();
  return value || undefined;
}

export const config = {
  /** Absolute path to the weclaw binary (downloaded by scripts/install.sh). */
  bin: process.env.WECLAW_BIN || path.join(PACKAGE_DIR, "bin", "weclaw"),

  /** Where config.json + accounts/ live. Project-local by default. */
  configDir: process.env.WECLAW_CONFIG_DIR || path.join(PACKAGE_DIR, "config"),

  /** Default recipient for MCP sends when a caller omits `to`. */
  get defaultRecipient(): string | undefined {
    return readDefaultRecipient(this.configDir);
  },

  /** API listen address for weclaw's /api/send and /health endpoints. */
  apiAddr: process.env.WECLAW_API_ADDR || "127.0.0.1:18011",

  /** Set to "1" to skip auto-start (useful for unit tests / CI). */
  disabled: process.env.WECLAW_DISABLE === "1",

  /** Max time to wait for the API to become healthy after spawn. */
  startTimeoutMs: Number(process.env.WECLAW_START_TIMEOUT_MS) || 15_000,

  /** Max time to wait for clean shutdown on SIGTERM. */
  stopTimeoutMs: Number(process.env.WECLAW_STOP_TIMEOUT_MS) || 3_000,

  /** Loopback URL the client uses to reach weclaw's HTTP API. */
  get apiUrl(): string {
    return `http://${this.apiAddr}`;
  },
} as const;

export type WecConfig = typeof config;
