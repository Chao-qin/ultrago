#!/usr/bin/env node
/**
 * `pnpm doctor` — check every step between a fresh clone and an agent driving
 * the browser, say exactly what is missing, and fix what can be fixed.
 *
 *   pnpm doctor          # check only
 *   pnpm doctor --fix    # also create .env and seed the console data
 *
 * Read-only unless --fix. It never starts or stops services and never
 * restarts the user's browser — those it only tells you how to do.
 */
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Kept in sync with CHROME_RENDERING_FLAGS in packages/shared/src/browser-lifecycle.ts (asserted by a test). */
export const CHROME_RENDERING_FLAGS = [
  "--disable-features=CalculateNativeWinOcclusion",
  "--disable-backgrounding-occluded-windows",
];
const DEFAULT_TOKEN = "bcp-dev-token";

/** Values from .env, overridden by the process environment (the same precedence backend.sh uses). */
export function readEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const on = (v) => /^(on|1|true|yes)$/i.test((v ?? "").trim());
const off = (v) => /^(off|0|false|no)$/i.test((v ?? "").trim());

/**
 * Is the running Chrome rendering covered windows? Takes process command lines
 * and looks at the BROWSER process only — renderer/GPU helpers carry --type=.
 */
export function chromeFlagStatus(commandLines) {
  const browsers = commandLines.filter(
    (c) =>
      /(google chrome|chrome\.exe|\/chrome(?:\s|$))/i.test(c) &&
      !/--type=/.test(c) && // renderer / GPU / utility helpers
      !/chrome_crashpad|crashpad_handler/i.test(c) &&
      // automation browsers launched with their own flags: Playwright/Puppeteer, the backend's managed profile
      !/--headless|--remote-debugging-(port|pipe)|ms-playwright|[\\/]\.bcp[\\/]browser/i.test(c),
  );
  if (!browsers.length) return { running: false, missing: [] };
  // One root process per running profile; any of them may be the one the user drives.
  const missing = CHROME_RENDERING_FLAGS.filter((f) => browsers.some((cmd) => !cmd.includes(f)));
  return { running: true, missing };
}

function chromeCommandLines() {
  if (process.platform === "win32") {
    const r = spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: "utf8", timeout: 15_000 });
    return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
  }
  const r = spawnSync("ps", ["-axww", "-o", "command="], { encoding: "utf8", timeout: 10_000 });
  return (r.stdout ?? "").split("\n").filter(Boolean);
}

async function fetchJson(url, ms = 3000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { ok: res.ok, status: res.status, body: res.ok ? await res.json().catch(() => null) : null };
  } catch {
    return { ok: false, status: 0, body: null };
  } finally {
    clearTimeout(t);
  }
}

const list = (b) => (Array.isArray(b) ? b : (b?.items ?? []));

export async function runDoctor({ fix = false, log = console.log } = {}) {
  const results = [];
  const add = (level, title, detail = "", fixHint = "") => results.push({ level, title, detail, fixHint });

  // ── Environment ──
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) add("ok", `Node.js ${process.versions.node}`);
  else add("fail", `Node.js ${process.versions.node} 过旧`, "需要 Node.js 20 或更高版本", "安装 Node.js 22");
  if (existsSync(resolve(ROOT, "node_modules"))) add("ok", "依赖已安装");
  else add("fail", "依赖未安装", "", "pnpm run init");

  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath) && fix && existsSync(resolve(ROOT, ".env.example"))) {
    copyFileSync(resolve(ROOT, ".env.example"), envPath);
    add("ok", "已从 .env.example 创建 .env");
  }
  const env = { ...(existsSync(envPath) ? readEnv(readFileSync(envPath, "utf8")) : {}), ...process.env };
  if (!existsSync(envPath)) add("warn", "没有 .env，全部使用默认值", "", "pnpm doctor --fix（或 pnpm run init）");
  const token = env.BCP_TOKEN?.trim();
  if (token && token !== DEFAULT_TOKEN)
    add("warn", "BCP_TOKEN 是自定义值", "扩展侧边栏 ⚙ 里的 token 必须填同一个值，否则扩展连不上", "在扩展侧边栏填写同一个 token，或把 BCP_TOKEN 留空使用默认值");
  else add("ok", "token 与扩展默认值一致");
  add("ok", `页面脚本 eval：${off(env.BCP_EVAL) ? "关闭" : "开启"}；本机脚本 local_eval：${off(env.BCP_LOCAL_EVAL) ? "关闭" : "开启"}`);
  add("ok", `可选组件：微信桥 ${on(env.BCP_WECLAW_ENABLE) && !on(env.BCP_WECLAW_DISABLE) ? "开启" : "关闭"}，本地模型 ${on(env.BCP_LLM_ENABLE) ? "开启" : "关闭"}`);

  // ── Data ──
  if (existsSync(resolve(ROOT, "resource/db/console.db"))) add("ok", "工作台数据库已创建");
  else add("fail", "工作台数据库不存在", "", "pnpm run init");

  // ── Services ──
  const mcpPort = env.BCP_MCP_PORT || "8788";
  const consolePort = env.CONSOLE_PORT || "8790";
  const internalPort = env.BCP_INTERNAL_PORT || "8789";
  const consoleUrl = `http://127.0.0.1:${consolePort}`;
  const health = await fetchJson(`http://127.0.0.1:${internalPort}/internal/health`);
  const backendUp = health.ok;
  if (backendUp) add("ok", "浏览器服务（backend）在运行", `MCP 端点 http://127.0.0.1:${mcpPort}/mcp`);
  else add("fail", "浏览器服务（backend）没有运行", "", "pnpm start");
  const consoleHealth = await fetchJson(`${consoleUrl}/api/health`);
  if (consoleHealth.ok) {
    add("ok", "工作台（console）在运行", consoleUrl);
    const [schemas, books, flows] = await Promise.all([
      // Same counting rule as seed-console: deleted / inactive rows count as present.
      fetchJson(`${consoleUrl}/api/schemas?includeInactive=true&includeDeleted=true`), fetchJson(`${consoleUrl}/api/books`), fetchJson(`${consoleUrl}/api/flows?includeDeleted=true`),
    ]);
    const { SEEDED_FLOWS, seedConsole } = await import("./seed-console.mjs");
    const flowNames = list(flows.body).map((f) => f.name);
    const gaps = [
      list(schemas.body).length === 0 && "契约注册表为空",
      list(books.body).length === 0 && "剧本尚未索引",
      ...SEEDED_FLOWS.filter((f) => !flowNames.includes(f.name)).map((f) => `缺少流程「${f.name}」`),
    ].filter(Boolean);
    if (!gaps.length) add("ok", "工作台数据完整");
    else if (fix) {
      const r = await seedConsole(consoleUrl, { log });
      add(r.failed ? "fail" : "ok", r.failed ? "工作台数据补齐失败" : "已补齐工作台数据", gaps.join("；"), r.failed ? "查看上面的 [seed] 行" : "");
    } else add("warn", "工作台数据不完整", gaps.join("；"), "pnpm doctor --fix");
  } else add(backendUp ? "fail" : "warn", "工作台（console）没有运行", "", "pnpm start");

  // ── Browser ──
  const connected = backendUp ? list((await fetchJson(`http://127.0.0.1:${internalPort}/internal/browsers/connected`)).body) : [];
  if (connected.length) add("ok", `扩展已连接：${connected.map((b) => `${b.kind}:${b.instanceId}`).join("、")}`);
  else if (backendUp)
    add("fail", "没有浏览器扩展连接", "扩展需要先构建并以「加载已解压的扩展程序」装进 Chrome", "pnpm --filter @bcp/extension build，再在 chrome://extensions 加载 packages/extension/.output/chrome-mv3");
  const chrome = chromeFlagStatus(chromeCommandLines());
  if (!chrome.running) add("warn", "Chrome 没有在运行", "", "用 launch_browser 打开，或按 README 带参数启动 Chrome");
  else if (chrome.missing.length)
    add("fail", "Chrome 启动时没带渲染参数", "被其他窗口挡住的任务窗口会停止渲染：弹窗关不掉、输入不生效、截图读不回",
      `彻底退出 Chrome 后用这些参数重新打开：${CHROME_RENDERING_FLAGS.join(" ")}（Chrome 没在运行时，launch_browser 会自动带上）`);
  else add("ok", "Chrome 带着渲染参数在运行");

  // ── Agent ──
  // shell on Windows: the CLI is installed as claude.cmd, which spawn cannot run directly.
  const claude = spawnSync("claude", ["mcp", "list"], { encoding: "utf8", timeout: 20_000, shell: process.platform === "win32" });
  const addCmd = `claude mcp add --transport http ultrago http://127.0.0.1:${mcpPort}/mcp`;
  if (claude.error || (process.platform === "win32" && claude.status !== 0 && !claude.stdout)) add("warn", "没找到 Claude Code 命令行，无法检查助手接入", "其他 MCP 客户端请连接上面的 MCP 端点", addCmd);
  else if ((claude.stdout ?? "").includes(`:${mcpPort}/mcp`)) add("ok", "Claude Code 已接入 MCP 端点");
  else add("warn", "Claude Code 还没接入本机 MCP 端点", "", addCmd);

  const mark = { ok: "✓", warn: "!", fail: "✗" };
  for (const r of results) {
    log(`${mark[r.level]} ${r.title}${r.detail ? ` — ${r.detail}` : ""}`);
    if (r.fixHint && r.level !== "ok") log(`    → ${r.fixHint}`);
  }
  const failed = results.filter((r) => r.level === "fail").length;
  log(failed ? `\n${failed} 项需要处理。` : "\n可以开始使用了。");
  return { results, failed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runDoctor({ fix: process.argv.includes("--fix") }).then(({ failed }) => { process.exitCode = failed ? 1 : 0; });
}
