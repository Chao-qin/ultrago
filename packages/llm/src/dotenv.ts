/**
 * `.env` as a fallback layer under process env.
 *
 * The gateway needs it because channel secrets are referenced by arbitrary
 * names (`"apiKey": "env.AIHUB_API_KEY"`), so no launcher can export a fixed
 * whitelist ahead of it — a new channel would silently need a new export.
 * Reading the file here also means `node dist/gateway.js` behaves the same
 * standalone as it does under `pnpm start`, which is what makes it testable.
 *
 * Precedence matches what the shell scripts already do: process env > .env >
 * defaults. Parsed, never sourced — a value containing backticks must not be
 * executed just because it sits in a config file.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_URL = new URL("../../../.env", import.meta.url);

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Strip one layer of matching quotes; leave everything else verbatim. */
function unquote(raw: string): string {
  const value = raw.trim();
  const quoted = /^(['"])(.*)\1$/s.exec(value);
  return quoted ? quoted[2] : value;
}

export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    out[match[1]] = unquote(match[2]);
  }
  return out;
}

/**
 * Process env layered over `.env`.
 *
 * A missing or unreadable file is not an error: the local channel is derived
 * from defaults and needs no secrets, so a fresh clone must still start.
 */
export function envWithDotFile(
  env: NodeJS.ProcessEnv = process.env,
  path: string = fileURLToPath(ENV_URL),
): Record<string, string | undefined> {
  if (env.BCP_DESKTOP === '1') return { ...env };
  let fromFile: Record<string, string> = {};
  try {
    if (existsSync(path)) fromFile = parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    // Unreadable .env — carry on with process env alone.
  }
  return { ...fromFile, ...env };
}
