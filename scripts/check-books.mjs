#!/usr/bin/env node
/**
 * check:books — playbook 里内联 JS 的离线回归。
 *
 * 为什么需要它：book 的 `browser.eval` / `local.eval` 步骤把几千字符的 JS 塞在
 * JSON 字符串里，既没有 typecheck 也没有 lint，改一次就可能坏一次，而失败信号
 * 往往只是一句含糊的 "reply is empty"。这个脚本把**真实 book 里的真实代码**取出来
 * 直接执行 —— 跑的不是逻辑复制品。
 *
 * 数据来源：`resource/playbooks/__fixtures__/<book>/*.sse.txt` 是从真实站点抓下来的原始
 * SSE 流（已脱敏：inner_user_ip / sec_sender 被替换）。协议是别人家的，任何
 * "我觉得它应该长这样" 的猜测都不算数，一律以抓到的原始流为准。
 *
 * 补抓新场景的姿势：往目标 tab 注入 book step 2 那段 fetch hook，然后**手动**发一条
 * 消息，再读 `window.__bcpDoubaoApi.chunks`。两个坑：(1) 豆包答完会整页导航到
 * `/chat/<conversationId>`，把 hook 连同已抓的流一起冲掉 —— 要在导航前读，或重新注入
 * 后再问一次；(2) 让 book 自己跑来抓会烧对方的风控配额（2026-08-23 连跑 7 次就被
 * rate limited），手动发等同普通用户行为，更安全。
 *
 * 与 `check:dom` 的分工：check:dom 覆盖扩展注入的 bcpDomRuntime（要真实浏览器）；
 * 本脚本覆盖 book 内联 JS 的纯逻辑（纯 node，无浏览器、无网络）。
 *
 * 缺 fixture 时 exit 2 而非静默通过 —— 没验证过的防线是假防线。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 内联 JS 允许写成行数组（见 packages/shared/src/book-code.ts）。本文件的每一条
// lint 都按「code 是字符串」写的——语法编译、等待预算的正则匹配，拿到数组会静默
// 失效（`WAITS.test(数组)` 走的是 Array→String 的隐式转换，逗号连接，正则大概率
// 不再命中）。所以解析入口只留这一个，parse 完立刻归一化，不给漏网的机会。
const { normalizeBookCode } = await import(
  new URL("../packages/shared/dist/book-code.js", import.meta.url)
);
const parseBook = (absPath) => {
  const raw = JSON.parse(readFileSync(absPath, "utf8"));
  normalizeBookCode(raw);
  return raw;
};
const bookPath = (f) => resolve(ROOT, "resource/playbooks", f.endsWith(".json") ? f : `${f}.json`);
const book = (name) => parseBook(bookPath(name));

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const grab = (fn) => { try { return { out: fn() }; } catch (e) { return { err: e.message }; } };

// ──────────────── 全仓 lint · eval 里的等待必须有钟 ────────────────
// browser.eval is killed page-side at EVAL_TIMEOUT_MS, and a book that waits
// past it dies with a bare "eval timed out" — the book's own deadline is not
// consulted. Nothing else in the toolchain notices: codegen, typecheck and the
// fixture suites all pass a step that declares `Date.now() + 300000`. So the
// rule is enforced here, and it is a RULE, not an estimate: if an eval waits,
// it must carry a wall-clock hard stop, and that stop must leave the cap room
// to spare. Anything that genuinely needs longer belongs in a signal gate.
// ──────────────── 全仓 lint · v2 结构必须能被运行时加载 ────────────────
// 这条 lint 是补上来的：本文件此前只检查 eval 里的等待、超时预算这些【内容】，
// 从不做 v2 【结构】校验。于是一本缺 gate 的书能拿到「163 passed」，却在
// run_playbook 时被 validateBookV2 当场拒绝加载——检查全绿而东西根本跑不起来，
// 是最坏的一种假防线。用运行时同一个校验函数，不另写一套判断。
console.log("全仓 lint · v2 结构（与运行时同一个校验器）");
const { validateBookV2 } = await import(
  new URL("../packages/shared/dist/book-signals.js", import.meta.url)
);
for (const f of readdirSync(resolve(ROOT, "resource/playbooks")).filter((x) => x.endsWith(".json"))) {
  const name = basename(f, ".json");
  let raw;
  try {
    raw = parseBook(bookPath(f));
  } catch (e) {
    check(`${name} · JSON 可解析`, false, e.message);
    continue;
  }
  // 只有 v2（带 pages）才走 v2 校验；老格式的书不在这条规则的管辖内。
  if (!raw || typeof raw !== "object" || !raw.pages) continue;
  const r = grab(() => validateBookV2(raw));
  check(`${name} · v2 结构可被运行时加载`, !r.err, r.err);
}

console.log("全仓 lint · eval 等待预算");

// Read the cap from its SSOT rather than restating it — a restated limit is
// exactly the drift this lint exists to catch. Missing → exit 2, not a pass.
const SHARED_INDEX = resolve(ROOT, "packages/shared/src/index.ts");
const SHARED_SRC = readFileSync(SHARED_INDEX, "utf8");
const capMatch = SHARED_SRC.match(/export const EVAL_TIMEOUT_MS = ([\d_]+)/);
if (!capMatch) {
  console.error(`\n在 ${SHARED_INDEX} 里找不到 EVAL_TIMEOUT_MS —— 这条 lint 失去了基准，拒绝静默通过。`);
  process.exit(2);
}
const EVAL_CAP_MS = Number(capMatch[1].replaceAll("_", ""));
// The headroom below the cap is itself SSOT'd — recomputing `* 0.8` here would
// be the same duplicated-threshold bug this lint exists to catch.
const budgetMatch = SHARED_SRC.match(/export const EVAL_SAFE_BUDGET_MS = Math\.round\(EVAL_TIMEOUT_MS \* ([\d.]+)\)/);
if (!budgetMatch) {
  console.error(`\n在 ${SHARED_INDEX} 里找不到 EVAL_SAFE_BUDGET_MS —— 这条 lint 失去了基准，拒绝静默通过。`);
  process.exit(2);
}
const BUDGET_FACTOR = Number(budgetMatch[1]);
const WAIT_BUDGET_MS = Math.round(EVAL_CAP_MS * BUDGET_FACTOR);
// Extending the runtime-injected deadline defeats the point of injecting it.
const DEADLINE_EXTENSION = /\bbcpDeadline\s*\+\s*\d/;

const WAITS = /await new Promise|setTimeout\(|setInterval\(/;
const HARD_STOPS = /Date\.now\(\)\s*\+\s*(\d+)/g;

const evalSites = (pb, file) => {
  const out = [];
  (pb.steps ?? []).forEach((step, i) => {
    // browser.eval 与 local.eval 的 code 都是 JSON 字符串里的裸 JS：没有 typecheck、
    // 没有 lint，写坏了只能等跑到那一步才炸。2026-09-03 实测：一段 local.eval 里残留了
    // 未插值的 `${first}`（生成器多套了一层引号），book 照常通过校验、跑批跑了 13 分钟
    // 才在合并步倒下 —— 只因为这里当初只收了 browser.eval。两种都要收。
    if ((step.action?.method === "browser.eval" || step.action?.method === "local.eval") && typeof step.action.params?.code === "string") {
      out.push({ file, step: i + 1, where: "action", code: step.action.params.code, method: step.action.method });
    }
    const vc = step.verify?.evalCheck?.code;
    if (typeof vc === "string") out.push({ file, step: i + 1, where: "verify.evalCheck", code: vc });
  });
  return out;
};

/** 每个 signal 的 script 判据。`condition` 可以任意深地嵌在 all/any 里，所以递归收。
 *
 * 为什么单独收、不并进 evalSites：signal 的编译方式和 step 的 eval【不一样】。
 * dom-runtime 对 signal 用 `new Function('"use strict"; return (' + code + ');')()`
 * —— 只认表达式，**没有语句块回退**。step 的 eval 有回退（表达式失败退语句块），
 * 所以同一段代码在 step 里能跑、挪进 signal 就永久静默失效。规则更严，得分开判。
 *
 * 2026-09-04 发现这里此前【完全没有扫描】：evalSites 只收 step 的 action 与
 * verify.evalCheck，signal 一个都不收。最脆的一类反而没有防线。 */
const signalSites = (pb, file) => {
  const out = [];
  for (const [page, def] of Object.entries(pb.pages ?? {})) {
    for (const [name, sig] of Object.entries(def?.signals ?? {})) {
      const walk = (cond, path) => {
        if (!cond || typeof cond !== "object") return;
        if (Array.isArray(cond)) return cond.forEach((c, i) => walk(c, `${path}[${i}]`));
        for (const [k, v] of Object.entries(cond)) {
          if (k === "script" && v && typeof v.code === "string") {
            out.push({ file, where: `${page}.${name}${path}`, code: v.code });
          } else if (k === "all" || k === "any") walk(v, `${path}.${k}`);
        }
      };
      walk(sig?.condition, "");
    }
  }
  return out;
};

const bookFiles = readdirSync(resolve(ROOT, "resource/playbooks")).filter((f) => f.endsWith(".json")).sort();
if (!bookFiles.length) {
  console.error("\nresource/playbooks/ 里一个 book 都没有 —— lint 没有扫描对象，拒绝静默通过。");
  process.exit(2);
}
let linted = 0;
for (const f of bookFiles) {
  const pb = parseBook(bookPath(f));
  for (const site of evalSites(pb, basename(f, ".json"))) {
    // 语法先行：book 里的 eval 是 JSON 字符串，既没有 typecheck 也没有 lint，写坏了
    // 只能等到线上跑到那一步才炸。实测踩过的坑：作者用 `//` 注释 + 生成脚本把换行压
    // 成空格，注释吞掉了后面整行代码，括号不闭合 —— 而 book 文件本身仍是合法 JSON，
    // 所以 JSON.parse 一路绿灯。这里把 {{slot}} 替成 null 后做一次纯语法检查。
    const probe = site.code.replace(/\{\{[a-zA-Z0-9_.]+\}\}/g, "null");
    linted++;
    // 两种形态都试，与 dom-runtime 的 eval 完全一致：它先按表达式编译（保留裸表达式
    // 的隐式返回），失败再按语句块编译。只按一种判，会把仓库里大量用顶层 `return`
    // 的语句块 eval 全部误报成语法错误。
    let syntaxErr = null;
    try {
      new Function(`return (${probe})`);
    } catch {
      try {
        new Function(probe);
      } catch (e2) {
        syntaxErr = e2.message;
      }
    }
    check(
      `${site.file} step ${site.step} (${site.where}) · eval 语法可解析`,
      syntaxErr === null,
      `eval 代码不是合法 JS：${syntaxErr}。常见原因是代码里写了 // 注释又被压成单行 —— 用 /* */ 或把注释放到生成脚本里`,
    );
    if (syntaxErr) continue;

    // ── 自己声明 bcpDeadline / bcpWait 会让注入静默失效 ──
    // 运行时按【参数最多 → 最少】的阶梯编译：先试 (bcpDeadline, bcpWait)，
    // 失败（因为代码自己声明了同名绑定 → 重复声明 SyntaxError）就退到只传
    // bcpDeadline，再退到无参。退档本身是有意设计的容错，但退了之后代码里所有
    // `bcpWait.xxx` 就变成对一个不存在的全局取属性 —— ReferenceError，而且要等
    // 跑到那一行才炸。上面的语法检查看不出来：两种形态它都能编译，只是参数没了。
    const declaresInjected = /\b(?:const|let|var|function)\s+(bcpWait|bcpDeadline|bcpDom)\b/.exec(probe);
    check(
      `${site.file} step ${site.step} (${site.where}) · 不自己声明注入名`,
      declaresInjected === null,
      `代码自己声明了 \`${declaresInjected?.[1]}\` —— 运行时会因重复声明退到更少的参数档，` +
        `之后所有 bcpWait.* 调用都会 ReferenceError。换个变量名（例如 DL / waiter）。`,
    );
    // 用到注入名的，就必须能在【带这两个参数】的档位下编译 —— 这是它实际会跑的那一档。
    if (/\bbcpWait\b|\bbcpDom\b/.test(probe)) {
      let injectableErr = null;
      try {
        new Function("bcpDeadline", "bcpWait", "bcpDom", `return (${probe})`);
      } catch {
        try {
          new Function("bcpDeadline", "bcpWait", "bcpDom", probe);
        } catch (e) {
          injectableErr = e.message;
        }
      }
      check(
        `${site.file} step ${site.step} (${site.where}) · bcpWait 可注入`,
        injectableErr === null,
        `用了 bcpWait 但在注入档位下编译失败：${injectableErr}`,
      );
    }

    // ── 尾分号吞掉返回值 ──
    // 运行时按【表达式优先、失败退语句块】编译（extension/entrypoints/background.ts）。
    // 一个整体是 IIFE 的块，多一个尾分号就没法按表达式编译，于是退到语句块 ——
    // 语句块会把 IIFE 的求值结果丢掉：action 拿不到返回值、verify 恒为 undefined
    // （运行时报成 `→ null`）。代码照样是合法 JS，上面那条语法检查一路绿灯。
    //
    // 2026-09-04 实测：给 book 的内联 JS 做格式化时，prettier 按语句补了尾分号，
    // 一次性把 17 个块从表达式变成语句块。当时的护栏用【带 {{slot}} 的原文】判形态，
    // 而 `{{product}}` 本身不是合法 JS，改前改后都判「非表达式」—— 看起来没变，
    // 实际两边都是坏的。所以这条 lint 判的是 probe（slot 已替成 null）。
    const noTail = probe.replace(/;\s*$/, "");
    const exprOk = (s) => { try { new Function(`return (${s})`); return true; } catch { return false; } };
    linted++;
    check(
      `${site.file} step ${site.step} (${site.where}) · 尾分号没吞掉返回值`,
      exprOk(probe) || !exprOk(noTail),
      "这段是整体 IIFE，多了个尾分号就只能按语句块编译，返回值会被丢弃（action 拿不到结果、verify 恒 undefined，运行时报 `→ null`）。去掉末尾的 `;` 即可",
    );

    // ── local.eval 必须自己 return ──
    // 它和 browser.eval 的编译方式不同：backend 的 runLocalEval 包成
    // `(function (results) { CODE })(results)` —— 只有函数体形态，【没有表达式形态】，
    // 所以裸表达式的隐式返回在这里不存在。没有 return 就是 undefined，而这个返回值
    // 正是下一步 write_file 要落盘的内容 —— 表现是写出一个空文件，不报错。
    // 判据只查「有没有出现 return」：一个都没有必然是坏的。
    // 已知不足：return 若只出现在嵌套函数里，这条查不出来 —— 宁可漏报也不误报，
    // 精确判定需要按大括号深度解析，代价大于收益。
    if (site.method === "local.eval") {
      linted++;
      check(
        `${site.file} step ${site.step} (local.eval) · 自己 return 了`,
        /\breturn\b/.test(site.code),
        "local.eval 被包成函数体执行，没有 return 就返回 undefined —— 下一步 write_file 会写出空内容且不报错",
      );
    }

    if (!WAITS.test(site.code)) continue;
    linted++;
    const at = `${site.file} step ${site.step} (${site.where})`;
    // `bcpDeadline` is injected by the eval runtime as an absolute deadline
    // derived from EVAL_SAFE_BUDGET_MS. It is the PREFERRED form: it carries no
    // literal, so it cannot drift from the cap. A book using it needs no
    // further budget check — the runtime owns the number.
    const stops = [...site.code.matchAll(HARD_STOPS)].map((m) => Number(m[1]));
    const runtimeClock = /\bbcpDeadline\b/.test(site.code);
    if (runtimeClock) {
      check(`${at} · 等待有钟`, !DEADLINE_EXTENSION.test(site.code),
        DEADLINE_EXTENSION.test(site.code)
          ? "把 bcpDeadline 往后加等于绕过运行时预算——那个截止时刻就是页面侧会杀掉这次 eval 的时刻，加多少都不会生效"
          : "");
      // NOT `continue`: a step can hold bcpDeadline for its overall stop and
      // still declare local sub-timers (a poll window, a race timeout). Those
      // literals stay subject to the budget check below.
    } else if (!stops.length) {
      check(`${at} · 等待有钟`, false, `eval 里有等待却没有硬停。首选写法是运行时注入的 bcpDeadline（无字面量、不会漂移）；Date.now() + N 也认，但赋给变量再相加不算。超过 ${EVAL_CAP_MS}ms 会被页面侧直接杀掉，长等待请改用信号门 browser.waitSignal`);
      continue;
    }
    const over = stops.filter((n) => n > WAIT_BUDGET_MS);
    if (runtimeClock && !over.length) continue;
    check(`${at} · ${runtimeClock ? "局部计时器在预算内" : "等待有钟"}`, over.length === 0,
      over.length ? `硬停 ${over.join("/")}ms 超出预算 ${WAIT_BUDGET_MS}ms（cap ${EVAL_CAP_MS}ms 的 ${Math.round(BUDGET_FACTOR * 100)}%）；真要等更久请改用信号门` : "");
  }
}
check("lint 确实扫到了 eval 等待点（不是空跑）", linted > 0, `扫到 ${linted} 处`);

// ──────────────── 全仓 lint · 等待用引擎原语，不手写轮询 ────────────────
// 上一条只问「等待有没有钟」，不问「用什么等」。于是 book 普遍写成
// `while (Date.now() < DL) { await sleep(200); x = find(); }` —— 有钟，合规，但每一处
// 都在重新实现 `bcpWait.until`，而且实现得更差：
//   · bcpWait.* 全部被 bcpDeadline 二次封顶，手写的循环只受自己那个变量约束；
//   · bcpWait.* 把「没等到」作为返回值报告（until → null），手写的要么静默走完
//     要么自己抛，调用方拿不到统一的失败语义。
//
// 更要紧的是有四个原语 book 【根本写不出等价物】，因为它们挂在引擎注入页面的监听上：
//   bcpWait.netIdle  → 在途请求集合（__bcpWaitNet），eval 上下文自己够不到
//   bcpWait.domQuiet → 引擎的 MutationObserver
//   bcpWait.grew     → 懒加载列表「涨停」判据
//   bcpSignalWait    → 引擎信号
// 2026-09-08 全仓实测：until 33 次 / sleep 16 次（这两个 book 自己写得出来），
// 而 netIdle 1 次、domQuiet 0、grew 0、signalWait 0 —— 采用率梯度是反的，越是
// 不可替代的越没人用。同期手写轮询 75 处。这说明作者知道 bcpWait 存在，只是不知道
// 那四个是手写不出来的，于是拿 while 轮询去近似一个它够不到的信号。
//
// 存量 75 处登记在基线里，新增一律拦下 —— 与 WEAK_VERIFY_BASELINE 同一套哲学：
// 只增不减是腐烂，只减不增才是收敛。数字改小了也报，逼着修完就把行删掉。
// 【为什么逐站点记而不按 book 记总数】2026-08-28 栽过：用总数等式代替逐条谓词，
// 一处修好 + 一处新增会互相抵消，等式照样成立而违例零报告。
// 形态①：循环头里就带着钟 —— `while (Date.now() < DL)`、`for (i<5 && Date.now()<DL; ...)`。
// 只看【头】不看体，所以 `for (const x of arr) { const t = Date.now(); }` 这种计时不误报。

const HAND_POLL = /\b(?:while|for)\s*\([^{]{0,160}?Date\.now\s*\(\)/g;
// 形态②：无限循环 —— 超时判断藏在循环体的 break 里，形态①的头部匹配看不见它，
// 于是 `while (true) { …; if (Date.now() > DL) break; }` 能整个绕过这条防线。
// 但无限循环本身不等于轮询：SSE 流读取那类 `for (;;) { const p = await reader.read(); … }`
// 是事件驱动的（doubao-ask step 3 就是），所以再加一道「同段代码里出现 Date.now()」
// 才算数 —— 实测全仓唯一的无限循环正是那处流读取，同段无钟，放行。
const HAND_POLL_INF = /\b(?:while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\))/g;
const HAS_CLOCK = /Date\.now\s*\(\)/;
// key 是 <book>:<步骤序号>:<位置>，与 evalSites 的 step 同为 1-based。
// 在中间插步骤会让后面的条目整体错位、连带报错 —— 和 WEAK_VERIFY_BASELINE 一样
// 是有意的：插步骤本来就该重新看一遍这本书怎么等。
const HAND_POLL_BASELINE = new Map([
  ["doubao-ask:6:action", 1],
  ["doudian-category-schema:3:action", 1],
  ["doudian-category-schema:4:action", 3],
  ["doudian-category-schema:8:action", 1],
  ["doudian-category-schema:9:action", 1],
  ["doudian-category-schema:10:action", 1],
  ["doudian-category-schema:13:action", 1],
  ["doudian-category-schema:14:action", 1],
  ["doudian-category-schema:15:action", 1],
  ["doudian-category-schema:16:action", 1],
  ["doudian-category-schema:17:action", 1],
  ["doudian-category-schema:18:action", 1],
  ["doudian-category-schema:19:action", 1],
  ["doudian-category-schema:20:action", 1],
  ["doudian-category-schema:21:action", 1],
  ["doudian-category-schema:22:action", 1],
  ["doudian-category-schema:23:action", 1],
  ["doudian-category-schema:24:action", 1],
  ["doudian-category-schema:25:action", 1],
  ["doudian-category-schema:26:action", 1],
  ["doudian-category-schema:27:action", 1],
  ["doudian-category-schema:28:action", 1],
  ["doudian-category-schema:29:action", 1],
  ["doudian-category-schema:30:action", 1],
  ["doudian-category-schema:31:action", 1],
  ["doudian-category-schema:32:action", 1],
  ["doudian-category-schema:33:action", 1],
  ["doudian-category-schema:34:action", 1],
  ["doudian-category-schema:35:action", 1],
  ["doudian-category-schema:36:action", 1],
  ["doudian-category-schema:37:action", 1],
  ["doudian-category-schema:38:action", 1],
  ["doudian-category-schema:39:action", 1],
  ["doudian-category-schema:40:action", 1],
  ["doudian-category-schema:41:action", 1],
  ["doudian-category-schema:42:action", 1],
  ["doudian-category-schema:43:action", 1],
  ["doudian-category-schema:44:action", 1],
  ["doudian-category-schema:45:action", 1],
  ["doudian-category-schema:46:action", 1],
  ["doudian-category-schema:47:action", 1],
  ["doudian-category-schema:48:action", 1],
  ["doudian-category-schema:49:action", 1],
  ["doudian-category-schema:50:action", 1],
  ["doudian-category-schema:51:action", 1],
  ["doudian-category-schema:52:action", 1],
  ["doudian-publish-canonical:10:action", 1],
  ["doudian-publish-canonical:11:action", 3],
  ["doudian-publish-canonical:17:action", 1],
  ["doudian-publish-canonical:18:action", 1],
  ["doudian-publish-canonical:19:action", 1],
  ["doudian-publish-canonical:20:action", 4],
  ["doudian-publish-canonical:21:action", 2],
  ["doudian-publish-canonical:22:action", 1],
  ["doudian-publish-canonical:24:action", 3],
  ["doudian-publish-canonical:25:action", 2],
  ["doudian-publish-canonical:29:action", 1],
  ["doudian-publish-canonical:33:action", 1],
]);

// ── 手抄 DOM 原语（§3.5）──────────────────────────────────────────────
// 2026-09-14 普查：81 处手抄的可见性判据分化成 5 种互不一致的「可见」定义。拿 CSS/HTML
// 能隐藏元素的 22 种成因做矩阵（已固化成 check:dom 的 V 组），与 Playwright 的定义比，
// 各变体分歧 2-10 行；其中一种把【祖先 display:none】判成可见 —— 元素根本不在渲染树里。
// 五种还【全都】答错 content-visibility 和未展开的 <details>：getComputedStyle 看不到
// 它们，只有 checkVisibility() 能。所以这不是风格问题，是正确性问题。
//
// 判据形态 = 取 computed style 后做【否定比较】(`display !== 'none'` / `visibility !== 'hidden'`)
// —— 那是在问「这个元素可见吗」。业务判断写的是【肯定比较】(`display === 'none'`，问「弹窗关了吗」)，
// 不匹配。上一版要求同时出现 getBoundingClientRect，结果放过了最差的那个变体：查 aria-hidden
// 却完全不看尺寸的那 16 处，压根没有 rect 调用 —— 而它正是把【祖先 display:none】判成可见的那个。
const HANDROLLED_VIS = /getComputedStyle[\s\S]{0,220}?(?:display\s*!==\s*['"]none|visibility\s*!==\s*['"]hidden)/g;
// 手写点击序列。
const HANDROLLED_PRESS = /['"]pointerdown['"]/g;
// 手写 hover 序列。2026-09-15 普查：全仓 3 处，同日清零（`bcpDom.hover` 早就有了，只是
// 没人数过存量——"没数就别定基线"于是变成了"永远不定基线"）。判据只认 mouseover /
// pointerover 这两个 hover 专属的类型名：pointermove / mousemove 在别处（拖拽序列）也用，
// 一起认会误报。press 序列里同样含 mouseover，但那一行已被 HANDROLLED_PRESS 认领，
// 两个基线都是 0，重复计数不会放过任何一处。
const HANDROLLED_HOVER = /['"](?:mouseover|pointerover)['"]/g;
// 手抄「绕过框架守卫写值 / 写文件」。2026-09-15 普查：3 处文件投递 + 1 处 value 描述符，
// 同日清零（`bcpDom.setFiles` / `bcpDom.setValue`）。这两个形态值得单独认，因为它们
// 分化得最厉害：三处文件投递里，两处直接 `el.files = …`（会被 React 丢弃）、一处走原生
// setter，事件也是两处 input+change、一处只发 change —— 谁都没错到报错，只是有的能用有的不能。
// 不认 `_valueTracker`：那是 book 自己的反双查询语义（learn 2026-09-14），不是手抄原语。
//
// `(?:window\.|globalThis\.|self\.)?` 不是防御性编程，是**实测补的洞**：上一版要求
// 标识符紧跟在括号后，而书里还有 5 处写成 `window.HTMLInputElement.prototype` —— 它们
// 逃过了这条 lint，也逃过了那轮普查（普查认的是 `nativeSetter` 这个变量名，而它们叫
// `const s`）。两道防线用同一个盲区，于是「清零」报了两次都是错的。
// 判据认的是【拿原型上的 value/files 描述符】这件事本身，怎么拼到 HTMLInputElement
// 那个对象上无所谓。
const HANDROLLED_INJECT =
  /new DataTransfer\(|getOwnPropertyDescriptor\(\s*(?:window\.|globalThis\.|self\.)?HTML\w*Element\.prototype/g;
// 存量冻结，与 HAND_POLL 同一套哲学：只增不减是腐烂。**三类全部清零**——vis 09-14，
// press / hover 09-15（那 3 处 press「形态各异」是真的：两处是 down/up/click 缺 hover
// 前缀、一处是完整序列，但它们都只是 `bcpDom.press` 的子集，换过去是补全不是改写）。
// 空 Map 不是摆设：它让 `domFound !== domAllowed` 对任何新增立刻成立。
const HANDROLLED_BASELINE = new Map([]);
console.log("全仓 lint · 等待用引擎原语");
const seenPollBaseline = new Set();
let pollSites = 0, pollTotal = 0;
for (const f of bookFiles) {
  const pb = parseBook(bookPath(f));
  for (const site of evalSites(pb, basename(f, ".json"))) {
    pollSites++;
    const key = `${site.file}:${site.step}:${site.where}`;
    const found =
      (site.code.match(HAND_POLL) || []).length +
      (HAS_CLOCK.test(site.code) ? (site.code.match(HAND_POLL_INF) || []).length : 0);
    // §3.5 手抄 DOM 原语 —— 与轮询同一个站点循环，同一套基线哲学。
    const domFound =
      (site.code.match(HANDROLLED_VIS) || []).length +
      (site.code.match(HANDROLLED_PRESS) || []).length +
      (site.code.match(HANDROLLED_HOVER) || []).length +
      (site.code.match(HANDROLLED_INJECT) || []).length;
    const domAllowed = HANDROLLED_BASELINE.get(key) ?? 0;
    if (domFound !== domAllowed) {
      check(
        `${site.file} step ${site.step} (${site.where}) · DOM 原语不手抄`,
        false,
        domFound > domAllowed
          ? `手抄 ${domFound} 处，基线 ${domAllowed} 处 —— 改用注入的原语：` +
            `判可见用 \`bcpDom.visible(el)\`（它走 checkVisibility，能看到 content-visibility ` +
            `和未展开的 <details>，手抄的 getComputedStyle 看不到）；` +
            `点击用 \`bcpDom.press(el)\`、悬浮用 \`bcpDom.hover(el)\`（都含祖先链 pointerenter 补发，learn 2026-08-19）；` +
            `按文案找元素用 \`bcpDom.innermost(root, text)\`（返回数组，不替你挑）；` +
            `传文件用 \`bcpDom.setFiles(el, files)\`、写受控输入框用 \`bcpDom.setValue(el, v)\`` +
            `（都走原型 setter 绕开框架守卫，直接赋值会被 React 丢弃）。`
          : `手抄 ${domFound} 处，基线记的是 ${domAllowed} 处 —— 修好了就把 HANDROLLED_BASELINE 里这行删掉/改小`,
      );
    }

    const allowed = HAND_POLL_BASELINE.get(key) ?? 0;
    pollTotal += found;
    if (HAND_POLL_BASELINE.has(key)) seenPollBaseline.add(key);
    if (found === allowed) continue;
    check(
      `${site.file} step ${site.step} (${site.where}) · 等待不手写轮询`,
      false,
      found > allowed
        ? `手写轮询 ${found} 处，基线 ${allowed} 处 —— 新增的 ${found - allowed} 处改用 bcpWait：` +
          `等条件成立用 \`await bcpWait.until(fn, maxMs)\`（返回该值，超时返回 null）；` +
          `等网络/DOM 安静用 \`bcpWait.netIdle(quietMs, maxMs)\` / \`bcpWait.domQuiet(...)\`；` +
          `等懒加载列表涨停用 \`bcpWait.grew(countFn)\` —— 后三个挂在引擎注入的监听上，手写循环拿不到那些信号。` +
          `确实是重试或批处理（循环体里有真动作，不只是 sleep+重读）而非等待的，把这一行的数字改成 ${found}。`
        : `手写轮询降到 ${found} 处（基线记的是 ${allowed}）—— 改好了就更新 check-books.mjs 的 ` +
          `HAND_POLL_BASELINE：${found === 0 ? "整行删掉" : `这一行改成 ${found}`}。基线只减不增才是收敛，留着旧数字会掩护后来新增的轮询。`,
    );
  }
}
// 基线里的死行有两种，都会在将来同 key 上新增轮询时把它默默放行：
//   · 站点没了（步骤被删 / 改名 / 挪位）—— 条目不再管着任何东西；
//   · 数字记成 0 —— 数量相等所以主循环不报，站点还在所以孤儿判据也不报，
//     两条都绕过去了。修完就该删整行，不是把数字改成 0。
for (const [key, n] of HAND_POLL_BASELINE) {
  const alive = seenPollBaseline.has(key);
  check(
    `baseline 条目 ${key} 仍名副其实`,
    alive && n > 0,
    alive
      ? "这一行记成了 0 —— 它不管任何东西，却会掩护将来同 key 上的新增轮询。把整行删掉。"
      : "这个 eval 站点已经不存在了（步骤被删/改名/挪位）—— 从 check-books.mjs 的 HAND_POLL_BASELINE 里删掉这一行，否则它会掩护将来同 key 上的新增轮询。",
  );
}
// 形态①被改坏（永不命中）会让上面每一条基线都以「降到 0」的形式报错，本条只是把
// 「防线整体失效」这件事一句话说清楚，不用从 61 条 FAIL 里反推。
check("HAND_POLL 仍能匹配到存量轮询（正则没被改坏）", pollTotal > 0, `扫到 ${pollSites} 个 eval 站点、${pollTotal} 处手写轮询`);
// 形态②当前【零命中】——全仓唯一的无限循环是 doubao-ask 的 SSE 流读取，同段无钟，
// 按判据放行。零命中意味着它被改坏也不会有任何症状：没有存量能守护它。所以用固定
// 样本自测，正反各一条，让这条判据自己证明自己还活着。
check(
  "HAND_POLL_INF 判据在样本上仍然有效（零命中，无存量可守）",
  "while (true) { if (Date.now() > d) break; }".match(HAND_POLL_INF)?.length === 1 &&
    "for (const x of arr) { read(); }".match(HAND_POLL_INF) === null,
  "无限循环判据在自测样本上失效了 —— 它当前零命中，改坏了不会有别的症状，只有这条能发现",
);

// ──────────────── 全仓 lint · signal 判据（比 step 的 eval 更严） ────────────────
// signal 走 `new Function('"use strict"; return (' + code + ');')()`：只认表达式，
// 没有语句块回退。所以 step 里能跑的写法挪进 signal 可能永久静默失效 —— 判据恒为
// undefined，门永远不成立，表现是「等到超时」而不是报错。
// 另外 signal 是【同步谓词】：它不拿 bcpDeadline，也不 await，代码里出现等待就是
// 写错了地方 —— 要等就用门的 timeoutMs，不要在判据里睡。
// ── verify 验的是不是自己这一步 ──────────────────────────────────────────────
// 三个弱谓词 —— actionSucceeded(调用返回了) / noErrors(页面没抛错) / settled(资源加载完)
// —— 全都成立，这一步仍可能点错了完全不相干的元素：它们证明「没炸」，不证明「做对了」。
//
// 但它们对【没有页面可验】的步骤是正确选择：local.* 跑在后端进程里，closeTab 之后
// 目标 tab 已经不存在。对这两类，actionSucceeded 才是对的对象；拿 noErrors/settled
// 去验它们等于在验一个跟本步无关的东西（页面有没有报错，跟一次后端写文件成功与否无关）。
//
// 所以分两条判：
//   A. 后端/终态动作 → 只能用 actionSucceeded（改完即绿，防再犯）
//   B. 操作页面的动作 → 不许只有弱谓词。现存 12 处是历史遗留，登记在 baseline 里
//      逐步补实；新增的一律拦下，且修好后必须从 baseline 里删掉（否则基线只会腐烂）。
console.log("全仓 lint · verify 验的是不是自己这一步");
const WEAK_VERIFY = new Set(["actionSucceeded", "noErrors", "settled"]);
const HEADLESS_ACTION = (m) => String(m || "").startsWith("local.") || m === "browser.closeTab";
// 只增不减是腐烂，只减不增才是收敛：修好一处就从这里删一行。
// key 是 <book>:<步骤下标>，所以在中间插步骤会让后面的条目整体错位、连带报错 ——
// 这是有意的：插步骤本来就该重新看一遍这本书的 verify，而不是让基线静默跟着漂。
const WEAK_VERIFY_BASELINE = new Set([
  "1688-offer-snatch:6",
  "1688-random-offer-snatch:4",
  "doubao-ask:1",
  "doubao-ask:2",
  "doubao-ask:3",
  "doubao-ask:4",
  "doubao-ask:5",
  "doubao-ask:6",
  "doubao-ask:7",
  "doudian-freight-templates:2",
]);
const seenBaseline = new Set();
for (const f of bookFiles) {
  const pb = parseBook(bookPath(f));
  const name = basename(f, ".json");
  for (const [i, step] of (pb.steps || []).entries()) {
    const present = Object.entries(step.verify || {})
      .filter(([, v]) => v !== undefined && v !== false)
      .map(([k]) => k);
    if (present.length === 0) continue;
    const onlyWeak = present.every((k) => WEAK_VERIFY.has(k));
    if (!onlyWeak) continue;
    const method = step.action?.method;
    if (HEADLESS_ACTION(method)) {
      check(
        `${name} step ${i} · ${method} 只能验 actionSucceeded`,
        present.length === 1 && present[0] === "actionSucceeded",
        `验的是 ${present.join("+")} —— 这一步没有页面可验（local.* 在后端跑，closeTab 后 tab 已不存在），` +
          `页面状态跟它成没成无关。改成 { actionSucceeded: true }。`,
      );
      continue;
    }
    const key = `${name}:${i}`;
    if (WEAK_VERIFY_BASELINE.has(key)) {
      seenBaseline.add(key);
      continue;
    }
    check(
      `${name} step ${i} · verify 不能只有弱谓词`,
      false,
      `${method || "(check-only)"} 只验了 ${present.join("+")} —— 三者都成立仍可能做错了事。` +
        `问一句「我下一步要用的东西在不在」，那才是这一步该验的（elementName / textPresent / ` +
        `networkOk / evalCheck）。`,
    );
  }
}
// baseline 修好了却没删 → 它就开始掩护别的问题
for (const key of WEAK_VERIFY_BASELINE) {
  check(
    `baseline 条目 ${key} 仍然名副其实`,
    seenBaseline.has(key),
    `这一步已经不是弱 verify 了（或已被删/改名）—— 从 check-books.mjs 的 WEAK_VERIFY_BASELINE 里删掉这一行。`,
  );
}

console.log("全仓 lint · signal 判据");
let signalLinted = 0;
for (const f of bookFiles) {
  const pb = parseBook(bookPath(f));
  for (const site of signalSites(pb, basename(f, ".json"))) {
    const at = `${site.file} signal ${site.where}`;
    signalLinted++;
    let err = null;
    try {
      new Function(`"use strict"; return (${site.code});`);
    } catch (e) {
      err = e.message;
    }
    check(`${at} · 是合法表达式`, err === null,
      err ? `signal 只按表达式编译、没有语句块回退，写成语句块会恒为 undefined、门永远不成立：${err}` : "");
    check(`${at} · 判据里不等待`, !WAITS.test(site.code),
      "signal 是同步谓词，等待要交给门的 timeoutMs，不要在判据里 await/setTimeout");

    // ── 只能用【这条路径】提供的注入名 ──
    // 两条路径注入的东西不一样，而代码看起来完全一样：step 的 eval 拿到
    // bcpDeadline / bcpWait / bcpDom 三个，signal 的 script 叶子只拿到 bcpDom
    // （它是同步谓词，等待归门的 timeoutMs 管，给它 bcpWait 等于鼓励在判据里等）。
    //
    // 2026-09-15：v8 把书里的可见性判据统一成 bcpDom.visible 时，连 signal 里的
    // 6 处一起换了 —— 而当时 signal 路径一个都不注入。现象是门恒 blocked
    // 「bcpDom is not defined」，整本 doudian-publish-canonical 跑不过第 8 步，
    // 一小时前它还是 33/33。语法检查看不见：自由标识符永远是合法 JS，要等跑到
    // 那一门才炸。上面 evalSites 那圈早有等价的「可注入」检查，signal 这圈没有——
    // 最脆的一类又一次是没防线的那类。
    const SIGNAL_INJECTED = ["bcpDom"];
    const NOT_IN_SIGNALS = /\b(bcpWait|bcpDeadline)\b/.exec(site.code);
    check(`${at} · 不用该路径没有的注入名`, NOT_IN_SIGNALS === null,
      `用了 \`${NOT_IN_SIGNALS?.[1]}\` —— signal 的 script 叶子只注入 ${SIGNAL_INJECTED.join(" / ")}，` +
      `跑起来是 ReferenceError、门恒 blocked。要等就交给门的 timeoutMs`);

    // 声明同名 = 把注入的原语遮掉，判据又悄悄退回手抄版本（正是 v8 要消灭的分化）。
    // 表达式形态下顶层声明不可能出现，能出现的是 IIFE 里的内层 const —— 遮蔽，不是重复声明。
    const shadows = /\b(?:const|let|var|function)\s+(bcpDom)\b/.exec(site.code);
    check(`${at} · 不遮蔽注入名`, shadows === null,
      `代码自己声明了 \`${shadows?.[1]}\`，会遮蔽注入的同名参数 —— 判据又变回手抄实现。换个变量名（例如 vis / DOM）`);

    // 用了就必须能在【它实际会跑的那一档】编译：与 dom-runtime 逐字一致的形态
    // （表达式、无语句块回退、bcpDom 作为参数）。
    if (/\bbcpDom\b/.test(site.code)) {
      let injErr = null;
      try {
        new Function("bcpDom", `"use strict"; return (${site.code});`);
      } catch (e) {
        injErr = e.message;
      }
      check(`${at} · bcpDom 可注入`, injErr === null, `用了 bcpDom 但在注入档位下编译失败：${injErr}`);
    }

    // ── 判据不动页面 ──
    // 注入 bcpDom 顺带把 press / hover / click 也放进了门里，而门是【谓词】：
    // 它每次 DOM 变动都可能重跑（MutationObserver + 500ms 兜底轮询），在里面派发
    // 事件就是让"读"变成"写"，还是不可预期次数的写。与 verify 禁止副作用同一条。
    const acts = /\bbcpDom\.(click|press|hover)\s*\(/.exec(site.code);
    check(`${at} · 判据不动页面`, acts === null,
      `调了 \`bcpDom.${acts?.[1]}\` —— signal 每次 DOM 变动都会重新求值，在判据里派发事件 = 不可预期次数的副作用。动作请写进 step 的 action`);
  }
}
check("lint 确实扫到了 signal 判据（不是空跑）", signalLinted > 0, `扫到 ${signalLinted} 处`);

// ─────────────────────────── doubao-ask ───────────────────────────
console.log("doubao-ask · SSE → reply 解析步骤");

/** Locate the parser step by CONTENT, not by index: steps get inserted and
 * removed (a wait step moved to a signal gate once already), and a stale index
 * silently points these assertions at a different step's code — which reads as
 * 20 failing assertions about the parser, not as "the script lost its target".
 * Ambiguous or missing → exit 2, same fail-closed rule as a missing fixture. */
const evalCodeByMarker = (name, marker) => {
  const hits = book(name).steps.filter(
    (s) => s.action?.method === "browser.eval" && s.action.params?.code?.includes(marker),
  );
  if (hits.length !== 1) {
    console.error(`\n在 ${name} 里按 ${JSON.stringify(marker)} 定位 eval 步骤失败(命中 ${hits.length} 个)。断言没有目标 = 没有测。`);
    process.exit(2);
  }
  return hits[0].action.params.code;
};
const parserCode = (name, marker = "replySource") => evalCodeByMarker(name, marker);

// 取真实 book 里的真实代码，只替换模板占位符
const mkRun = (requireJson = "false") => {
  const code = parserCode("doubao-ask").replaceAll("{{requireJson}}", requireJson);
  return (chunks, requestBody = null) => {
    globalThis.window = { __bcpDoubaoApi: { chunks, requestBody } };
    return new Function(code)();
  };
};
const run = mkRun();
const frame = (event, data) => `event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}`;
const END = frame("SSE_REPLY_END", {});
const sse = (...f) => [f.join("\n\n")];
const syntheticStream = (kind) => {
  const answers = {
    plain: ["Synthetic assistant answer."],
    json: ['{"name":"Sample","desc":"Synthetic response"}'],
    code: ["```python\ndef quick_sort(arr):\n", "    if len(arr) <= 1:\n        return arr\n", ...Array.from({ length: 35 }, (_, i) => `    # synthetic partition step ${i}\n`), "```"],
    search: ["Synthetic answer: British Summer Time begins in spring and ends in autumn. This synthetic paragraph is intentionally longer than the minimum parser regression threshold."],
  };
  const chunks = [frame("SSE_ACK", { ack_client_meta: { conversation_id: "synthetic-conversation" } })];
  if (kind === "search") {
    chunks.push(frame("STREAM_CHUNK", { patch_op: [{ patch_value: { content_block: [{ content: { loading_block: { text_loading: { text: "正在搜索" } } } }] } }] }));
    chunks.push(frame("STREAM_CHUNK", { patch_op: [{ patch_value: { content_block: [{ content: { search_query_result_block: { summary: "synthetic sources", queries: ["synthetic query"], results: [] } } }] } }] }));
  }
  for (const text of answers[kind]) chunks.push(frame("CHUNK_DELTA", { text }));
  chunks.push(END);
  return chunks.join("\n\n");
};

// ═══ 合成流：SSE 的答案分片与附加 block 必须正确解析
console.log(" 合成流");
{
  const { out, err } = grab(() => run([syntheticStream("plain")]));
  check("纯文本 · 解析成功", !err, err);
  check("纯文本 · 分片拼出完整答案",
    out?.reply === "Synthetic assistant answer.",
    JSON.stringify(out?.reply));
  check("纯文本 · 取到 conversationId", !!out?.conversationId);
}
{
  const { out, err } = grab(() => run([syntheticStream("json")]));
  check("JSON · 解析成功", !err, err);
  check("JSON · 产出可被 JSON.parse", (() => { try { JSON.parse(out.reply); return true; } catch { return false; } })(), out?.reply);
  const { err: e2 } = grab(() => mkRun("true")([syntheticStream("json")]));
  check("JSON · requireJson=true 不误报", !e2, e2);
}
{
  const { out, err } = grab(() => run([syntheticStream("code")]));
  check("代码块 · 解析成功", !err, err);
  check("代码块 · 函数定义完整", /def quick_sort\(arr\)/.test(out?.reply || ""));
  check("代码块 · 换行与缩进保留", /\n    if len\(arr\) <= 1:/.test(out?.reply || ""));
  check("代码块 · 长度未被截断(>800)", (out?.reply || "").length > 800, `len=${out?.reply?.length}`);
}

{
  // 联网搜索：豆包会额外下发 search_query_result_block（搜索来源清单：queries + results[].text_card）
  // 和一串 loading_block（"正在搜索…"）。两者都只是 UI 附加信息，正文仍在 text_block / CHUNK_DELTA。
  const { out, err } = grab(() => run([syntheticStream("search")]));
  check("联网搜索 · 解析成功（搜索来源块不误拦）", !err, err);
  check("联网搜索 · 答案正文完整", /British Summer Time/.test(out?.reply || "") && (out?.reply || "").length > 100, `len=${out?.reply?.length}`);
  check("联网搜索 · 来源清单未混进答案", !/synthetic sources|synthetic query/.test(out?.reply || ""));
  check("联网搜索 · loading 文案未混进答案", !/正在搜索|正在生成/.test(out?.reply || ""));
}

// ═══ 防线：这些不是假想场景，每一条都真实发生过
console.log(" 防线");
{
  const { err } = grab(() => run(sse(
    frame("STREAM_MSG_NOTIFY", { content: { content_block: [{ content: { text_block: { text: "我" } } }] } }),
    frame("SOME_NEW_EVENT", { payload: { text: "新协议内容" } }), END)));
  check("协议再改版 · 拒绝写出可能不完整的答案", /UNRECOGNIZED/.test(err || ""), err);
  check("协议再改版 · PROBE 直接给出新 event 的字段路径",
    /SOME_NEW_EVENT \{[^}]*payload\.text=/.test(err || ""), err);
}
{
  const { err } = grab(() => run(sse(
    frame("STREAM_MSG_NOTIFY", { content: { content_block: [{ content: { text_block: { text: "这是图：" } } }] } }),
    frame("STREAM_CHUNK", { patch_op: [{ patch_value: { content_block: [{ content: { image_block: { url: "https://x/y.png" } } }] } }] }), END)));
  check("回复内嵌未知块 · 拦截并列出 block 类型", /non-text blocks[\s\S]*image_blockx1/.test(err || ""), err);
}
{
  const { err } = grab(() => run(sse(frame("STREAM_ERROR", { error_msg: "rate limited" }), END)));
  check("服务端拒绝 · 抛出真实原因而非 'empty'", /refused the request: rate limited/.test(err || ""), err);
}
{
  const { err } = grab(() => run(sse(frame("CHUNK_DELTA", { text: "半截" }))));
  check("流未正常结束 · 识别为截断", /without SSE_REPLY_END/.test(err || ""), err);
}
{
  const { err } = grab(() => run(sse(
    frame("FULL_MSG_NOTIFY", { message: { user_type: 1, content_block: [{ content: { text_block: { text: "问题" } } }] } }), END)));
  check("只有用户消息回显 · 不当作回复", /reply is empty/.test(err || ""), err);
}
{
  const { err } = grab(() => run(sse(frame("STREAM_MSG_NOTIFY", "<<<not-json>>>"), END)));
  check("data 非法 JSON · 计数并暴露原文", /parseFail=1[\s\S]*firstUnparsable: <<<not-json>>>/.test(err || ""), err);
}
{
  const { out } = grab(() => run(sse(
    frame("STREAM_MSG_NOTIFY", { content: { content_block: [{ content: { text_block: { text: "A" } } }] } }),
    frame("CHUNK_DELTA", { text: "B" }),
    frame("STREAM_CHUNK", { patch_op: [{ patch_value: { content_block: [{ content: { text_block: { text: "C" } } }] } }] }),
    frame("CHUNK_DELTA", { text: "D" }), END)));
  check("三路混合 · 按帧序拼接而非按 event 分组", out?.reply === "ABCD", JSON.stringify(out?.reply));
}

// ──────────────── doubao-ask · replyEnded 信号 ────────────────
// The gate that replaced the old in-eval polling wait. It is book inline JS
// with no typecheck and no lint, evaluated the same way the extension does it
// (bcpSignalWait: `new Function('"use strict"; return (' + code + ');')`), so
// it gets the same treatment as the parser above: real code, real wrapper.
console.log("\ndoubao-ask · replyEnded 信号条件");

const signalCode = (name, page, signal) => {
  const code = book(name).pages?.[page]?.signals?.[signal]?.condition?.script?.code;
  if (typeof code !== "string") {
    console.error(`\n${name} 的 ${page}.${signal} 不是 script 信号，断言没有目标 = 没有测。`);
    process.exit(2);
  }
  return code;
};

// grab(): a throwing leaf is fail-closed at runtime (bcpSignalWait turns it
// into `blocked`), so "threw" and "returned false" are different outcomes and
// the assertions must not conflate them.
const replyEnded = (state) => grab(() => {
  globalThis.window = state === undefined ? {} : { __bcpDoubaoApi: state };
  return new Function(`"use strict"; return (${signalCode("doubao-ask", "doubao", "replyEnded")});`)();
});

check("hook 未安装 · 不放行且不抛错", replyEnded(undefined).out === false, JSON.stringify(replyEnded(undefined)));
check("state 没有 chunks · 不放行且不抛错", replyEnded({}).out === false, JSON.stringify(replyEnded({})));
check("流还在跑 · 不放行", replyEnded({ chunks: [frame("CHUNK_DELTA", { text: "半句" })] }).out === false);
check("收到 SSE_REPLY_END · 放行", replyEnded({ chunks: [frame("CHUNK_DELTA", { text: "答案" }), END] }).out === true);
check("分片切断 SSE_REPLY_END · 拼接后仍放行", replyEnded({ chunks: ["event: SSE_REP", "LY_END\ndata: {}\n\n"] }).out === true);
check("hook 标记 done · 放行(流被提前关掉也不会干等)", replyEnded({ chunks: [], done: true }).out === true);

// ──────────── doubao-ask · 发送重试的挂钟预算 ────────────
// This step used to declare "4 submit rounds" it could never reach: 2000 +
// 4×4×1200 = 21.2s against a 15s page cap, so the last rounds were dead code
// and a slow composer died as "eval timed out" instead of saying anything
// useful. The budget is now wall-clock, and the assertion that matters is the
// one a reader cannot do in their head — the worst case measured, not argued.
console.log("\ndoubao-ask · 发送重试预算");

const submitCode = evalCodeByMarker("doubao-ask", "handleKeyDown");

/** Run book code against a VIRTUAL clock: setTimeout advances time instead of
 * spending it, so the worst case is measured exactly and the suite stays
 * instant. The code only ever awaits `new Promise(r => setTimeout(r, ms))`, so
 * advancing at schedule time is equivalent to advancing at fire time. */
const withFakeClock = async (fn) => {
  const realNow = Date.now, realSetTimeout = globalThis.setTimeout;
  let now = 1_700_000_000_000;
  const startedAt = now;
  Date.now = () => now;
  globalThis.setTimeout = (cb, ms) => { now += Number(ms) || 0; queueMicrotask(cb); return 0; };
  try {
    const out = await fn();
    return { out, elapsed: now - startedAt };
  } catch (e) {
    return { err: e.message, elapsed: now - startedAt };
  } finally {
    Date.now = realNow; globalThis.setTimeout = realSetTimeout;
  }
};

/** Composer stub: clears itself once Enter has been delivered `clearsAfter`
 * times. `null` = the composer never accepts the message. */
const runSubmit = (clearsAfter) => withFakeClock(() => {
  let fires = 0;
  const doc = { textContent: "问题" };
  const editor = {
    state: { doc },
    view: {
      someProp: (_name, run) => {
        fires++;
        if (clearsAfter !== null && fires >= clearsAfter) doc.textContent = "";
        return run(() => true, {});
      },
    },
  };
  globalThis.KeyboardEvent = class { constructor(type, init) { Object.assign(this, { type }, init); } };
  globalThis.document = { querySelector: (sel) => (sel === ".tiptap.ProseMirror" ? { editor } : null) };
  return new Function(submitCode)();
});

{
  const { out, elapsed } = await runSubmit(1);
  check("第一次 Enter 就被接受", out?.submitted === true && out.attempts === 1, JSON.stringify(out));
  check("耗时 = 2000 起手 + 一次 1200 轮询", elapsed === 3200, `${elapsed}ms`);
}
{
  const { out } = await runSubmit(5);
  check("composer 迟钝时继续重试直到被接受", out?.submitted === true && out.attempts === 5, JSON.stringify(out));
}
{
  const { out, err, elapsed } = await runSubmit(null);
  check("永不接受 · 抛错而不是假装成功", !out && /did not accept/.test(err || ""), err);
  check("永不接受 · 报出真实耗时与尝试次数", /within \d+ms after \d+ submit attempts/.test(err || ""), err);
  check(`永不接受 · 最坏耗时留在 ${EVAL_CAP_MS}ms cap 之内`, elapsed < EVAL_CAP_MS, `${elapsed}ms vs cap ${EVAL_CAP_MS}ms`);
}
{
  globalThis.document = { querySelector: () => null };
  const { err } = await withFakeClock(() => new Function(submitCode)());
  check("composer 不存在 · 立刻报明确原因", /composer not ready/.test(err || ""), err);
}

// 发送成功 = 豆包换路由 + 重挂载 composer。旧实例连同它的 view 一起被销毁，而它的
// state.doc 还留着发送前的原文。2026-09-05 实测：书里若把发送前的实例扣在闭包里，
// 发出去之后 sent() 恒 false、下一拍 fire() 就在旧 view 上抛 tiptap 的
// "editor view is not available"，一次成功的发送被报成整本 book 失败。
// 这个 stub 复刻那次重挂载：第一次 Enter 之后 querySelector 换人。
const runSubmitAcrossRemount = () => withFakeClock(() => {
  const before = {
    state: { doc: { textContent: "问题" } },
    view: { someProp: (_name, run) => { mounted = after; return run(() => true, {}); } },
  };
  const after = {
    state: { doc: { textContent: "" } },
    get view() { throw new Error("[tiptap error]: The editor view is not available."); },
  };
  let mounted = before;
  globalThis.KeyboardEvent = class { constructor(type, init) { Object.assign(this, { type }, init); } };
  globalThis.document = { querySelector: (sel) => (sel === ".tiptap.ProseMirror" ? { editor: mounted } : null) };
  return new Function(submitCode)();
});

{
  const { out, err } = await runSubmitAcrossRemount();
  check("发送后 composer 重挂载 · 认新实例而不是抱着旧的", out?.submitted === true, err || JSON.stringify(out));
  check("发送后 composer 重挂载 · 不把成功的发送报成失败", !err, err);
  check("发送后 composer 重挂载 · 只按了一次 Enter", out?.attempts === 1, JSON.stringify(out));
}

// ═══ doudian-publish-canonical · SKU 导入表的 CSV ═══════════════════════════
// 规格值是【卖家手填的任意字符串】。1688 上「6只装,加厚」这种带逗号的写法很常见，
// 而 build_canonical 的清洗链当前只去空格（_TEXT_RULES 就一条规则），逗号原样进到
// canonical。CSV 若不转义，这一行就会多切出一列 —— 抖店按【列位】读，价格列读到半截
// 规格值、库存列读到价格。这条路上没有任何东西会报错：抖店照单全收，最后是一个规格
// 与价格全错的商品。所以断言的是「列数不随规格值里的标点变化」，不是「代码里有个引号函数」。
console.log("\ndoudian-publish-canonical · SKU CSV");
const skuCsvCode = evalCodeByMarker("doudian-publish-canonical", "sku-import.csv");

/** `bcpDom` as browser.eval injects it. This harness has no layout engine, so
 *  the helpers REFUSE rather than answer: a stubbed `visible: () => true` would
 *  let a book's DOM logic pass here and fail on a real page, which is the exact
 *  shape of fake defence this file exists to avoid. DOM behaviour is covered by
 *  `pnpm check:dom`, in a real Chromium. */
const BCP_DOM_STUB = {
  visible: () => { throw new Error("bcpDom.visible needs a real layout — this runs in node; cover DOM behaviour in check:dom"); },
  innermost: () => { throw new Error("bcpDom.innermost needs a real DOM — this runs in node; cover it in check:dom"); },
  press: () => { throw new Error("bcpDom.press needs a real DOM — this runs in node; cover it in check:dom"); },
  setValue: () => { throw new Error("bcpDom.setValue needs a real prototype accessor — this runs in node; cover it in check:dom"); },
  // The ONE exception to "refuse rather than answer": the CSV harness below
  // drives the book's import state machine, and that machine cannot take a step
  // until the files land and the control reacts. So this reproduces the real
  // primitive's OBSERVABLE contract (assign, fire input then change, report the
  // count) and nothing else — the parts that actually matter (writing through
  // the prototype accessor past a framework guard, and the event order) are
  // asserted against a real browser in check:dom's V-set group.
  //
  // Which is why the assertion below checks that the book CALLS this, and not
  // what this does: an assertion about a stub's behaviour is an assertion about
  // the stub.
  setFiles: (el, files) => {
    el.files = [...files];
    el.dispatchEvent(new globalThis.Event("input"));
    el.dispatchEvent(new globalThis.Event("change"));
    return el.files.length;
  },
};

const buildSkuCsv = async (product) => {
  let captured = null;
  let recognized = false;
  const events = [];
  const inp = { files: null, dispatchEvent: (event) => { events.push(event.type); recognized = true; return true; } };
  globalThis.document = {
    querySelector: (sel) => (sel.includes(".csv") ? inp : null),
    querySelectorAll: () => [],
    body: { get innerText() { return recognized ? "规格选项" : ""; } },
    hasFocus: () => false,
    visibilityState: "hidden",
  };
  globalThis.File = class { constructor(parts) { captured = String(parts[0]); } };
  globalThis.DataTransfer = class { constructor() { this.items = { add: () => {} }; this.files = []; } };
  globalThis.Event = class { constructor(type) { this.type = type; } };
  const out = await new Function("bcpDeadline", "bcpWait", "bcpDom", `return (${skuCsvCode.replaceAll("{{product}}", JSON.stringify(product))});`)(
    Date.now() + 1000, { sleep: () => Promise.resolve() }, BCP_DOM_STUB,
  );
  return { csv: captured, out, events };
};

const sku = (color, size, price, stock) => ({
  specs: [{ name: "颜色", value: color }, { name: "尺码", value: size }],
  price, stock,
});
const csvCols = (line) => {
  // 一个独立的极简 RFC4180 读法：解析器不能是被测代码的复制品，否则同一个错会在
  // 两边同时成立、断言恒绿。
  let cols = 1, inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQuotes && line[i + 1] === '"') i++; else inQuotes = !inQuotes; }
    else if (c === "," && !inQuotes) cols++;
  }
  return cols;
};

{
  const product = {
    category: { categoryProps: [{ id: 1, name: "颜色分类" }, { id: 2, name: "尺码" }] },
    skus: [sku("红色", "S", 19.9, 5), sku("6只装,加厚", "M", 29.9, 3)],
  };
  const { csv, out, events } = await buildSkuCsv(product);
  check("CSV · 真实 step 产出了表", !!csv, JSON.stringify(out));
  // 文件怎么投递交给引擎原语：原生 setter 绕框架守卫 + input/change 各一次，都在
  // check:dom 的 V-set 组里对着真浏览器跑。这里只断言这一步【确实走了原语】——
  // 上一版断言的是 events 顺序，而现在那个顺序由本文件的桩产生，断言它等于断言桩自己。
  check("CSV · 文件投递走引擎原语（不再手抄 DataTransfer / 原生 setter）",
    /bcpDom\.setFiles\(/.test(skuCsvCode) && !/new DataTransfer\(|getOwnPropertyDescriptor\(/.test(skuCsvCode),
    skuCsvCode.slice(0, 200));
  check("CSV · 原语投递后控件确实收到了事件（状态机能往下走的前提）",
    events.join("/") === "input/change", JSON.stringify(events));
  const lines = (csv || "").trim().split("\n");
  check("CSV · 表头 + 每个 SKU 一行", lines.length === 3, `${lines.length} 行`);
  check("CSV · 含逗号的规格值不撑开列数",
    lines.every((l) => csvCols(l) === 4), lines.map(csvCols).join("/") + " → " + JSON.stringify(lines));
  check("CSV · 含逗号的值整体加引号后原样保留",
    lines[2]?.startsWith('"6只装,加厚",M,'), JSON.stringify(lines[2]));
  check("CSV · 不含标点的值不加多余引号", lines[1] === "红色,S,19.9,5", JSON.stringify(lines[1]));
  // BOM 判在原始串上：trim() 会把 U+FEFF 当空白一起吃掉，判在 lines[0] 上恒为假。
  check("CSV · 保留 BOM（抖店按 UTF-8 BOM 认中文表头）", (csv || "").charCodeAt(0) === 0xfeff);
  check("CSV · 表头用类目自己的销售属性名", lines[0] === "颜色分类,尺码,售卖价,库存", JSON.stringify(lines[0]));
}
{
  // 引号与换行同理：卖家手填的规格值里出现过带引号的尺寸写法（12"）。
  const product = {
    category: { categoryProps: [] },
    skus: [{ specs: [{ name: "规格", value: '12"面板' }], price: 9.9, stock: 1 }],
  };
  const { csv } = await buildSkuCsv(product);
  const line = (csv || "").trim().split("\n")[1];
  check("CSV · 值里的引号翻倍而不是提前收尾", line === '"12""面板",9.9,1', JSON.stringify(line));
  check("CSV · 带引号的值列数仍然正确", csvCols(String(line)) === 3, String(csvCols(String(line))));
}

// ═══ doudian-publish-canonical · SKU 导入的错误分类 ═════════════════════════
// 这一步的 goal 写的是「文件错误立即停止；系统识别失败…最多重试两次」，但直到
// 2026-09-15 为止，判定「能不能重试」的谓词只认 /识别错误|系统处理异常/ —— 于是
// 抖店最常见的那条「文件上传失败，请重试」落在了可重试集合之外，**页面自己写着
// 「请重试」，书却立即判死**。代价不是一次失败：该 book 全历史跑到这一步 23 次、
// 8 成 15 败，失败全部 717-825ms（一个 700ms 轮询周期就崩），同一份 CSV 时成时败
// —— 是传输抖动，而重试路径本该吃下它。
// 断言的是【分类】而不是【文案】：文件本身的问题必须一次就停，传输抖动必须重投。
console.log("\ndoudian-publish-canonical · SKU 导入错误分类");
// 上传请求没走通时抖店不渲染「重新上传」控件（真实失败快照：inputPresent:true、
// button:'disabled'、fileCount:0、没有任何抽屉）。querySelectorAll 返回空正是这个形状，
// 所以重投只能靠原文件输入 —— 这是本用例要覆盖的那条路。
const runSkuImport = async ({ errorText, clearsAfterUploads = Infinity }) => {
  let uploads = 0;
  const inp = { files: null, dispatchEvent: (e) => (e.type === "change" && uploads++, true) };
  globalThis.document = {
    querySelector: (sel) => (sel.includes(".csv") ? inp : null),
    querySelectorAll: () => [],
    body: {
      get innerText() {
        if (uploads === 0) return "";
        return uploads >= clearsAfterUploads ? "规格选项" : errorText;
      },
    },
    hasFocus: () => false,
    visibilityState: "visible",
  };
  globalThis.File = class { constructor() {} };
  globalThis.DataTransfer = class { constructor() { this.items = { add: () => {} }; this.files = []; } };
  globalThis.Event = class { constructor(type) { this.type = type; } };
  const product = {
    category: { categoryProps: [] },
    skus: [{ specs: [{ name: "颜色", value: "红" }], price: 9.9, stock: 1 }],
  };
  const run = new Function("bcpDeadline", "bcpWait", "bcpDom", `return (${skuCsvCode.replaceAll("{{product}}", JSON.stringify(product))});`);
  try {
    return { out: await run(Date.now() + 1000, { sleep: () => Promise.resolve() }, BCP_DOM_STUB), uploads };
  } catch (e) {
    return { err: String(e.message || e), uploads };
  }
};

{
  const { out, err, uploads } = await runSkuImport({ errorText: "文件上传失败，请重试", clearsAfterUploads: 2 });
  check("SKU 导入 · 「文件上传失败，请重试」会重投而不是立即判死", out?.ok === true, err || JSON.stringify(out));
  check("SKU 导入 · 重投走原文件输入（页面没有「重新上传」控件）", uploads === 2, `${uploads} 次`);
  check("SKU 导入 · 重投次数如实回报", out?.retries === 1, JSON.stringify(out));
}
{
  const { out, err, uploads } = await runSkuImport({ errorText: "文件格式错误，请下载模板" });
  check("SKU 导入 · 文件本身的问题一次就停（重试一百次还是同一个文件）", !!err && /文件格式错误/.test(err), JSON.stringify(out));
  check("SKU 导入 · 文件错误不消耗重投", uploads === 1, `${uploads} 次`);
}
{
  const { out, err, uploads } = await runSkuImport({ errorText: "文件上传失败，请重试" });
  check("SKU 导入 · 抖动不止时按上限收手而不是无限重投", !!err && /文件上传失败/.test(err), JSON.stringify(out));
  check("SKU 导入 · 上限 = 首投 + 2 次重投", uploads === 3, `${uploads} 次`);
}

// ═══ doudian-image-text-publish · 挂车商品 ID ═══════════════════════════════
// 初始候选列表本来就可能非空。2026-09-08 的真实运行一写商品 ID 就立即读取旧的
// 12 行，尚未等搜索请求完成便报告“找不到”。因此必须同时等网络空闲和搜索结果更新。
console.log("\ndoudian-image-text-publish · 挂车商品查询");
const imageTextBook = book("doudian-image-text-publish");
const closeComposerStep = imageTextBook.steps.find(
  (step) => step.action?.method === "browser.eval" && step.action.params?.code?.includes("composer-still-open-and-no-close-button"),
);
if (!closeComposerStep) {
  console.error("\n在 doudian-image-text-publish 里找不到发布后关闭创作抽屉的步骤，断言没有目标。");
  process.exit(2);
}
const closeComposerCode = closeComposerStep.action.params.code;
check(
  "发布后收抽屉 · press 在同一 eval 作用域内声明",
  /const\s+press\s*=/.test(closeComposerCode) && /\bpress\s*\(/.test(closeComposerCode),
  "关闭抽屉步骤调用 press(...) 却没有在同一段 browser.eval 代码中声明它，会在发布成功后报 ReferenceError",
);
const selectProductStep = imageTextBook.steps.find(
  (step) => step.action?.method === "browser.eval" && step.action.params?.code?.includes("no-row-matched-productId"),
);
if (!selectProductStep) {
  console.error("\n在 doudian-image-text-publish 里找不到挂车选品步骤，断言没有目标。");
  process.exit(2);
}
const selectProductCode = selectProductStep.action.params.code;
const selectProductVerify = selectProductStep.verify?.evalCheck?.code;
const matchProductId = (text, id) => new RegExp(`ID\\s*[：:]?\\s*${id}(?!\\d)`).test(text);
for (const [label, text] of [
  ["ASCII 冒号", "商品名称 ID:3789407838175101078"],
  ["全角冒号", "商品名称 ID：3789407838175101078"],
  ["空格", "商品名称 ID 3789407838175101078"],
]) {
  check(`挂车商品 ID · ${label}可匹配`, matchProductId(text, "3789407838175101078"));
}
check("挂车商品 ID · 不把更长数字前缀当成目标", !matchProductId("ID:37894078381751010789", "3789407838175101078"));
check("挂车商品 ID · 选品 action 支持三种分隔符", /ID\\s\*\[：:\]\?\\s\*/.test(selectProductCode));
check("挂车商品查询 · 点击后等待网络空闲", selectProductCode.includes("await bcpWait.netIdle(400, 5000)"));
check("挂车商品查询 · 初始列表指纹不能直接放行", selectProductCode.includes("const before = signature(rowsOf());") && selectProductCode.includes("signature(r) !== before"));
check("挂车商品查询 · 等目标 ID 行出现", selectProductCode.includes("matchesCode(r) || empty || signature(r) !== before"));
check("挂车商品查询 · 旧列表不变时如实失败", selectProductCode.includes("product-search-results-never-updated"));
check("挂车商品 ID · verify 复验已绑定 ID", typeof selectProductVerify === "string" && /ID\\s\*\[：:\]\?\\s\*\{\{productId\}\}/.test(selectProductVerify));
const imageUploadStep = imageTextBook.steps.find((step) => step.action?.method === "browser.upload");
check("非挂车上传 · 只定位 multiple 图片 input", imageUploadStep?.action?.params?.css === 'input[type=file][accept="image/*"][multiple]');
check("非挂车上传 · 从图片 input 容器验证计数", typeof imageUploadStep?.verify?.evalCheck?.code === "string" && imageUploadStep.verify.evalCheck.code.includes("input?.parentElement?.innerText"));

// ═══ doudian-image-text-publish · 正文自检（AI 草稿复活 + 纯文本话题）═════════
// 抖音话题是 editor-kit 的实体，只有「敲 # → 从候选里选中」才会生成。本 book 用 paste
// 灌正文，paste 进去的 #xxx 永远是纯文本：发布后点不开，也拿不到抖店那 10% 流量扶持。
// 2026-09-21 实测 Enter / ArrowDown+Enter / 点击候选行三种方式都无法用合成事件选中，
// 所以本 book 造不出实体，只能在这里响亮失败。后台的「查看看后搜配置」抽屉会把纯文本 #
// 临时渲染成话题样式，真假长得一模一样——**后台验收不出来，只有发布后的原文能分辨**。
console.log("\ndoudian-image-text-publish · 正文自检");
// code 在本仓的 book 里有「字符串」和「按行数组」两种形态，归一化后再找，否则
// 数组上的 .includes() 是逐元素全等比较，会静默匹配不到（或匹配到别的步骤）。
const asSource = (code) => (Array.isArray(code) ? code.join("\n") : typeof code === "string" ? code : "");
const bodySelfCheckStep = imageTextBook.steps.find(
  (step) => step.action?.method === "browser.eval" && asSource(step.action.params?.code).includes("ai-draft-resurrected"),
);
if (!bodySelfCheckStep) {
  console.error("\n在 doudian-image-text-publish 里找不到正文自检步骤，断言没有目标。");
  process.exit(2);
}
const bodySelfCheckCode = asSource(bodySelfCheckStep.action.params.code);
const runBodySelfCheck = async ({ body, aiDraft = "", copy = "manual" }) => {
  const ed = { innerText: body };
  const drawer = { querySelector: (sel) => (sel.includes("contenteditable") ? ed : null) };
  globalThis.window = { __bcpIt: { aiDraftBefore: aiDraft } };
  globalThis.document = { querySelector: (sel) => (sel.includes("auxo-drawer-body") ? drawer : null) };
  const run = new Function("bcpDeadline", "bcpWait", "bcpDom", `return (${bodySelfCheckCode.replaceAll("{{copy}}", copy)});`);
  try {
    return { out: await run(Date.now() + 1000, { sleep: () => Promise.resolve() }, BCP_DOM_STUB), state: globalThis.window.__bcpIt };
  } catch (e) {
    return { err: String(e.message || e) };
  }
};
{
  const { out, err } = await runBodySelfCheck({ body: "掌心大的水豚\n#水豚 #毛绒挂件 #包包挂件" });
  check("正文自检 · 纯文本话题被拦下", out?.ok === false && out?.reason === "plain-text-topic", err || JSON.stringify(out));
  check("正文自检 · 如实报出有几个 #", out?.hashCount === 3, JSON.stringify(out));
}
{
  const { out, state, err } = await runBodySelfCheck({ body: "掌心大的水豚，衣柜比我丰富。自带龙虾扣和一颗小铃铛。" });
  check("正文自检 · 无话题的正文放行", out?.ok === true, err || JSON.stringify(out));
  check("正文自检 · 放行时给 verify 留下 topicsPlain=0", state?.__bcpIt === undefined && state?.topicsPlain === 0, JSON.stringify(state));
}
{
  // copy=ai 的正文是抖店自己生成的，带真实体，不能被这条规则误伤。
  const { out, err } = await runBodySelfCheck({ body: "抖店AI写的 #玩偶 #毛绒玩具", copy: "ai" });
  check("正文自检 · copy=ai 不受话题规则约束", out?.ok === true && typeof out?.skipped === "string", err || JSON.stringify(out));
}
{
  // 回归守卫：加话题检查不能把原有的「AI 草稿复活」检查挤掉。
  const draft = "软乎乎的毛绒小公仔抱着rua超治愈";
  const { out, err } = await runBodySelfCheck({ body: `我自己写的正文${draft}`, aiDraft: draft });
  check("正文自检 · AI 草稿复活仍然会被抓到", out?.ok === false && out?.reason === "ai-draft-resurrected", err || JSON.stringify(out));
}
check(
  "正文自检 · verify 同时要求 aiDraftClean 与 topicsPlain",
  /aiDraftClean === true/.test(bodySelfCheckStep.verify?.evalCheck?.code ?? "") && /topicsPlain === 0/.test(bodySelfCheckStep.verify?.evalCheck?.code ?? ""),
  bodySelfCheckStep.verify?.evalCheck?.code,
);

// ═══ doudian-publish-canonical · 网络 dump 的大小收敛 ═══════════════════════
// browser.eval 的序列化上限是 20 万字符，超了不会报错：引擎把 JSON 字符串从中间
// 【切断】再回传，下一步 local.writeFile 照写不误，而这两步的 verify 都是
// (() => true)()。于是 reports/doudian-qualification-capture.json 全程绿灯地
// 长成一份 Unterminated string —— 2026-09-14 的两份真实产物长度都正好是 200000，
// 被切掉的恰好是 diagnose_product / getSchema 那些「填了什么 → 平台要什么」配对的
// 后半段，而 step 30 自称这是该映射的【唯一】可得来源。
// 这组断言钉死的不是「dump 小」，是「dump 完整可解析」：能解析的半份有用，
// 解析不了的整份等于零。
console.log("\ndoudian-publish-canonical · 网络 dump 大小收敛");
const dumpStep = book("doudian-publish-canonical").steps.find(
  (step) => step.action?.method === "browser.eval" && asSource(step.action.params?.code).includes("out.序列化字符数 = size();"),
);
if (!dumpStep) {
  console.error("\n在 doudian-publish-canonical 里找不到网络 dump 步骤，断言没有目标 = 没有测。");
  process.exit(2);
}
const dumpCode = asSource(dumpStep.action.params.code);
const runDump = (entries) => {
  globalThis.window = { __bcpNet: entries };
  globalThis.location = { href: "https://fxg.jinritemai.com/ffa/g/create" };
  const run = new Function("bcpDeadline", "bcpWait", "bcpDom", `return (${dumpCode});`);
  try {
    return { out: run(Date.now() + 1000, {}, BCP_DOM_STUB) };
  } catch (e) {
    return { err: String(e.message || e) };
  }
};
// KEEP 命中 schema，所以这些都算「关注端点」= 不截断的那一类，也就是撑爆 dump 的那一类。
const fatEntry = (i) => ({ m: "POST", u: "/product/tproduct/getSchema", q: `?i=${i}`, st: 200, rq: "x".repeat(40000), b: "y".repeat(40000) });
const parses = (s) => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};
{
  const { out, err } = runDump(Array.from({ length: 24 }, (_, i) => fatEntry(i)));
  const s = JSON.stringify(out ?? null);
  check("网络 dump · 返回值不超过 eval 的 20 万序列化上限", s.length <= 200000, err || `${s.length} 字符`);
  check("网络 dump · 产物完整可 JSON.parse", parses(s), err || `${s.length} 字符`);
  check("网络 dump · 丢了几条写在脸上", (out?.丢弃最旧样本 ?? 0) > 0, JSON.stringify({ 丢弃: out?.丢弃最旧样本, 保留: out?.样本?.length }));
  // 丢弃方向必须是「丢旧留新」：越靠后的调用离「刚填了什么属性」越近。
  check("网络 dump · 保留的是最新的样本", out?.样本?.at(-1)?.q === "?i=23", JSON.stringify(out?.样本?.map((r) => r.q) ?? null));
}
{
  // 收敛不能退化成无条件砍：没超限时一条都不该少，也不该凭空多出丢弃计数。
  const { out, err } = runDump([{ m: "POST", u: "/product/tproduct/getSchema", q: "?i=0", st: 200, rq: "x", b: "y" }]);
  check("网络 dump · 没超限时一条不丢", out?.样本?.length === 1 && out?.丢弃最旧样本 === undefined, err || JSON.stringify(out));
}
{
  // 单条自己就超限：留住它的头部并标明不完整，而不是让整份文件报废。
  const { out, err } = runDump([{ m: "POST", u: "/product/tproduct/getSchema", q: "?i=0", st: 200, rq: "x".repeat(150000), b: "y".repeat(150000) }]);
  const s = JSON.stringify(out ?? null);
  check("网络 dump · 单条超限也收敛进上限", s.length <= 200000 && parses(s), err || `${s.length} 字符`);
  check("网络 dump · 被截的那条自己标明", out?.样本?.[0]?.本条已截断 === true, JSON.stringify({ rq: out?.样本?.[0]?.rq?.length, b: out?.样本?.[0]?.b?.length, 标: out?.样本?.[0]?.本条已截断 }));
}

// ═══ doudian-publish-canonical · 回执归集 ═══════════════════════════════════
// 这一组的存在理由是 2026-09-13 run a15accc6：填写检查 0 错误 → 点了「发布商品」→
// 跳到 /ffa/g/list，然后读回执那一步的 browser.eval 没返回结果，整步失败 → run
// failed、productId 丢失、上层 flow 记成「从来没发布过」。不可逆动作已经落地了，
// 却被一个【只读】步骤的失败抹掉。
// 改法：读取换成 browser.readContent（不需要页面允许 MAIN world 的 new Function），
// 解析全部搬到 local.eval，跑在后端、不受页面限制。所以下面最要紧的一条不是
// 「能解析对」，而是「解析不出来时，已经点下去的那件事还在不在」。
console.log("\ndoudian-publish-canonical · 回执归集");
const publishSteps = book("doudian-publish-canonical").steps;
// goal 取自 book 本身：local.eval 用 startsWith 认上游步骤，前缀写死在代码里。
// 这里若改用假 goal，book 的 goal 一改就会两边一起漂而测试照绿。
const goalOf = (prefix) => {
  const hits = publishSteps.filter((s) => (s.goal ?? "").startsWith(prefix));
  if (hits.length !== 1) {
    console.error(`\n在 doudian-publish-canonical 里按 ${JSON.stringify(prefix)} 定位步骤失败(命中 ${hits.length} 个)。断言没有目标 = 没有测。`);
    process.exit(2);
  }
  return hits[0].goal;
};
const collectStep = publishSteps.find((s) => (s.goal ?? "").startsWith("将本次回执读数归集"));
if (!collectStep || collectStep.action?.method !== "local.eval") {
  console.error("\n在 doudian-publish-canonical 里找不到 local.eval 回执归集步骤，断言没有目标 = 没有测。");
  process.exit(2);
}
const PRODUCT = { title: { text: "爆炸头萌新出击手办盲盒装饰小众创意生日礼物蜡笔小新周边盲盒批" } };
// 真实替换走 fillValue：整对象的 inline slot → JSON.stringify，和这里一致。
const collectCode = asSource(collectStep.action.params.code).replaceAll("{{product}}", JSON.stringify(PRODUCT));
// runLocalEval 的形状：(function (results) { <code> })(results)
const runCollect = (results) => {
  try {
    return { out: new Function("results", collectCode)(results) };
  } catch (e) {
    return { err: String(e.message || e) };
  }
};
const receiptResults = ({ text, mode = "publish", checkErrors = [], missingRequired = [], url = "https://fxg.jinritemai.com/ffa/g/list", omitSubmit = false }) =>
  [
    { index: 30, goal: goalOf("提交前运行抖店的填写检查"), method: "browser.eval", value: { value: { ok: true, requestedMode: "auto", mode, checked: true, checkErrors, missingRequired } } },
    omitSubmit ? null : { index: 31, goal: goalOf("按填写检查后的实际落点提交"), method: "browser.eval", value: { value: { ok: true, mode, clicked: mode === "publish" ? "发布商品" : "保存草稿", receiptPath: url.includes("/draft") ? "/ffa/g/draft" : "/ffa/g/list", checkErrors } } },
    { index: 32, goal: goalOf("读回执页全文"), method: "browser.readContent", value: { value: { url, title: "商品管理", text } } },
  ].filter(Boolean);
// 回执页 innerText 的形状：一行表格被拆成多段换行，行与行之间没有任何结构标记。
const receiptRow = (title, id, status, stamp) => `${title}\nID: ${id}\n￥69.00\n${status}\n${stamp}\n`;
const LIST_HEAD = "商品管理\n商品信息\n价格\n库存\n状态\n操作\n";
{
  const text = LIST_HEAD + receiptRow(PRODUCT.title.text, "3842783454093770762", "售卖中", "2026/09/15 09:39:46");
  const { out, err } = runCollect(receiptResults({ text }));
  check("回执归集 · 读出商品 ID", out?.productId === "3842783454093770762", err || JSON.stringify(out));
  check("回执归集 · 读出状态与创建时间", out?.status === "售卖中" && out?.createdAt === "2026/09/15 09:39:46", JSON.stringify({ s: out?.status, t: out?.createdAt }));
  check("回执归集 · publish 落点判成已发布", out?.outcome?.status === "published" && out?.outcome?.resourceId === "3842783454093770762", JSON.stringify(out?.outcome));
  check("回执归集 · productUrl 如实留空而不是猜一个", out?.productUrl === null && typeof out?.productUrlNote === "string", JSON.stringify({ u: out?.productUrl, n: out?.productUrlNote }));
}
{
  // 列表按创建时间倒序：紧挨着的下一条常常是上一次运行发的【同款】，只有 ID 不同。
  // 窗口划宽一点就会把它的状态/时间读到本条头上，而且读串了看不出来。
  const text =
    LIST_HEAD +
    receiptRow(PRODUCT.title.text, "3842783454093770762", "待提交", "2026/09/15 09:39:46") +
    receiptRow(PRODUCT.title.text, "3842700000000000000", "售卖中", "2026/09/14 08:00:00");
  const { out, err } = runCollect(receiptResults({ text, mode: "draft", checkErrors: ["型号 | 错误 | 该项为必填，请输入"], url: "https://fxg.jinritemai.com/ffa/g/draft" }));
  check("回执归集 · 不把下一条商品的状态读到本条头上", out?.status === "待提交" && out?.createdAt === "2026/09/15 09:39:46", err || JSON.stringify({ id: out?.productId, s: out?.status, t: out?.createdAt }));
  check("回执归集 · draft 落点判成草稿已保存", out?.outcome?.status === "draft_saved", JSON.stringify(out?.outcome));
  check("回执归集 · 存草稿的原因带上抖店原话", (out?.reason ?? "").includes("型号 | 错误 | 该项为必填，请输入"), JSON.stringify(out?.reason));
}
{
  // ★ 这一条是整组的理由：2026-09-13 的场景 —— 已经点了「发布商品」并跳到列表页，
  // 但列表里读不到这条商品。它必须产出「待核验」，而不是丢掉「已经点下去了」。
  const { out, err } = runCollect(receiptResults({ text: LIST_HEAD + receiptRow("别人家的商品", "3800000000000000000", "售卖中", "2026/09/10 10:00:00") }));
  check("回执归集 · 读不到本条时不抛错", !err && !!out, err);
  check("回执归集 · 读不到本条时不认领 productId", out?.productId === null && out?.ok === false, JSON.stringify(out));
  check("回执归集 · 已点下去的落点不被抹掉", out?.mode === "publish", JSON.stringify({ mode: out?.mode }));
  check("回执归集 · 产出「待核验」而不是失败", out?.outcome?.status === "needs_verification" && out?.outcome?.level === "warning", JSON.stringify(out?.outcome));
  check("回执归集 · 原因说明动作已经发生", (out?.reason ?? "").includes("发布商品"), JSON.stringify(out?.reason));
}
{
  // 本条的状态/时间还没渲染，下一条已经有了 —— 没有 ID 边界时，正则的第一个命中会落到
  // 【别人】头上，产出一个看起来完全正常的错值。这种错没有任何迹象，比读不到严重得多。
  const text =
    LIST_HEAD +
    `${PRODUCT.title.text}\nID: 3842783454093770762\n￥69.00\n` +
    receiptRow("上一次运行发的同款", "3842700000000000000", "售卖中", "2026/09/14 08:00:00");
  const { out, err } = runCollect(receiptResults({ text }));
  check("回执归集 · 本条 ID 读得到", out?.productId === "3842783454093770762", err || JSON.stringify(out));
  check("回执归集 · 本条缺状态时不借下一条的", out?.status === null && out?.createdAt === null, JSON.stringify({ s: out?.status, t: out?.createdAt }));
  check("回执归集 · 本条缺状态 → 待核验而不是冒充成功", out?.outcome?.status === "needs_verification", JSON.stringify(out?.outcome));
}
{
  // 「没找到标题」和「找到了但没 ID」是两件事：前者多半是行还没灌进列表，后者是读数不对。
  // 含糊成一句话会把人支去查错的地方 —— 这正是上一版那句「可能是 CSP」的毛病。
  const { out } = runCollect(receiptResults({ text: LIST_HEAD + PRODUCT.title.text + "\n草稿\n" }));
  check("回执归集 · 区分「没找到标题」与「找到了没 ID」", (out?.reason ?? "").includes("没读到商品 ID"), JSON.stringify(out?.reason));
}
{
  // 提交凭据是 draft/publish 的唯一权威来源。没有它就不知道点的是哪一个，
  // 此时凭空产出一个 outcome 等于伪造 —— fail-closed。
  const { out, err } = runCollect(receiptResults({ text: LIST_HEAD, omitSubmit: true }));
  check("回执归集 · 缺提交凭据时响亮失败", !!err && !out, JSON.stringify(out));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
