/**
 * book 写法普查 —— ultrago-book-authoring skill 里每条规则的数字来源。
 *
 * skill 的规则都带着「实测 N 次」的数字，而数字会随 book 增删而漂。此前 §11 只留了
 * 一段伪代码注释描述「该数什么」，于是复核成本高到没人做：2026-09-05 那版数字写的是
 * 7 本 / 3187 步，到 2026-09-09 已经是 10 本，每一条都过时了而没人知道。
 *
 * 所以把它变成可跑的：`node scripts/census-books.mjs`。它只读不写，输出一张
 * 「规则 → 违规存量 → 执法者」的表，直接对应 skill 的章节号。
 *
 * 判据故意写得保守（宁可漏报不误报），因为这些数字会被抄进 skill 当依据：
 *   · 赋值类一律排除 `==` / `===`（`window.__take === 'fn'` 是读不是写，
 *     不排除会把那 3040 处只读探针全判成副作用 —— 实测差别是 10 vs 3051）
 *   · 手写轮询只认循环【头部】带钟，循环体里的计时不算
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOOKS_DIR = resolve(ROOT, "resource/playbooks");

const { normalizeBookCode } = await import(
  new URL("../packages/shared/dist/book-code.js", import.meta.url)
);
// 内联 JS 允许写成行数组。不归一化，下面每条正则都会静默失效（数组转字符串是逗号
// 连接，正则大概率不再命中）—— 和 check-books.mjs 用同一个入口，同一个理由。
const parse = (f) => {
  const raw = JSON.parse(readFileSync(resolve(BOOKS_DIR, f), "utf8"));
  normalizeBookCode(raw);
  return raw;
};

const files = readdirSync(BOOKS_DIR).filter((f) => f.endsWith(".json")).sort();
if (!files.length) {
  console.error(`no books in ${BOOKS_DIR} — 拒绝输出一张全 0 的表`);
  process.exit(2);
}

const WEAK = new Set(["actionSucceeded", "noErrors", "settled"]);
const R = {
  handPoll: /\b(?:while|for)\s*\([^{]{0,160}?Date\.now\s*\(\)/g,
  infLoop: /\b(?:while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\))/g,
  setTimeout: /setTimeout\s*\(/g,
  bcpWait: /bcpWait\.(\w+)/g,
  // 赋值：排除 == / ===，否则只读比较会被算成写
  sideEffect: /\.click\s*\(|scrollTop\s*=(?!=)|scrollIntoView|window\.__\w+\s*=(?!=)/,
  winState: /window\.__\w+\s*=(?!=)/g,
  dataModule: /\[data-module[=~|^$*]?=?/g,
  classSel: /querySelector(?:All)?\s*\(\s*['"`][^'"`]*\./g,
  roleSel: /\[(?:role|aria-)[^\]]*\]/g,
  querySel: /querySelector(?:All)?\s*\(/g,
};
const count = (s, re) => (s.match(re) || []).length;

const stats = {
  books: files.length, steps: 0, evalSites: 0,
  actions: {}, verbs: {}, weakVerify: 0, verifiedSteps: 0,
  handPoll: 0, infLoopWithClock: 0, setTimeout: 0, bcpWait: {},
  sideEffectVerify: 0, evalCheckSegs: 0,
  winStateWrites: 0, riskConfirm: 0,
  navStepsWithWaitVerify: 0, navSteps: 0,
  querySel: 0, dataModule: 0, classSel: 0, roleSel: 0,
};
const samples = { handPoll: [], sideEffect: [], navVerify: [] };

for (const f of files) {
  const name = basename(f, ".json");
  const pb = parse(f);
  for (const [i, step] of (pb.steps ?? []).entries()) {
    stats.steps++;
    const method = step.action?.method ?? "(none)";
    stats.actions[method] = (stats.actions[method] ?? 0) + 1;
    if (step.risk === "confirm") stats.riskConfirm++;

    const present = Object.entries(step.verify ?? {})
      .filter(([, v]) => v !== undefined && v !== false).map(([k]) => k);
    if (present.length) {
      stats.verifiedSteps++;
      for (const k of present) stats.verbs[k] = (stats.verbs[k] ?? 0) + 1;
      if (present.every((k) => WEAK.has(k))) stats.weakVerify++;
    }

    // §5.5 —— 非幂等动作（开窗/开 tab）的 verify 里放了要等 DOM 的判据
    if (method === "browser.newWindow" || method === "browser.newTab") {
      stats.navSteps++;
      const waity = present.filter((k) =>
        ["elementName", "textPresent", "elementEnabled", "elementValue"].includes(k));
      if (waity.length) {
        stats.navStepsWithWaitVerify++;
        if (samples.navVerify.length < 3) samples.navVerify.push(`${name} step ${i + 1} · verify 含 ${waity.join("+")}`);
      }
    }

    const codes = [];
    if (typeof step.action?.params?.code === "string") codes.push(["action", step.action.params.code]);
    const vc = step.verify?.evalCheck?.code;
    if (typeof vc === "string") {
      codes.push(["verify.evalCheck", vc]);
      stats.evalCheckSegs++;
      if (R.sideEffect.test(vc)) {
        stats.sideEffectVerify++;
        if (samples.sideEffect.length < 4)
          samples.sideEffect.push(`${name} step ${i + 1} · ${vc.match(R.sideEffect)[0]}`);
      }
    }
    for (const [where, code] of codes) {
      stats.evalSites++;
      const hp = count(code, R.handPoll);
      stats.handPoll += hp;
      if (/Date\.now\s*\(\)/.test(code)) stats.infLoopWithClock += count(code, R.infLoop);
      stats.setTimeout += count(code, R.setTimeout);
      stats.winStateWrites += count(code, R.winState);
      stats.querySel += count(code, R.querySel);
      stats.dataModule += count(code, R.dataModule);
      stats.classSel += count(code, R.classSel);
      stats.roleSel += count(code, R.roleSel);
      for (const m of code.matchAll(R.bcpWait)) stats.bcpWait[m[1]] = (stats.bcpWait[m[1]] ?? 0) + 1;
      if (hp && samples.handPoll.length < 3) {
        const hit = code.match(R.handPoll)[0].replace(/\s+/g, " ");
        samples.handPoll.push(`${name} step ${i + 1} (${where}) — ${hit}`);
      }
    }
  }
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const row = (rule, n, enforcer) => console.log(`  ${rule.padEnd(34)} ${String(n).padStart(6)}   ${enforcer}`);

console.log(`\nbook 普查 — ${stats.books} 本 / ${stats.steps} 步 / ${stats.evalSites} 个 eval 站点\n`);

console.log("动作分布（前 6）");
Object.entries(stats.actions).sort((a, b) => b[1] - a[1]).slice(0, 6)
  .forEach(([m, n]) => console.log(`  ${m.padEnd(34)} ${String(n).padStart(6)}   ${pct(n, stats.steps)}`));

console.log("\n等待原语采用（skill §2/§3）");
for (const k of ["until", "sleep", "netIdle", "domQuiet", "grew"])
  console.log(`  bcpWait.${k}`.padEnd(36) + String(stats.bcpWait[k] ?? 0).padStart(6));

console.log("\n规则 → 违规存量 → 执法者");
row("§3 手写轮询（循环头带钟）", stats.handPoll, "check:books · HAND_POLL");
row("§3 无限循环+钟", stats.infLoopWithClock, "check:books · HAND_POLL_INF");
row("§3 裸 setTimeout", stats.setTimeout, "（未单独执法）");
row("§4 verify 带副作用", `${stats.sideEffectVerify}/${stats.evalCheckSegs}`, "无 —— 靠自觉");
row("§5 verify 只含弱谓词", `${stats.weakVerify}/${stats.verifiedSteps}`, "check:books · WEAK_VERIFY");
row("§5.5 开窗步骤 verify 含等待判据", `${stats.navStepsWithWaitVerify}/${stats.navSteps}`, "无 —— 靠 review");
row("§8 写 window.__ 跨步骤状态", stats.winStateWrites, "无");
row("§9 不可逆步骤标 risk:confirm", stats.riskConfirm, "无 —— 0 即这道保护空转");

console.log("\n§6 定位锚点分布（比例比绝对值重要）");
console.log(`  querySelector 总数`.padEnd(36) + String(stats.querySel).padStart(6));
console.log(`  ├─ [data-module] 稳`.padEnd(36) + String(stats.dataModule).padStart(6) + `   ${pct(stats.dataModule, stats.querySel)}`);
console.log(`  ├─ .class 易变`.padEnd(36) + String(stats.classSel).padStart(6) + `   ${pct(stats.classSel, stats.querySel)}`);
console.log(`  └─ [role]/[aria-]`.padEnd(36) + String(stats.roleSel).padStart(6) + `   ${pct(stats.roleSel, stats.querySel)}`);

console.log("\n真实反例（写 skill 时抄这里，别构造玩具代码）");
for (const [k, list] of Object.entries(samples))
  list.forEach((s) => console.log(`  [${k}] ${s}`));
console.log("");
