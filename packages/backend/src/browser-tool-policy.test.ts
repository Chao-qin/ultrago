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
  const shown = Number(/^Coverage: (\d+) of the page's 2581 elements listed here \(1–\1 of 2581 visible elements\)/.exec(first)?.[1]);
  assert.ok(shown > 100 && shown < 2581, "shows a first page");
  const last = `e${shown - 1}`;
  assert.match(first, new RegExp(`· next page: snapshot\\(\\{after: "${last}"\\}\\) ·`));
  assert.match(renderSnapshotView(page, { after: last }).text, new RegExp(`\\n\\n\\[e${shown}\\]`), "the next page starts right after the cursor");
  const shifted = page.filter((e) => !["e3", "e4", "e5"].includes(e.ref));
  assert.match(renderSnapshotView(shifted, { after: last }).text, new RegExp(`\\n\\n\\[e${shown}\\]`), "elements removed before the cursor do not make the next page skip any");
  assert.match(renderSnapshotView(page, { after: "e999999" }).text, /\[e999999\] is no longer on the page, so this starts again from the first element/);
  assert.ok(renderSnapshotView(page, { limit: 2581 }).text.length < SNAPSHOT_CHAR_BUDGET + 600, "an explicit large limit cannot bypass the budget");
  const nested = page.map((e, i) => (i ? { ...e, parentRef: `e${i - 1}` } : e));
  assert.ok(renderSnapshotView(nested).text.length < SNAPSHOT_CHAR_BUDGET + 600, "indentation counts toward the budget");
  const login = renderSnapshotView(page, { query: "登录" }).text;
  assert.match(login, /\[e1500\] textbox "登录\/注册"/);
  assert.match(login, /^Coverage: 1 of the page's 2581 elements listed here \(all 1 elements matching query="登录"\)/);
  assert.equal((renderSnapshotView(page, { query: "TEXTBOX", limit: 5 }).text.match(/^\[e\d+\] textbox/gm) ?? []).length, 5);
  assert.match(renderSnapshotView(page, { viewportOnly: true }).text, /\(all 40 elements matching viewportOnly\)/);
  const none = renderSnapshotView(page, { query: "不存在" }).text;
  assert.match(none, /^Coverage: 0 of the page's 2581 elements listed here \(none of 0 elements matching query="不存在"\)/);
  assert.match(none, /\(no element's role, name, value or options contain "不存在"\)/);
  assert.doesNotMatch(none, /widen the query/, "不再叫读者换词再猜");
  const small = elements(3);
  assert.equal(renderSnapshotView(small).shown.length, 3, "the reply reports exactly the refs it listed");
  assert.doesNotMatch(renderSnapshotView(small).text, /next page/);
  assert.match(renderSnapshotView(small).text, /that is the whole page/);
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
  const restore = restoreEnv(["BCP_EVAL", "BCP_LOCAL_EVAL", "BCP_SCREENSHOT_DIR", "BCP_CLOUD_CAPTCHA", "BCP_POLICY_TOKEN", "BCP_DESKTOP", "BCP_DESKTOP_TOKEN"]);
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
    delete process.env.BCP_CLOUD_CAPTCHA;
    assert.equal(config.cloudCaptchaEnabled, false, "云端识别验证码默认关闭");
    await coordinator.savePolicy({ allowCloudCaptcha: true });
    assert.equal(config.cloudCaptchaEnabled, true, "打开后运行中的后端立即允许");
    await coordinator.savePolicy({ allowEval: true });
    assert.equal(config.cloudCaptchaEnabled, true, "改别的开关不会把它推回关闭");
    await coordinator.savePolicy({ allowCloudCaptcha: false });
    assert.equal(config.cloudCaptchaEnabled, false);
    await assert.rejects(coordinator.savePolicy({ allowCloudCaptcha: "yes" }), /云端识别验证码开关无效/);
    const policyHeaders = { Authorization: `Bearer ${config.internalToken}`, "X-BCP-Policy-Token": coordinator.policyToken, "Content-Type": "application/json" };
    const invalid = await fetch(`http://127.0.0.1:${address.port}/internal/browsers/policy`, { method: "POST", headers: policyHeaders, body: '{"cloudCaptcha":"on"}' });
    assert.equal(invalid.status, 400, "后端只接受布尔值");
    assert.equal(config.cloudCaptchaEnabled, false);
    // The token MCP clients hold opens the ingress, but never the policy: only the coordinator's own secret does.
    const headers = { Authorization: `Bearer ${config.internalToken}`, "X-BCP-Internal-Token": config.internalToken, "Content-Type": "application/json" };
    const proxied = await fetch(`${ingress.origin}/__bcp/backend/internal/browsers/POLICY`, { method: "POST", headers, body: '{"eval":false}' });
    assert.equal(proxied.status, 403, "经入口代理改策略一律拒绝");
    const direct = await fetch(`http://127.0.0.1:${address.port}/internal/browsers/policy`, { method: "POST", headers, body: '{"eval":false}' });
    assert.equal(direct.status, 403, "只有内部令牌、没有策略令牌也改不了");
    const lookalike = `é${coordinator.policyToken.slice(1)}`;
    const nonAscii = await fetch(`http://127.0.0.1:${address.port}/internal/browsers/policy`, { method: "POST", headers: { ...headers, "X-BCP-Policy-Token": lookalike }, body: '{"eval":false}' });
    assert.equal(nonAscii.status, 403, "长度相同但含非 ASCII 字符的令牌是拒绝，不是 500");
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

test("必须先验证由观察到的事实推导：导航、页面自己的对话框、新标签页都算；回答了取消的 confirm 要写明它守护的动作没有执行", async () => {
  const { deltaGate, renderDelta, renderHistoryNav, mergeDeltas } = await import("./browser-mcp-render.js");
  assert.equal(deltaGate({ urlChanged: "https://x/" }), "the page navigated");
  assert.equal(deltaGate({ tabsOpened: [{ tabId: 7 }] }), "a new tab opened");
  assert.equal(deltaGate({ pageDialogs: [{ kind: "alert", message: "保存失败" }] }), "the page opened its own dialog");
  assert.equal(deltaGate({ dispatchedTo: "a" }), null, "没有变化就不拦");
  const line = renderDelta({ pageDialogs: [{ kind: "confirm", message: "确定删除?", answered: "Cancel" }], tabsOpened: [{ tabId: 7, url: "https://n/" }] });
  assert.match(line, /page confirm\("确定删除\?"\) answered Cancel — what it guarded did not proceed/);
  assert.match(line, /opened tab 7 \(https:\/\/n\/\)/);
  assert.match(renderHistoryNav("back", { navigated: true, url: "https://a/" }), /⚠ Verify gate — the page navigated/);
  assert.doesNotMatch(renderHistoryNav("back", { navigated: false }), /Verify gate/, "没动就不拦");
  const merged = mergeDeltas({ newErrors: ["文件过大"], elementDelta: 1 }, { elementDelta: 2 });
  assert.deepEqual([merged?.newErrors, merged?.elementDelta], [["文件过大"], 3], "后一个文件的回执不能抹掉前一个的报错");
});

test("读取时还有请求开着：回复说出几个、最久多久、哪个地址（主机加路径，不带查询参数）", async () => {
  const { renderPendingRequests } = await import("./browser-mcp-render.js");
  assert.match(renderPendingRequests({ count: 2, oldestMs: 4100, oldestUrl: "https://shop.x/api/search?token=secret" }),
    /⏳ 2 request\(s\) were still open when this was read \(oldest 4\.1s: shop\.x\/api\/search\) — .* read again/);
  assert.equal(renderPendingRequests({ count: 0, oldestMs: 0, oldestUrl: "" }), "");
});
