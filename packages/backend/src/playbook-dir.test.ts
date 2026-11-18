import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MONOREPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** `playbook.ts` resolves PLAYBOOKS_DIR from process.cwd() at module load, and
 *  `package.json`'s start/dev both `cd ../..` first — so the only configuration
 *  that matters is "cwd = monorepo root". `pnpm --filter` runs tests from
 *  packages/backend, so reproduce the real cwd before importing.
 *
 *  This exists because listPlaybooks() turns a missing directory into an empty
 *  result rather than an error (playbook.ts's ENOENT branch): point
 *  PLAYBOOKS_DIR at the wrong place and every caller — `list_playbooks`,
 *  `run_playbook` — reports "no playbooks saved yet" instead of failing. The
 *  books on disk are the only thing that can tell the two apart.
 *
 *  node:test runs each file in its own process, so this chdir is contained. */
test("listPlaybooks finds the books on disk when run the way the stack runs it", async () => {
  const original = process.cwd();
  process.chdir(MONOREPO_ROOT);
  try {
    const { listPlaybooks } = await import("./playbook.js");
    const { playbooks, unreadable } = await listPlaybooks();

    assert.deepEqual(unreadable, [], "every book on disk must parse");
    assert.ok(playbooks.length > 0, "PLAYBOOKS_DIR points at a directory with no books in it");
    assert.ok(
      playbooks.some((p) => p.name === "doubao-ask"),
      `expected doubao-ask among [${playbooks.map((p) => p.name).join(", ")}]`,
    );
  } finally {
    process.chdir(original);
  }
});
