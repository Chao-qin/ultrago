#!/usr/bin/env node
/**
 * Snapshot task benchmark — does a change to the snapshot reply make a real agent fail more, or work harder?
 *
 * The census (scripts/snapshot-census.mjs) measures what a reply costs; this measures what an agent does with it.
 * For each task in bench/tasks/tasks.json it runs `claude -p` against a live stack built from the checkout under
 * test, with that stack's MCP server as the ONLY tool source, and judges the outcome with the task's deterministic
 * check. Run it once on the PR base and once on the PR head; the success rate must not drop.
 *
 *   node scripts/snapshot-task-bench.mjs --checkout <dir> --label <name> [--only id,id] [--max-turns 25]
 *                                        [--timeout 300] [--port-base 18787] [--model sonnet] [--budget 0.5]
 *
 * The stack, per run: the checkout's built backend (packages/backend/dist, weclaw off, its own ports, a throwaway
 * BCP_BROWSER_ROOT so a real ~/.bcp is never touched, page and local scripts off) + a headless Playwright Chromium with a copy of the checkout's
 * built extension (packages/extension/.output/chrome-mv3) and a fresh throwaway profile — never a real browser
 * profile. A runtime-config.json in that copy points the extension at the run's backend port. Everything is stopped
 * on exit, including Ctrl-C. Tasks run one after another; the browser is reset to a single blank tab between them.
 *
 * Each claude run: fixed model, `--strict-mcp-config` with only this server, an explicit allowlist of its tools (no
 * browser launch/mode switch — `launch_browser` would open the user's own browser profile on macOS — no file
 * writes, uploads or playbooks), no built-in tools, no slash commands, user settings (hooks, CLAUDE.md) not loaded,
 * run from an empty directory, wall-clock and dollar caps per task (`--max-turns` is passed too, but the CLI does
 * not document it, so the dollar and time caps are what bound a run).
 * Judging reads the browser through Playwright (open tab URLs, DOM state) and a separate clean browser for the
 * expected answer — the agent never sees either.
 *
 * Prompts state only the goal (see tasks.json "about"): naming the control would do the perceiving for the agent,
 * and the snapshot is what is being measured. Each run also records how the agent read the page — how many
 * snapshot calls used the default view, query, within, full or paging — so a result says whether the code under
 * test was exercised at all.
 *
 * Output: bench/tasks/results-<label>.json (in THIS repo, so a base checkout can be measured by the head's script)
 * and a table. Raw stream-json transcripts and the backend log stay in the --logs directory (printed at the end).
 *
 * Missing toolchain or build, or a run whose MCP server was not connected → exit 2: a benchmark that measured
 * nothing (or a broken stack) must never read as a result — a failing base would make any head look "no worse".
 */
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "../packages/extension/scripts/toolchain.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TASKS = resolve(ROOT, "bench/tasks/tasks.json");

/* ------------------------------- arguments ------------------------------- */
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") ? "1" : all[i + 1] ?? "1"]] : acc), []),
);
const die = (msg, code = 2) => {
  console.error(`snapshot-task-bench: ${msg}`);
  process.exit(code);
};
if (!args.label || !/^[\w.-]+$/.test(args.label)) die("--label <name> is required ([A-Za-z0-9_.-])");
const checkout = resolve(args.checkout ?? ROOT);
const maxTurns = Number(args["max-turns"] ?? 25);
const timeoutSec = Number(args.timeout ?? 300);
const portBase = Number(args["port-base"] ?? 18787);
const model = args.model ?? "sonnet";
const budgetUsd = Number(args.budget ?? 0.5);
const only = args.only ? new Set(args.only.split(",")) : null;

/* ------------------------------- toolchain ------------------------------- */
const BACKEND = join(checkout, "packages/backend/dist/index.js");
const EXTENSION = join(checkout, "packages/extension/.output/chrome-mv3");
const missing = [];
if (!existsSync(BACKEND)) missing.push(`no backend build at ${BACKEND}`);
if (!existsSync(join(EXTENSION, "manifest.json"))) missing.push(`no extension build at ${EXTENSION}`);
if (missing.length)
  die(`${missing.join("; ")}.\n  build it in ${checkout}: pnpm install --frozen-lockfile && pnpm --filter "@bcp/backend^..." build && pnpm --filter @bcp/backend build && pnpm --filter @bcp/extension build\nExiting 2.`);
const pw = await loadPlaywright();
if (!pw) die("playwright-core not found (see packages/extension/scripts/toolchain.mjs). Exiting 2.");
/** A full Chromium, not branded Chrome (which ignores --load-extension) and not the headless shell (no extensions). */
const chromePath =
  process.env.CHROME_PATH ||
  (() => {
    const cache = join(process.env.HOME ?? "/root", ".cache/ms-playwright");
    const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1])) : [];
    return dirs.map((d) => join(cache, d, "chrome-linux64/chrome")).find(existsSync);
  })();
if (!chromePath || !existsSync(chromePath)) die("no Chromium found (set CHROME_PATH to a full Chromium, e.g. ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome). Exiting 2.");
let claudeVersion;
try {
  claudeVersion = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
} catch {
  die("the `claude` CLI is not on PATH. Exiting 2.");
}
const ports = { ws: portBase, mcp: portBase + 1, internal: portBase + 2 };
const portFree = (port) =>
  new Promise((ok) => {
    const s = createServer().once("error", () => ok(false)).once("listening", () => s.close(() => ok(true)));
    s.listen(port, "127.0.0.1");
  });
for (const [name, port] of Object.entries(ports)) if (!(await portFree(port))) die(`port ${port} (${name}) is in use — pick another --port-base. Exiting 2.`);

const { tasks: allTasks } = JSON.parse(readFileSync(TASKS, "utf8"));
const tasks = allTasks.filter((t) => !only || only.has(t.id));
if (!tasks.length) die(`no tasks selected (known: ${allTasks.map((t) => t.id).join(", ")})`);

const git = (...a) => {
  try {
    return execFileSync("git", ["-C", checkout, ...a], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
const logs = args.logs ? resolve(args.logs) : mkdtempSync(join(tmpdir(), `ultrago-task-bench-${args.label}-`));
mkdirSync(logs, { recursive: true });

/* --------------------------------- stack --------------------------------- */
const children = new Set();
let context;
let judgeBrowser;
let tearingDown = false;
async function teardown() {
  if (tearingDown) return;
  tearingDown = true;
  for (const c of children) killTree(c, "SIGTERM");
  await context?.close().catch(() => {});
  await judgeBrowser?.close().catch(() => {});
  await new Promise((r) => setTimeout(r, children.size ? 3000 : 0));
  for (const c of children) killTree(c, "SIGKILL");
}
function killTree(child, sig) {
  if (child.exitCode !== null || child.signalCode !== null) return children.delete(child);
  try {
    process.kill(-child.pid, sig);
  } catch {
    /* already gone */
  }
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void teardown().then(() => process.exit(130)));

const token = `bench-${Date.now().toString(36)}`;
const runDir = mkdtempSync(join(logs, "run-"));
const ext = join(runDir, "extension");
cpSync(EXTENSION, ext, { recursive: true });
writeFileSync(
  join(ext, "runtime-config.json"),
  JSON.stringify({ backendUrl: `ws://127.0.0.1:${ports.ws}`, token, browser: "chrome", instanceId: `bench-${args.label}`.slice(0, 60), artifactHash: "bench" }),
);

const backendLog = createWriteStream(join(logs, "backend.log"));
const backend = spawn(process.execPath, [BACKEND], {
  // An empty cwd: the backend loads ./.env, and a checkout's .env must not change the run (e.g. turn weclaw on).
  cwd: runDir,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    BCP_PORT: String(ports.ws),
    BCP_MCP_PORT: String(ports.mcp),
    BCP_INTERNAL_PORT: String(ports.internal),
    BCP_TOKEN: token,
    BCP_WECLAW_DISABLE: "1",
    BCP_WECLAW_ENABLE: "0",
    BCP_LLM_ENABLE: "0",
    BCP_BROWSER_ROOT: join(runDir, "bcp-root"),
    // What is measured is what an agent does with the snapshot. With eval on it reads the DOM directly and never
    // needs one (a first dry run answered a table lookup without a single snapshot call).
    BCP_EVAL: "off",
    BCP_LOCAL_EVAL: "off",
  },
});
children.add(backend);
const extensionReady = new Promise((ok, fail) => {
  const timer = setTimeout(() => fail(new Error("the extension did not connect within 45s")), 45_000);
  const watch = (buf) => {
    backendLog.write(buf);
    if (/\[ws\] extension ready/.test(String(buf))) {
      clearTimeout(timer);
      ok();
    }
  };
  backend.stdout.on("data", watch);
  backend.stderr.on("data", watch);
  backend.once("exit", (code) => fail(new Error(`backend exited (${code}) — see ${join(logs, "backend.log")}`)));
});
extensionReady.catch(() => {});

try {
  context = await pw.chromium.launchPersistentContext(join(runDir, "profile"), {
    executablePath: chromePath,
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-sandbox", "--no-first-run"],
  });
  await extensionReady;
  judgeBrowser = await pw.chromium.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox"] });
} catch (e) {
  await teardown();
  die(`stack did not come up: ${e.message}. Exiting 2.`);
}
console.log(`stack up: backend ${checkout} (ws ${ports.ws}, mcp ${ports.mcp}), Chromium ${chromePath}, logs ${logs}`);

/* --------------------------------- judging --------------------------------- */
const norm = (s) => String(s).toLowerCase().replace(/[\s,]+/g, "");
async function expected(check) {
  if (!check.answerFrom) return [];
  const page = await judgeBrowser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(check.answerFrom.url, { waitUntil: "load", timeout: 45_000 });
    const v = await page.evaluate(check.answerFrom.js);
    return (Array.isArray(v) ? v : [v]).filter(Boolean).map(String);
  } catch (e) {
    return { error: e.message.split("\n")[0] };
  } finally {
    await page.close();
  }
}
async function resetBrowser() {
  const blank = await context.newPage();
  for (const p of context.pages()) if (p !== blank) await p.close().catch(() => {});
  await blank.goto("about:blank");
}
async function judge(task, run, before) {
  const c = task.check;
  const reasons = [];
  const pages = context.pages();
  const urls = pages.map((p) => p.url());
  let matching = pages;
  if (c.url) {
    const re = new RegExp(c.url);
    matching = pages.filter((p) => re.test(p.url()));
    if (!matching.length) reasons.push(`no tab matches ${c.url}`);
  }
  if (c.forbidNavigate) {
    const re = new RegExp(c.forbidNavigate);
    const hit = run.calls.find((t) => /(^|__)(navigate|new_tab|new_window|eval)$/.test(t.name) && re.test(JSON.stringify(t.input)));
    if (hit) reasons.push(`bypassed the UI: ${hit.name} ${JSON.stringify(hit.input).slice(0, 120)}`);
  }
  if (c.tabState && matching.length) {
    const states = await Promise.all(matching.map((p) => p.evaluate(c.tabState).catch(() => false)));
    if (!states.some(Boolean)) reasons.push("page state check failed");
  }
  let want = [];
  if (c.answerFrom) {
    const after = await expected(c);
    if (after.error || before?.error) reasons.push(`judge could not read the expected answer: ${after.error ?? before.error}`);
    want = [...new Set([...(before && !before.error ? before : []), ...(after.error ? [] : after)])];
    const got = norm(run.answer ?? "");
    const found = want.find((w) => got.includes(norm(w)));
    if (!run.answer) reasons.push("no ANSWER line");
    else if (!found) reasons.push(`answer ${JSON.stringify(run.answer)} ∉ ${JSON.stringify(want)}`);
    if (c.urlHasAnswer && found && !matching.some((p) => p.url().includes(found))) reasons.push(`no matching tab URL contains ${found}`);
  }
  return { ok: !reasons.length && !run.timedOut, reasons: run.timedOut ? ["timed out", ...reasons] : reasons, expected: want, tabUrls: urls };
}

/* ------------------------------- claude runs ------------------------------- */
const mcpConfig = JSON.stringify({ mcpServers: { bcp: { type: "http", url: `http://127.0.0.1:${ports.mcp}/mcp` } } });
const promptFor = (t) =>
  [
    `You are driving a real Chrome browser through the "bcp" MCP tools. Start at ${t.startUrl} (navigate there first).`,
    `Task: ${t.prompt}`,
    "Reach the answer through the page itself: after opening the start page, do not navigate to URLs you type yourself.",
    "This is a read-only task: do not sign in, submit forms, post, or change any setting on the site.",
    "When you are done, leave the browser on the final page and end your reply with one line `ANSWER: <answer>` (write `ANSWER: done` when the task asks for no value).",
  ].join("\n");
/** What a task may use: reading, navigating and interacting with pages. Listed, not "every bcp tool": a tool added
 *  to the server later is not silently in the benchmark, and these are out on purpose — launch_browser /
 *  stop_browser / set_browser_mode / use_browser / claim_tab act outside the throwaway browser (launch_browser opens
 *  the user's real profile on macOS), write_file / download / upload_file / run_playbook / record_stop touch the
 *  backend host's files. */
const ALLOWED_TOOLS = [
  "analyze_page", "browser_state", "click", "close_tab", "double_click", "drag", "go_back", "go_forward", "hover",
  "list_windows", "navigate", "new_tab", "page_state", "paste_text", "pick_option", "press_key", "read_content",
  "read_content_dump", "read_events", "read_network", "reload", "right_click", "screenshot", "scroll", "select_option",
  "set_network_capture", "snapshot", "switch_tab", "type_text", "wait_for", "wait_for_event", "batch", "plan",
  "advance", "plan_status", "plan_abort", "eval", "local_eval",
].map((t) => `mcp__bcp__${t}`);
const DENIED_TOOLS = ["launch_browser", "stop_browser", "set_browser_mode", "use_browser", "claim_tab", "new_window", "close_window", "write_file", "download", "upload_file", "run_playbook", "list_playbooks", "record_stop"].map((t) => `mcp__bcp__${t}`);
/** Inherited Claude Code session variables would make the child think it is nested inside this session. */
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$)/.test(k)));
const cwd = join(runDir, "agent-cwd");
mkdirSync(cwd);

function runClaude(task) {
  return new Promise((done) => {
    const transcript = createWriteStream(join(logs, `${task.id}.stream.jsonl`));
    const started = Date.now();
    const child = spawn(
      "claude",
      [
        "-p", promptFor(task),
        "--output-format", "stream-json", "--verbose",
        "--model", model,
        "--max-turns", String(maxTurns),
        "--mcp-config", mcpConfig, "--strict-mcp-config",
        "--tools", "",
        "--allowedTools", ALLOWED_TOOLS.join(","),
        "--disallowedTools", DENIED_TOOLS.join(","),
        "--max-budget-usd", String(budgetUsd),
        "--setting-sources", "project",
        "--disable-slash-commands",
        "--no-session-persistence",
      ],
      { cwd, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.add(child);
    const run = { calls: [], timedOut: false, usageByMsg: new Map(), resultChars: 0, snapshotChars: 0, model: null, result: null, mcpStatus: null };
    const names = new Map();
    let buf = "";
    child.stdout.on("data", (d) => {
      transcript.write(d);
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "system" && ev.subtype === "init") {
          run.model = ev.model;
          run.mcpStatus = ev.mcp_servers;
        } else if (ev.type === "assistant") {
          if (ev.message?.usage) run.usageByMsg.set(ev.message.id, ev.message.usage);
          for (const b of ev.message?.content ?? [])
            if (b.type === "tool_use") {
              run.calls.push({ name: b.name, input: b.input });
              names.set(b.id, b.name);
            }
        } else if (ev.type === "user") {
          for (const b of ev.message?.content ?? [])
            if (b.type === "tool_result") {
              const n = (Array.isArray(b.content) ? b.content : [{ text: b.content }]).reduce((s, x) => s + (x.text?.length ?? 0), 0);
              run.resultChars += n;
              if (/__snapshot$/.test(names.get(b.tool_use_id) ?? "")) run.snapshotChars += n;
            }
        } else if (ev.type === "result") run.result = ev;
      }
    });
    child.stderr.on("data", (d) => transcript.write(d));
    const timer = setTimeout(() => {
      run.timedOut = true;
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), 5000);
    }, timeoutSec * 1000);
    child.once("exit", () => {
      clearTimeout(timer);
      children.delete(child);
      transcript.end();
      run.seconds = Math.round((Date.now() - started) / 100) / 10;
      const text = run.result?.result ?? "";
      run.answer = /^\s*ANSWER:\s*(.+?)\s*$/im.exec(text.split("\n").reverse().find((l) => /^\s*ANSWER:/i.test(l)) ?? "")?.[1] ?? null;
      done(run);
    });
  });
}

/* ---------------------------------- main ---------------------------------- */
const rows = [];
let mcpDown = 0;
try {
  for (const task of tasks) {
    await resetBrowser();
    const before = task.check.sampleBefore ? await expected(task.check) : null;
    process.stdout.write(`▶ ${task.id} … `);
    const run = await runClaude(task);
    const verdict = await judge(task, run, before);
    const u = run.result?.usage ?? [...run.usageByMsg.values()].reduce((s, x) => {
      for (const k of ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"]) s[k] = (s[k] ?? 0) + (x[k] ?? 0);
      return s;
    }, {});
    // How the page was read: a change to the default view is only measured by runs that read the default view.
    const snapshotViews = { default: 0, query: 0, within: 0, full: 0, after: 0, viewportOnly: 0 };
    for (const c of run.calls.filter((c) => /__snapshot$/.test(c.name))) {
      const keys = Object.keys(c.input ?? {}).filter((k) => k !== "tabId" && k !== "limit");
      if (!keys.length) snapshotViews.default++;
      for (const k of keys) if (k in snapshotViews) snapshotViews[k]++;
    }
    const byTool = {};
    for (const c of run.calls) byTool[c.name.replace(/^mcp__bcp__/, "")] = (byTool[c.name.replace(/^mcp__bcp__/, "")] ?? 0) + 1;
    const row = {
      task: task.id,
      hidden: task.hidden,
      ok: verdict.ok,
      reasons: verdict.reasons,
      turns: run.result?.num_turns ?? run.usageByMsg.size,
      toolCalls: run.calls.length,
      byTool,
      snapshotViews,
      inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      usage: { input: u.input_tokens ?? 0, cacheCreate: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 },
      toolResultChars: run.resultChars,
      snapshotChars: run.snapshotChars,
      seconds: run.seconds,
      costUsd: run.result?.total_cost_usd ?? null,
      stop: run.timedOut ? "timeout" : run.result?.subtype ?? "no-result",
      answer: run.answer,
      expected: verdict.expected,
      tabUrls: verdict.tabUrls,
      model: run.model,
    };
    rows.push(row);
    console.log(`${row.ok ? "ok" : "FAIL"} (${row.turns} turns, ${row.toolCalls} calls, ${row.seconds}s)${row.ok ? "" : " — " + row.reasons.join("; ")}`);
    if (!run.mcpStatus?.some((s) => s.name === "bcp" && s.status === "connected")) {
      mcpDown++;
      console.log(`  ⚠ MCP server status: ${JSON.stringify(run.mcpStatus)}`);
    }
  }
} finally {
  await teardown();
}

const sum = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
const totals = {
  tasks: rows.length,
  ok: rows.filter((r) => r.ok).length,
  okHidden: `${rows.filter((r) => r.ok && r.hidden).length}/${rows.filter((r) => r.hidden).length}`,
  turns: sum("turns"),
  toolCalls: sum("toolCalls"),
  inputTokens: sum("inputTokens"),
  snapshotChars: sum("snapshotChars"),
  defaultSnapshots: rows.reduce((s, r) => s + r.snapshotViews.default, 0),
  seconds: Math.round(sum("seconds")),
  costUsd: Math.round(sum("costUsd") * 100) / 100,
};
const out = resolve(ROOT, `bench/tasks/results-${args.label}.json`);
writeFileSync(
  out,
  JSON.stringify(
    {
      label: args.label,
      checkout,
      commit: git("rev-parse", "HEAD"),
      dirty: git("status", "--porcelain") ? true : false,
      ranAt: new Date().toISOString(),
      claude: claudeVersion,
      model: rows.find((r) => r.model)?.model ?? model,
      maxTurns,
      timeoutSec,
      budgetUsd,
      totals,
      results: rows,
    },
    null,
    2,
  ) + "\n",
);
console.table([
  ...rows.map((r) => ({ task: r.task, hidden: r.hidden ? "y" : "", ok: r.ok ? "✓" : "✗", turns: r.turns, "tool calls": r.toolCalls, "input tokens": r.inputTokens, "snapshot chars": r.snapshotChars, "default snaps": r.snapshotViews.default, seconds: r.seconds })),
  { task: "total", hidden: totals.okHidden, ok: `${totals.ok}/${totals.tasks}`, turns: totals.turns, "tool calls": totals.toolCalls, "input tokens": totals.inputTokens, "snapshot chars": totals.snapshotChars, "default snaps": totals.defaultSnapshots, seconds: totals.seconds },
]);
console.log(`results: ${out}\ntranscripts + backend log: ${logs}`);
if (mcpDown) die(`${mcpDown} task(s) ran without the bcp MCP server connected — this run measured a broken stack, not the snapshot. Exiting 2.`);
process.exit(0);
