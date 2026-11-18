#!/usr/bin/env node
/**
 * 软删表态检查：每一次针对软删模型的 Prisma 查询，作者都必须显式表态。
 *
 * 为什么是「表态」而不是「必须过滤」：这个仓库里不过滤往往才是对的。恢复状态机
 * 要读到软删的 run（`dispatcher.service.ts` 里写明，丢掉它会让 run 永远卡在
 * running，而并发计数仍看得见它，于是阻塞该 book 的所有后续 run）；幂等去重要
 * 读到软删的行（全仓只有一个 partial unique index，其余唯一索引都是全量的，软删
 * 的行仍占着唯一键，读不到就会插入并撞上无法恢复的 P2002）；purge / restore /
 * includeDeleted 更是明着要它们。所以一个运行时兜底的 blanket 过滤会一次性抹掉
 * 这些深思熟虑 —— 真正要防的只是「新增查询时没想过这件事」。
 *
 * 于是判据落在形状上，不判断语义（同 check-books 的 eval 硬停 lint）：
 *   查询体里出现 deletedAt        → 表过态了（过滤或显式包含都算）
 *   紧邻上方的注释提到软删语义     → 表过态了（说明为什么不过滤）
 *   文件头的文档块说明了本文件立场 → 整个文件表过态了
 *   都没有                        → 报出来，让作者补一个
 *
 * 文件级那一档是必需的，不是图省事：调度与状态机那几个文件里，「不过滤」是贯穿
 * 全文件的一条立场（dispatcher 有 13 处、flow-runner 7 处、enqueue 5 处），逐处
 * 复述同一句话只会让注释变成背景噪音，而立场本来就该在文件头讲一次。
 *
 * 模型清单从 prisma/schema.prisma 现读，不在本文件复述；读不到就 exit 2，
 * 拒绝在失去基准的情况下静默通过。
 *
 * 纯读。跑法：node scripts/check-soft-delete.mjs（= pnpm check:soft-delete）
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = resolve(ROOT, "packages/console/prisma/schema.prisma");
const SRC = resolve(ROOT, "packages/console/src");

/**
 * 只查「按条件挑行」的方法。
 *
 * Prisma 自己就把这两类分开了：findUnique / update / delete / upsert 的 where 只
 * 收唯一键，调用方已经握着那一行的身份，问题不再是「这行该不该被看见」而是「拿这
 * 行做什么」—— 那是业务判断，不是过滤判断，套进这条 lint 只会制造噪音（实测 166
 * 处里有 87 处是这类，把信号淹掉）。create / createMany 同理，不涉及读到已删的行。
 *
 * 留下的这些是真正在做集合筛选的：少写一个 deletedAt，用户就会看见本该消失的行，
 * 或者对账逻辑会漏掉本该看见的行。
 */
const METHODS = ["findMany", "findFirst", "findFirstOrThrow", "count", "aggregate", "groupBy", "updateMany", "deleteMany"];

/** 就近注释里出现任一即视为「作者在这一处想过软删」。范围只有紧邻的一块，可以宽松。 */
const INTENT = [/deletedAt/i, /soft[- ]?delete/i, /软删/, /tombstone/i, /已删除/, /NOT filtered/i];

/**
 * 文件级立场必须是这句显式声明，不能只是「文件头某处提到了 deletedAt」。
 *
 * 一开始复用 INTENT，结果 books.service.ts 因为文件头某段注释顺带提了一句这个词，
 * 整个文件被免检 —— 把它的列表过滤整个删掉、再新塞一个完全没表态的查询，检查都
 * 照样全绿。豁免范围越大，触发它的条件就得越明确：一句话管一个文件，那句话就必须
 * 是专门为此写的。
 */
const FILE_STANCE = /软删立场|soft-delete stance/i;

// ── ① 软删模型清单：从 schema.prisma 现读 ──
let schemaText;
try {
  schemaText = readFileSync(SCHEMA, "utf8");
} catch {
  console.error(`\n读不到 ${relative(ROOT, SCHEMA)} —— 这条 lint 失去了模型清单基准，拒绝静默通过。`);
  process.exit(2);
}
const softDeletable = new Set();
for (const block of schemaText.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
  if (/^\s*deletedAt\s/m.test(block[2])) softDeletable.add(block[1][0].toLowerCase() + block[1].slice(1));
}
if (softDeletable.size === 0) {
  console.error(`\n在 ${relative(ROOT, SCHEMA)} 里一个带 deletedAt 的 model 都没找到 —— 解析大概率坏了，拒绝静默通过。`);
  process.exit(2);
}
console.log(`软删模型（${softDeletable.size}）：${[...softDeletable].join(", ")}\n`);

// ── ② 扫源码 ──
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    // 测试里的查询是断言用的构造，不改变生产行为，不在射程内。
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) files.push(full);
  }
})(SRC);
if (files.length === 0) {
  console.error(`\n在 ${relative(ROOT, SRC)} 下没扫到任何 .ts —— 射程为空的检查等于没检查，拒绝静默通过。`);
  process.exit(2);
}

/** 从 open 处的 "(" 起做括号配对，返回调用实参文本；不配对返回 null。 */
function callBody(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

/**
 * 顶层 `where` 的值文本；`{ where }` 简写返回 "SHORTHAND"，没有 where 返回 null。
 *
 * 必须只取顶层，不能拿整个调用实参去搜关键词：books 的列表查询里，
 * `include: { runs: { where: { deletedAt: null } } }` 自己带着这个词，于是把顶层
 * 那句过滤整个删掉之后，全文搜索照样命中，检查全绿。嵌套关系的过滤是另一件事，
 * 它管的是「这本 book 的哪些 run 可见」，替不了「哪些 book 可见」。
 */
function topLevelWhere(body) {
  const m = body.match(/[\s{,]where\s*:/);
  if (!m) return /[\s{,]where\s*[,}]/.test(body) ? "SHORTHAND" : null;
  let i = m.index + m[0].length;
  const start = i;
  let depth = 0;
  for (; i < body.length; i++) {
    const c = body[i];
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) { if (depth === 0) break; depth--; }
    else if (c === "," && depth === 0) break;
  }
  return body.slice(start, i);
}

/**
 * `where` 是不是先攒后传的（`const where = {}; … findMany({ where })`）。
 *
 * 只有这一种情况才允许去上方的代码窗口里找 deletedAt。曾经对所有查询都查窗口，
 * 结果是把「同一个方法里**别的**查询写了 deletedAt」也算成表态 —— 实测把 books
 * 列表的过滤整个删掉，检查依然全绿（它的嵌套 runs 里有另一个 deletedAt 在窗口内）。
 * 那正是这条 lint 声称要抓的头号场景，却抓不到。判据必须落在「这一个查询的 where
 * 从哪来」，不能落在「附近有没有出现过这个词」。
 *
 * 返回变量名；`{ where }` 简写返回 "where"；是字面量则返回 null。
 */
function whereVariable(body) {
  if (/\bwhere\s*[,}]/.test(body)) return "where";
  const m = body.match(/\bwhere\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/);
  return m ? m[1] : null;
}

/** 攒 where 的代码通常紧邻调用，25 行够用又不至于够到邻近函数。 */
function codeAbove(lines, lineIdx) {
  return lines.slice(Math.max(0, lineIdx - 25), lineIdx).join("\n");
}

/**
 * 紧邻上方的那一块连续注释（跳过空行即停）。
 *
 * 试过放宽到「上方 15 行内的所有注释」，为的是让写在门禁旁、管着下面几行状态跃迁
 * 的立场也算数。结果是把 books 列表的过滤整个删掉之后检查依然全绿 —— 它上方 15
 * 行里另有一段讲 rescan 的注释碰巧提到了这个词。宽窄之间只能选一个：宁可让作者
 * 在那处多写一行紧邻注释，也不能让这条 lint 漏掉它声称要抓的头号场景。
 */
function commentAbove(lines, lineIdx) {
  const out = [];
  // 调用常被包在一个表达式里（`const existing = new Map(\n  await prisma...`），
  // 那时紧邻上一行是代码而不是注释。允许跨过最多两行代码去够上面那块说明；
  // 一旦开始收注释就不再跨，免得把更上面另一段话算进来。
  let slack = 2;
  for (let i = lineIdx - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === "") { if (out.length) break; continue; }
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.endsWith("*/")) { out.push(t); continue; }
    if (out.length || slack-- <= 0) break;
  }
  return out.join("\n");
}

const callRe = new RegExp(String.raw`\b(?:this\.prisma|prisma|tx)\.(\w+)\.(${METHODS.join("|")})\s*\(`, "g");
const missing = [];
let audited = 0;

/** 文件头文档块里的注释行；只看开头，避免文件中段偶然出现的字样把全文件豁免掉。 */
function fileHeaderComment(lines) {
  return lines
    .slice(0, 60)
    .filter((l) => { const t = l.trim(); return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"); })
    .join("\n");
}

const fileScoped = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const headerDeclares = FILE_STANCE.test(fileHeaderComment(lines));
  for (const m of text.matchAll(callRe)) {
    const [, model, method] = m;
    if (!softDeletable.has(model)) continue;
    audited++;
    const open = m.index + m[0].length - 1;
    const body = callBody(text, open);
    if (body === null) {
      missing.push({ file, line: text.slice(0, m.index).split("\n").length, model, method, why: "括号没配对，无法判定" });
      continue;
    }
    const where = topLevelWhere(body);
    if (where && where !== "SHORTHAND" && /deletedAt/.test(where)) continue;
    const lineIdx = text.slice(0, m.index).split("\n").length - 1;
    const wvar = whereVariable(body);
    // 只在 where 是变量时看上文，且要看到的是「这个变量」被赋过 deletedAt。
    if (wvar && new RegExp(String.raw`\b${wvar}\b[^\n]*deletedAt|deletedAt[^\n]*\b${wvar}\b`).test(codeAbove(lines, lineIdx))) continue;
    if (INTENT.some((re) => re.test(commentAbove(lines, lineIdx)))) continue;
    if (headerDeclares) { fileScoped.push(file); continue; }
    missing.push({ file, line: lineIdx + 1, model, method, why: "查询体没提 deletedAt，上方也没有说明为什么不过滤" });
  }
}

console.log(`审计了 ${audited} 处对软删模型的查询，覆盖 ${files.length} 个源文件。`);
if (fileScoped.length > 0) {
  const byFile = new Map();
  for (const f of fileScoped) byFile.set(f, (byFile.get(f) ?? 0) + 1);
  console.log(`其中 ${fileScoped.length} 处由文件头的立场声明覆盖：`);
  for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`  ${relative(ROOT, f)}  ${n} 处`);
}
console.log();
if (missing.length === 0) {
  console.log("✓ 每一处都表过态了（写了 deletedAt / 就近注释 / 文件头声明）");
  process.exit(0);
}
console.log(`✗ ${missing.length} 处没有表态：\n`);
for (const p of missing) {
  console.log(`  ${relative(ROOT, p.file)}:${p.line}  prisma.${p.model}.${p.method}()`);
  console.log(`    ${p.why}`);
}
console.log(`
补法二选一：
  · 该过滤     → where 里加 deletedAt: null（或 includeDeleted 分支）
  · 不该过滤   → 在调用上方写一行注释说明为什么，提到 deletedAt / 软删 / tombstone 任一即可
这条检查只要求你表态，不替你判断该不该过滤。`);
process.exit(1);
