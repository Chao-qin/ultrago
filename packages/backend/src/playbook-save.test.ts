import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// playbook.ts resolves PLAYBOOKS_DIR from process.cwd() at load, so load it from
// a scratch directory: these tests write playbooks, and must never touch the
// repository's resource/playbooks.
const directory = await mkdtemp(join(tmpdir(), "bcp-playbook-save-"));
const books = join(directory, "resource", "playbooks");
await mkdir(books, { recursive: true });
await writeFile(join(books, "existing.json"), '{"name":"existing","goal":"keep me","paramNames":[],"steps":[]}\n');
const previous = process.cwd();
let playbook: typeof import("./playbook.js");
try {
  process.chdir(directory);
  playbook = await import("./playbook.js");
} finally {
  process.chdir(previous);
}
after(() => rm(directory, { recursive: true, force: true }));

test("savePlaybook 拒绝越出目录的名字", async () => {
  for (const name of ["../x", "a/b", "", ".hidden", "a..b"])
    await assert.rejects(() => playbook.savePlaybook({ name, goal: "g", paramNames: [], steps: [] }), /must be letters/, name);
});

test("savePlaybook 不静默覆盖同名剧本，overwrite:true 才替换", async () => {
  await assert.rejects(() => playbook.savePlaybook({ name: "existing", goal: "new", paramNames: [], steps: [] }), /already exists/);
  assert.match(await readFile(join(books, "existing.json"), "utf8"), /keep me/);
  await playbook.savePlaybook({ name: "existing", goal: "new", paramNames: [], steps: [] }, { overwrite: true });
  assert.match(await readFile(join(books, "existing.json"), "utf8"), /"goal": "new"/);
});
