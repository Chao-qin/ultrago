/**
 * Read / edit the monorepo `.env` as a file rather than as a key-value map.
 *
 * The whole point is that the file survives a round trip: comments, blank
 * lines, ordering and the commented-out entries people keep as documentation
 * (`# BCP_INTERNAL_URL=http://127.0.0.1:8789`) are all part of what makes it
 * readable, and a panel that rewrote it from a parsed map would flatten them
 * on the first save.
 *
 * Values are carried VERBATIM — the raw right-hand side, quotes and all. We do
 * not adopt dotenv's unquoting/interpolation rules on read, because we would
 * then have to reproduce them exactly on write or change the meaning of a line
 * nobody touched. What you see in the panel is the file's text.
 */

/** One `KEY=VALUE` line, plus the comment block sitting directly above it. */
export interface EnvEntry {
  key: string;
  /** Raw right-hand side. Masked before it leaves the process when `secret`. */
  value: string;
  /** Comment lines immediately above this entry, verbatim, leading `#` kept.
   *  They document the key, so the panel shows them next to it. */
  comments: string[];
  secret: boolean;
  group: string;
  /** 1-based line number in the source file. */
  line: number;
}

const KEY_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=)(.*)$/;

/**
 * Which keys get masked. Narrow on purpose: matching a bare `KEY` would also
 * hide `BCP_LLM_LMSTUDIO_MODEL_KEY`, whose value is a public model id, and a
 * mask over something that isn't a secret just trains people to click reveal
 * on everything.
 */
export function isSecretKey(key: string): boolean {
  return /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i.test(key);
}

/** Ordered prefix → group label. First match wins, so the more specific
 *  prefixes have to come first. */
const GROUPS: Array<[RegExp, string]> = [
  [/^BCP_LLM_/, "本地 LLM"],
  [/^IMAGE_BED_/, "图床"],
  [/^WECLAW_/, "weclaw"],
  [/^(CONSOLE_|DATABASE_URL$)/, "Console 管理后台"],
  [/^BCP_/, "Browser Control Protocol"],
];

export function groupOf(key: string): string {
  for (const [re, label] of GROUPS) if (re.test(key)) return label;
  return "其他";
}

/** Split a `.env` into entries. Lines that are not assignments (comments,
 *  blanks, commented-out assignments) become the `comments` of whichever entry
 *  follows them; a blank line ends a comment block, so a header paragraph two
 *  entries up doesn't get attributed to the wrong key. */
export function parseEnvFile(text: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  let comments: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = KEY_RE.exec(line);
    if (m) {
      const key = m[2];
      entries.push({
        key,
        value: m[4],
        comments,
        secret: isSecretKey(key),
        group: groupOf(key),
        line: i + 1,
      });
      comments = [];
      continue;
    }
    if (line.trim() === "") {
      comments = [];
      continue;
    }
    comments.push(line);
  }
  return entries;
}

/** Show enough of a secret to recognise it, not enough to use it. */
export function maskValue(value: string): string {
  if (value === "") return "";
  if (value.length <= 8) return "••••••";
  return `${value.slice(0, 3)}••••••${value.slice(-2)}`;
}

/** Reject anything that would corrupt the file or invent a key shape dotenv
 *  won't read back. A newline in a value is the one that matters: it would
 *  split one assignment into two lines and silently create a key. */
export function validateEnvUpdate(key: string, value: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `变量名「${key}」不合法：只允许字母、数字、下划线，且不能以数字开头`;
  if (/[\r\n]/.test(value)) return `变量「${key}」的值里有换行，会把一行拆成两行、凭空多出一个变量`;
  return null;
}

/**
 * Apply a key→value map to the file's text.
 *
 * Existing keys are rewritten IN PLACE, preserving the line's indentation and
 * the spacing around `=`. Keys not already present are appended in one block
 * at the end under a header, so it's obvious afterwards which entries came
 * from the panel rather than from the file people have been editing by hand.
 *
 * A key that appears twice (dotenv keeps the last one) has every occurrence
 * rewritten, so the effective value ends up being the one that was asked for
 * rather than a stale earlier line winning on the next read.
 */
export function applyEnvUpdates(text: string, updates: Record<string, string>): string {
  const pending = new Set(Object.keys(updates));
  const lines = text.split("\n");
  const out = lines.map((line) => {
    const m = KEY_RE.exec(line);
    if (!m) return line;
    const key = m[2];
    if (!(key in updates)) return line;
    pending.delete(key);
    return `${m[1]}${key}${m[3]}${updates[key]}`;
  });

  const appended = pending.size > 0;
  if (appended) {
    // Keep exactly one trailing blank line before the appended block, whatever
    // the file ended with.
    while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
    out.push("", "# ── 由 Console 设置面板新增 ──");
    for (const key of Object.keys(updates)) {
      if (pending.has(key)) out.push(`${key}=${updates[key]}`);
    }
  }

  // Rewriting values in place changes no line structure, so joining gives the
  // file back byte for byte apart from the values asked for — including
  // whether it ended with a newline. Only the append path, which pops the
  // trailing blank, has to put one back.
  const joined = out.join("\n");
  if (!appended) return joined;
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}
