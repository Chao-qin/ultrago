/**
 * .env parsing tests.
 *
 * The load-bearing one is precedence: process env must win, matching what the
 * shell scripts already do. Getting it backwards would let a stale file value
 * silently override what an operator just exported.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { envWithDotFile, parseEnvFile } from "./dotenv.js";

test("parses KEY=VALUE, skips comments and blanks, unquotes one layer", () => {
  const parsed = parseEnvFile(
    ['# a comment', '', 'PLAIN=abc', 'export EXPORTED=def', 'QUOTED="with spaces"',
     "SINGLE='sq'", 'EQUALS=a=b=c', 'SPACED = padded ', 'not a key line'].join("\n"),
  );
  assert.deepEqual(parsed, {
    PLAIN: "abc", EXPORTED: "def", QUOTED: "with spaces",
    SINGLE: "sq", EQUALS: "a=b=c", SPACED: "padded",
  });
});

test("a value is never executed — it is parsed, not sourced", () => {
  const parsed = parseEnvFile("DANGER=`touch /tmp/should-not-exist`\nAFTER=ok");
  assert.equal(parsed.DANGER, "`touch /tmp/should-not-exist`");
  assert.equal(parsed.AFTER, "ok", "parsing must continue past an exotic value");
});

test("process env wins over the file, and a missing file is not an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "bcp-dotenv-"));
  const path = join(dir, ".env");
  writeFileSync(path, "FROM_FILE=file\nBOTH=file\n");
  try {
    const merged = envWithDotFile({ BOTH: "process", ONLY_PROCESS: "p" }, path);
    assert.equal(merged.FROM_FILE, "file");
    assert.equal(merged.BOTH, "process");
    assert.equal(merged.ONLY_PROCESS, "p");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // A fresh clone has no secrets to read and must still start.
  assert.doesNotThrow(() => envWithDotFile({}, join(tmpdir(), "definitely-absent.env")));
});
