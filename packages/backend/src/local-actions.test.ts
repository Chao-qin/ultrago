import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "bcp-report-paths-"));
const previousDirectory = process.cwd();
let actions: typeof import("./local-actions.js");
try {
  process.chdir(directory);
  actions = await import("./local-actions.js");
} finally {
  process.chdir(previousDirectory);
}
after(() => rm(directory, { recursive: true, force: true }));

for (const [platform, paths, root] of [
  ["Windows", win32, "C:\\Users\\卖家\\UltraGo\\reports"],
  ["POSIX", posix, "/tmp/UltraGo/reports"],
] as const) {
  test(`${platform}: normal reports, nested Chinese paths and dot-prefixed names remain inside reports`, () => {
    for (const file of ["baidu-hot-search-2026-11-09.md", "1688商品/商品.json", "..report.md"]) {
      assert.equal(actions.resolveReportFile(root, file, paths), paths.resolve(root, file));
    }
    const absolute = paths.resolve(root, "absolute.md");
    assert.equal(actions.resolveReportFile(root, absolute, paths), absolute);
  });
  test(`${platform}: traversal, sibling-prefix and root targets are rejected`, () => {
    for (const file of ["..", ".", "../outside.md", "../reports-other/outside.md", paths.resolve(root, "../outside.md")]) {
      assert.throws(() => actions.resolveReportFile(root, file, paths), /escapes the reports/);
    }
    for (const file of ["", "   ", "{{reportFile}}"])
      assert.throws(() => actions.resolveReportFile(root, file, paths), /unresolved template/);
  });
}

test("Windows: backslash traversal, other drives and UNC shares are rejected", () => {
  const root = "C:\\Users\\seller\\reports";
  for (const file of ["..\\outside.md", "D:\\outside.md", "D:outside.md", "\\\\server\\share\\outside.md", "\\outside.md"])
    assert.throws(() => actions.resolveReportFile(root, file, win32), /escapes the reports/);
  assert.equal(actions.resolveReportFile(root, "子目录\\商品.json", win32), win32.join(root, "子目录", "商品.json"));
});

test("real file writes preserve overwrite modes and UTF-8 content without running a book", async () => {
  const first = await actions.writeLocalFile("子目录/商品.json", '{"商品":"示例"}');
  assert.equal(first, join(directory, "reports/子目录/商品.json"));
  assert.equal(await readFile(first, "utf8"), '{"商品":"示例"}');
  await assert.rejects(actions.writeLocalFile("子目录/商品.json", "changed", { overwrite: "error" }), /already exists/);
  const renamed = await actions.writeLocalFile("子目录/商品.json", "renamed", { overwrite: "rename" });
  assert.notEqual(renamed, first);
  assert.equal(await readFile(first, "utf8"), '{"商品":"示例"}');
  assert.equal(await readFile(renamed, "utf8"), "renamed");
  await assert.rejects(actions.writeLocalFile("../outside.md", "blocked"), /escapes the reports/);
});

test("local.eval code cannot reach the backend process through any object it is given", async () => {
  const { runLocalEval } = await import("./local-actions.js");
  const results = [{ method: "browser.readContent", params: {}, value: { text: "ok" } }] as never;
  for (const escape of [
    `return results.constructor.constructor("return process")().pid;`,
    `return this.constructor.constructor("return process")().pid;`,
    `return Function("return process")().pid;`,
    `return results[0].value.constructor.constructor("return process")().pid;`,
    `return (async () => 0).constructor("return process")();`,
  ]) {
    let leaked: unknown;
    try { leaked = runLocalEval(escape, results); } catch { leaked = undefined; }
    assert.notEqual(typeof leaked, "number", `宿主进程不可达：${escape}`);
  }
  assert.deepEqual(runLocalEval(`return results.map((r) => r.value.text).join(",") + " " + typeof globalThis.process;`, results), "ok undefined");
  assert.deepEqual(runLocalEval(`return { rows: [1, 2], note: "表格" };`, results), { rows: [1, 2], note: "表格" });
  assert.equal(runLocalEval(`return undefined;`, results), undefined);
  assert.throws(() => runLocalEval(`return Promise.reject(new Error("x"));`, results), /synchronously/, "a rejected Promise must not reach the backend as an unhandled rejection");
});
