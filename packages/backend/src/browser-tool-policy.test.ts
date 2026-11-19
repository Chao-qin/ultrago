/**
 * Browser-tool policy and the reply shapes the 2026-11-10 issue report found unusable: a page eval switch that
 * accepted one spelling and could not be reached in the desktop build at all, screenshots that could only land
 * in the temp folder, a 116k-character snapshot the MCP client refused, and windows nobody could tell apart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { access, link, lstat, mkdtemp, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { InternalRunner } from "./internal-runner.js";
import type { SnapshotElement } from "@bcp/shared";
import { config, envFlag, envFlagDefaultOn, EVAL_DISABLED, LOCAL_EVAL_DISABLED } from "./config.js";
import { createBrowserHttpRouter } from "./browser-http.js";
import { resolveShotPath, writeShot } from "./browser-mcp-tools-capture.js";
import { renderSnapshotView, SNAPSHOT_CHAR_BUDGET, windowFocusLabel, windowFocusLegend } from "./browser-mcp-render.js";
import type { BrowserDispatcher } from "./browser-dispatcher.js";
import type { BrowserSetupService } from "./browser-setup-service.js";

function restoreEnv(keys: string[]): () => void {
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  return () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}

test("switches accept every common spelling of on, and only those", () => {
  for (const value of ["on", "ON", "1", "true", "True", "yes", " on "]) assert.equal(envFlag(value), true, value);
  for (const value of [undefined, "", "0", "off", "false", "no", "enable"]) assert.equal(envFlag(value), false, String(value));
  const restore = restoreEnv(["BCP_EVAL"]);
  try {
    process.env.BCP_EVAL = "1";
    assert.equal(config.evalEnabled, true, "BCP_EVAL=1 用户最常写的形式必须生效");
  } finally { restore(); }
  assert.match(EVAL_DISABLED, /允许页面脚本/);
  assert.match(EVAL_DISABLED, /BCP_EVAL=off/);
  assert.match(LOCAL_EVAL_DISABLED, /允许本机脚本/);
});

test("page eval and local eval are on unless explicitly switched off", () => {
  for (const value of [undefined, "", "on", "1", "anything"]) assert.equal(envFlagDefaultOn(value), true, String(value));
  for (const value of ["off", "OFF", "0", "false", "no", " off "]) assert.equal(envFlagDefaultOn(value), false, value);
  const restore = restoreEnv(["BCP_EVAL", "BCP_LOCAL_EVAL"]);
  try {
    delete process.env.BCP_EVAL;
    delete process.env.BCP_LOCAL_EVAL;
    assert.equal(config.evalEnabled, true, "未设置 BCP_EVAL 时页面 eval 默认开启");
    assert.equal(config.localEvalEnabled, true, "未设置 BCP_LOCAL_EVAL 时 local.eval 默认开启");
    process.env.BCP_EVAL = "off";
    process.env.BCP_LOCAL_EVAL = "off";
    assert.equal(config.evalEnabled, false);
    assert.equal(config.localEvalEnabled, false);
  } finally { restore(); }
});

test("screenshots may go to the temp folder or the folder the user chose, nowhere else", () => {
  const restore = restoreEnv(["BCP_SCREENSHOT_DIR"]);
  try {
    delete process.env.BCP_SCREENSHOT_DIR;
    assert.equal(resolveShotPath("a.png"), resolve(tmpdir(), "a.png"));
    const workspace = resolve(tmpdir(), "..", "bcp-policy-workspace");
    assert.throws(() => resolveShotPath(join(workspace, "a.png")), /must stay within/);
    process.env.BCP_SCREENSHOT_DIR = workspace;
    assert.equal(resolveShotPath("a.png"), join(workspace, "a.png"), "相对路径落在用户选择的目录");
    assert.equal(resolveShotPath(join(workspace, "sub", "a.png")), join(workspace, "sub", "a.png"));
    assert.equal(resolveShotPath(resolve(tmpdir(), "b.png")), resolve(tmpdir(), "b.png"), "临时目录始终允许");
    assert.throws(() => resolveShotPath(join(workspace, "..", "escape.png")), /must stay within/);
    assert.throws(() => resolveShotPath("a.jpg"), /\.png/);
  } finally { restore(); }
});

function elements(count: number): SnapshotElement[] {
  return Array.from({ length: count }, (_, i): SnapshotElement => ({
    ref: `e${i}`, tag: i % 10 === 0 ? "input" : "a", role: i % 10 === 0 ? "textbox" : "link", name: i === 1500 ? "登录/注册" : `职位 ${i} 广州 前端开发工程师 薪资面议`,
    inViewport: i < 40, ...(i < 40 ? { rect: [0, i * 20, 200, 18] as [number, number, number, number] } : {}),
  }));
}

test("a link inside an allowed folder cannot carry a screenshot outside it", async () => {
  const restore = restoreEnv(["BCP_SCREENSHOT_DIR", "TMPDIR"]);
  const base = await mkdtemp(join(tmpdir(), "bcp-confine-"));
  try {
    for (const name of ["tmp", "allowed", "outside"]) await mkdir(join(base, name));
    process.env.TMPDIR = join(base, "tmp");
    process.env.BCP_SCREENSHOT_DIR = join(base, "allowed");
    await symlink(join(base, "outside"), join(base, "allowed", "link"), "dir");
    await assert.rejects(writeShot(resolveShotPath("link/x.png"), Buffer.from("PNG")), /through a link/, "目录链接");
    await assert.rejects(writeShot(resolveShotPath("link/a/b/x.png"), Buffer.from("PNG")), /through a link/);
    await assert.rejects(access(join(base, "outside", "a")), { code: "ENOENT" }, "被拒绝的路径不能先在外面建出目录");
    await writeFile(join(base, "outside", "victim.txt"), "keep");
    await symlink(join(base, "outside", "victim.txt"), join(base, "allowed", "shot.png"));
    await writeShot(resolveShotPath("shot.png"), Buffer.from("PNG"));
    await link(join(base, "outside", "victim.txt"), join(base, "allowed", "hard.png"));
    await writeShot(resolveShotPath("hard.png"), Buffer.from("PNG"));
    assert.equal(await readFile(join(base, "outside", "victim.txt"), "utf8"), "keep", "链接被替换，外部文件没有被写穿");
    assert.equal(await readFile(join(base, "allowed", "shot.png"), "utf8"), "PNG");
    assert.equal((await lstat(join(base, "allowed", "shot.png"))).isSymbolicLink(), false);
    assert.deepEqual((await readdir(join(base, "allowed"))).filter((name) => name.endsWith(".tmp")), [], "不留临时文件");
    await writeShot(resolveShotPath("sub/x.png"), Buffer.from("PNG"));
    assert.equal(await readFile(join(base, "allowed", "sub", "x.png"), "utf8"), "PNG");
    await writeShot(resolveShotPath("sub/x.png"), Buffer.from("PNG2"));
    assert.equal(await readFile(join(base, "allowed", "sub", "x.png"), "utf8"), "PNG2", "普通文件可以覆盖");
  } finally { restore(); }
});

test("a huge page pages under the budget by ref cursor, and query / viewportOnly narrow it", () => {
  const page = elements(2581);
  const first = renderSnapshotView(page).text;
  assert.ok(first.length < SNAPSHOT_CHAR_BUDGET + 600, `first page stays under the budget (${first.length})`);
  const shown = Number(/showing 1–(\d+) of 2581/.exec(first)?.[1]);
  assert.ok(shown > 100 && shown < 2581, "shows a first page");
  const last = `e${shown - 1}`;
  assert.match(first, new RegExp(`continue with snapshot\\(\\{after: "${last}"\\}\\), or narrow with query`));
  assert.match(renderSnapshotView(page, { after: last }).text, new RegExp(`^\\[e${shown}\\]`), "the next page starts right after the cursor");
  const shifted = page.filter((e) => !["e3", "e4", "e5"].includes(e.ref));
  assert.match(renderSnapshotView(shifted, { after: last }).text, new RegExp(`^\\[e${shown}\\]`), "elements removed before the cursor do not make the next page skip any");
  assert.match(renderSnapshotView(page, { after: "e999999" }).text, /\[e999999\] is no longer on the page, so this starts again from the first element/);
  assert.ok(renderSnapshotView(page, { limit: 2581 }).text.length < SNAPSHOT_CHAR_BUDGET + 600, "an explicit large limit cannot bypass the budget");
  const nested = page.map((e, i) => (i ? { ...e, parentRef: `e${i - 1}` } : e));
  assert.ok(renderSnapshotView(nested).text.length < SNAPSHOT_CHAR_BUDGET + 600, "indentation counts toward the budget");
  const login = renderSnapshotView(page, { query: "登录" }).text;
  assert.match(login, /\[e1500\] textbox "登录\/注册"/);
  assert.match(login, /1 of 2581 elements match query="登录"/);
  assert.equal((renderSnapshotView(page, { query: "TEXTBOX", limit: 5 }).text.match(/^\[e\d+\] textbox/gm) ?? []).length, 5);
  assert.match(renderSnapshotView(page, { viewportOnly: true }).text, /40 of 2581 elements match viewportOnly/);
  assert.match(renderSnapshotView(page, { query: "不存在" }).text, /nothing to show for query="不存在".*0 of 2581/);
  assert.match(renderSnapshotView(page, {}, { tool: "analyze_page" }).text, /this snapshot section is paged — call snapshot\(\{after: "e\d+"\}\)/, "analyze_page points at snapshot, whose parameters these are");
  const small = elements(3);
  assert.equal(renderSnapshotView(small).partial, false);
  assert.doesNotMatch(renderSnapshotView(small).text, /showing|continue/);
});

test("the delta says the rest was already read only when nothing was left out, now or last time", () => {
  const changed = { added: ["e9"], removed: 0 };
  const small = elements(3);
  assert.match(renderSnapshotView(small, {}, { changed }).text, /the rest is what you already read/);
  assert.doesNotMatch(renderSnapshotView(small, {}, { changed, previousPartial: true }).text, /already read/, "上一次回复只给了一部分");
  assert.doesNotMatch(renderSnapshotView(small, { query: "职位" }, { changed }).text, /already read/, "这一次只给了一部分");
  assert.equal(renderSnapshotView(small, { query: "职位" }).partial, true);
});

test("the window the user is on is named even while Chrome is in the background", () => {
  assert.match(windowFocusLabel(2, 2, 2), /OS-focused/);
  assert.equal(windowFocusLabel(3, 2, 2), "");
  assert.match(windowFocusLabel(3, null, 3), /last focused — no window of this browser is in front/);
  assert.equal(windowFocusLabel(3, null, undefined), "", "old extensions without lastFocusedWindowId mark nothing");
  assert.match(windowFocusLegend(2, null), /several \* are normal.*No window of this browser has OS focus/);
  // Another profile of the same browser also leaves this one with no focused window, so neither text may claim
  // that a different application is in front.
  assert.doesNotMatch(windowFocusLegend(2, null) + windowFocusLabel(1, null, 1), /another app is in front|foreground app/);
  assert.equal(windowFocusLegend(1, 7), "");
});

test("the desktop client switches eval and the screenshot folder in a running backend through its ingress", async () => {
  const restore = restoreEnv(["BCP_EVAL", "BCP_LOCAL_EVAL", "BCP_SCREENSHOT_DIR", "BCP_POLICY_TOKEN", "BCP_DESKTOP", "BCP_DESKTOP_TOKEN"]);
  const dynamicImport = new Function("url", "return import(url)") as (url: string) => Promise<Record<string, any>>;
  const { Coordinator } = await dynamicImport(new URL("../../desktop/src/coordinator.mjs", import.meta.url).href);
  const { createIngress } = await dynamicImport(new URL("../../desktop/src/ingress.mjs", import.meta.url).href);
  // The backend's real internal app, desktop guard included: a hand-built express app without it is how a policy
  // request missing the desktop Authorization header passed here and failed every real start with 401.
  process.env.BCP_DESKTOP = "1";
  process.env.BCP_DESKTOP_TOKEN = config.internalToken;
  const runner = new InternalRunner({} as never, {} as never, {} as never, undefined, createBrowserHttpRouter({} as BrowserSetupService, {} as BrowserDispatcher));
  const address = { port: await runner.listen(0) };
  const coordinator = new Coordinator({ paths: { userData: tmpdir() }, fork: () => {}, safeStorage: {} });
  coordinator.token = config.internalToken;
  coordinator.phase = "ready";
  coordinator.supervisor = { endpoints: { backend: { internal: `http://127.0.0.1:${address.port}` } } };
  coordinator.atomic = async () => {};
  process.env.BCP_POLICY_TOKEN = coordinator.policyToken;
  const ingress = await createIngress({ token: config.internalToken, nativeToken: "unused", resolve: () => `http://127.0.0.1:${address.port}`, discover: () => ({}), sample: "" });
  coordinator.ingress = ingress;
  try {
    process.env.BCP_EVAL = "on";
    await coordinator.savePolicy({ allowEval: false });
    assert.equal(config.evalEnabled, false, "关闭立即在运行中的后端生效");
    process.env.BCP_LOCAL_EVAL = "on";
    await coordinator.savePolicy({ allowLocalEval: false });
    assert.equal(config.localEvalEnabled, false, "本机脚本同样在运行中切换");
    await coordinator.savePolicy({ allowLocalEval: true });
    assert.equal(config.localEvalEnabled, true);
    const folder = resolve(tmpdir(), "bcp-policy-screens");
    await coordinator.savePolicy({ allowEval: true, screenshotDir: folder });
    assert.equal(config.evalEnabled, true);
    assert.equal(resolveShotPath("x.png"), join(folder, "x.png"));
    await coordinator.savePolicy({ screenshotDir: null });
    assert.equal(process.env.BCP_SCREENSHOT_DIR, undefined);
    await assert.rejects(coordinator.savePolicy({ screenshotDir: "relative/dir" }), /完整路径/);
    // The token MCP clients hold opens the ingress, but never the policy: only the coordinator's own secret does.
    const headers = { Authorization: `Bearer ${config.internalToken}`, "X-BCP-Internal-Token": config.internalToken, "Content-Type": "application/json" };
    const proxied = await fetch(`${ingress.origin}/__bcp/backend/internal/browsers/POLICY`, { method: "POST", headers, body: '{"eval":false}' });
    assert.equal(proxied.status, 403, "经入口代理改策略一律拒绝");
    const direct = await fetch(`http://127.0.0.1:${address.port}/internal/browsers/policy`, { method: "POST", headers, body: '{"eval":false}' });
    assert.equal(direct.status, 403, "只有内部令牌、没有策略令牌也改不了");
    assert.equal(config.evalEnabled, true);
  } finally {
    restore();
    await ingress.close(); await runner.close();
  }
});

test("微信桥默认关闭，只有 BCP_WECLAW_ENABLE 打开它，BCP_WECLAW_DISABLE 仍能强制关闭", async () => {
  const restore = restoreEnv(["BCP_WECLAW_ENABLE", "BCP_WECLAW_DISABLE"]);
  try {
    const fresh = async () => (await import(`./config.js?weclaw=${Math.random()}`)).config.weclawDisabled as boolean;
    delete process.env.BCP_WECLAW_ENABLE; delete process.env.BCP_WECLAW_DISABLE;
    assert.equal(await fresh(), true, "首次使用不需要 Go 和微信扫码");
    process.env.BCP_WECLAW_ENABLE = "1";
    assert.equal(await fresh(), false);
    process.env.BCP_WECLAW_DISABLE = "1";
    assert.equal(await fresh(), true);
  } finally { restore(); }
});
