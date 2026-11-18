#!/usr/bin/env node
/**
 * 收敛终检：验「该消失的真消失了、该保留的还在」。
 *
 * 本脚本负责收敛后的结构与不变量：该消失的没了、该保留的还在、手写约束没被
 * RedefineTables 吃掉。历史上的 payload migration / registry 名单检查已完成使命，
 * 不再作为当前可执行检查保留。
 *
 * 曾经还有一个 check-migration.mjs，验的是 migration 1（payload_convergence）
 * 刚落地那一刻的结构。migration 2 把 Artifact 表删掉之后，它在开头的行数循环上
 * 就崩了（`no such table: Artifact`），后面六项结构检查一条都执行不到。那六项
 * 里，索引 / CHECK / 全表时间戳 / Book 的两个 ref 列这四项与本脚本完全重复；
 * 没被覆盖的只有 SchemaRecord.schemaVersion 这一列和迁移账本，已分别搬进下面的
 * ③ 和 ⑧。行数快照（Run 105 / Schema 4 / SchemaRecord 1 …）故意没搬：那是"那
 * 一次迁移没动过行"的一次性证据，库正常演进后本就不该再成立（现在 Schema 12
 * 份、SchemaRecord 19 行）。
 *
 * 纯读。跑法：node scripts/check-convergence.mjs（= pnpm check:convergence）
 */
import { DatabaseSync } from "node:sqlite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const db = new DatabaseSync(resolve(ROOT, "resource/db/console.db"), { readOnly: true });
let ok = true;
const fail = (msg) => { ok = false; console.log(`  ✗ ${msg}`); };
const pass = (msg) => console.log(`  ✓ ${msg}`);

const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name));
const colsOf = (t) => (tables.has(t) ? db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name) : null);

console.log("=== ① 该消失的表 ===");
for (const t of ["OutputRecord", "Artifact"]) {
  tables.has(t) ? fail(`${t} 仍存在`) : pass(`${t} 已删除`);
}

console.log("\n=== ② 该消失的列 ===");
const gone = {
  Run: ["outputsJson", "outputsData", "outputsType", "outputsContentType", "outputsSchemaErrors", "paramsTypeJson"],
  FlowRun: ["outputsJson"],
  DeliveryRun: ["payloadJson"],
};
for (const [t, cols] of Object.entries(gone)) {
  const have = colsOf(t);
  if (!have) { fail(`${t} 表不见了（不该删这张）`); continue; }
  const left = cols.filter((c) => have.includes(c));
  left.length ? fail(`${t} 仍有 ${left.join(", ")}`) : pass(`${t} 的 ${cols.length} 列已删净`);
}

console.log("\n=== ③ 该保留的（删过头的反向检查）===");
const keep = {
  // 本次投递契约的 SSOT：不可变，重投递靠它。Book.deliveriesJson 被 filesync
  // 覆写，不能当历史真相源 —— 删错这一列会让重投递读到改书后的新配置。
  Run: ["deliverySnapshotJson", "deliveryOverridesJson", "paramsJson", "paramSchemaRef"],
  Book: ["paramSchema", "outputSchema", "paramSchemaRef", "outputSchemaRef", "deliveriesJson"],
  // 显示用的截断预览，RunDetail.tsx 在渲染，4KB 上限真实生效
  StepRun: ["valuePreview"],
  // schemaVersion 从已删除的 check-migration 搬来：它与 schemaName 一起构成
  // 指向 Schema 注册表的引用，少了它 data 支就说不清自己按哪一版契约校验过。
  SchemaRecord: ["contentType", "schemaName", "schemaVersion", "data", "fileName", "url", "bytes", "source", "schemaErrors"],
};
for (const [t, cols] of Object.entries(keep)) {
  const have = colsOf(t);
  if (!have) { fail(`${t} 表被删了（不该）`); continue; }
  const missing = cols.filter((c) => !have.includes(c));
  missing.length ? fail(`${t} 少了 ${missing.join(", ")}`) : pass(`${t} 的 ${cols.length} 个关键列都在`);
}

console.log("\n=== ④ 手写约束（RedefineTables 最容易静默丢的）===");
// 这两条一度只 grep 关键字（`includes("WHERE")` / `includes("CHECK")`），于是
// 把索引重建成 `WHERE "source" IS NOT NULL`（丢掉 deletedAt 那半个条件）或把
// 约束写成 `CHECK (1=1)` 都能拿到 ✓ —— 而丢掉 deletedAt 那半个条件的真实后果
// 是：软删一行再重新落同一 source，直接 `UNIQUE constraint failed`。防"漏
// WHERE 子句"的检查自己漏看了 WHERE 子句的内容，所以现在比对的是子句本身。
const idxVerdict = indexProblem(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uniq_active_record_source'").get()?.sql);
idxVerdict
  ? fail(`uniq_active_record_source：${idxVerdict}`)
  : pass("uniq_active_record_source = UNIQUE ON SchemaRecord(source) WHERE source IS NOT NULL AND deletedAt IS NULL");
const checkVerdict = checkProblem(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='SchemaRecord'").get()?.sql);
checkVerdict
  ? fail(`SchemaRecord 的 CHECK：${checkVerdict}`)
  : pass("SchemaRecord 建表语句里的 CHECK = (data IS NULL) <> (url IS NULL)");

console.log("\n=== ⑤ 载荷唯一落点（收敛的最终判据）===");
const r = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN data IS NOT NULL THEN 1 ELSE 0 END) d,
  SUM(CASE WHEN url IS NOT NULL THEN 1 ELSE 0 END) u FROM SchemaRecord WHERE deletedAt IS NULL`).get();
console.log(`  SchemaRecord ${r.n} 行：data 支 ${r.d} · file 支 ${r.u}`);
// 判据以前是 d + u === n，那是一道会自我抵消的等式：一行两支都空（对 d、u 都
// 不计数）配上一行两支都有（对两边都计数），总和照样对得上，两条违例一起消失。
// 现在逐行问"这一行是不是恰好一支"，违例数不能被别的违例抵消。
const violations = db.prepare(`SELECT id, CASE WHEN data IS NULL THEN '两支都空' ELSE '两支都有' END AS why
  FROM SchemaRecord WHERE deletedAt IS NULL AND (data IS NULL) = (url IS NULL)`).all();
violations.length === 0
  ? pass(`${r.n} 行逐行核对，每一行恰好落在一支`)
  : fail(`${violations.length} 行违例：${violations.slice(0, 5).map((v) => `${v.id}(${v.why})`).join("、")}${violations.length > 5 ? " …" : ""}`);

console.log("\n=== ⑥ 契约唯一住处 ===");
const sc = db.prepare("SELECT COUNT(*) c FROM Schema WHERE deletedAt IS NULL").get().c;
// 两个计数器必须数同一群体——都限定在「有入参」的书上。`refd` 曾经不带
// `paramSchema != '[]'`，于是一本零参数却写了 paramSchemaRef 的书（第一例是
// doudian-shopprofile）只进 refd 不进 withParams，差值凭空少 1，把一条真实
// 违例算没了。作用域错配的检查比没有检查更糟：它会给出"通过"的假象。
const inlineBooks = db
  .prepare("SELECT name FROM Book WHERE paramSchema != '[]' AND paramSchemaRef IS NULL AND deletedAt IS NULL ORDER BY name")
  .all()
  .map((b) => b.name);
const withParams = db.prepare("SELECT COUNT(*) c FROM Book WHERE paramSchema != '[]' AND deletedAt IS NULL").get().c;
const refd = withParams - inlineBooks.length;
console.log(`  Schema 注册表 ${sc} 份 | 有入参的 book ${withParams} 本，其中 ${refd} 本走 ref`);
inlineBooks.length === 0
  ? pass("所有有入参的 book 都引用注册表")
  : fail(`还有 ${inlineBooks.length} 本走内联：${inlineBooks.join("、")}`);

console.log("\n=== ⑦ 全表时间戳（追加型审计表按其事件时钟放行）===");
let tsOk = true;
// 数的是真正走过循环的表，不是 tables.size - 1 —— 后者只在"恰好有一张下划线
// 表"时才对得上，多一张 `_foo` 就会报一个没验过的数字。
const timestamped = [...tables].filter((n) => !n.startsWith("_") && !n.startsWith("sqlite"));
// BrowserEvent / LlmCall are append-only ingress logs. Their immutable event
// clocks are receivedAt (and startedAt for LlmCall), so requiring mutable
// createdAt/updatedAt would be a false schema regression rather than a guard.
const timestampExceptions = {
  CronLease: ["createdAt", "updatedAt"],
  BrowserEvent: ["receivedAt", "deletedAt"],
  LlmCall: ["startedAt", "receivedAt", "deletedAt"],
};
for (const t of timestamped) {
  const c = colsOf(t);
  const want = timestampExceptions[t] ?? ["createdAt", "updatedAt", "deletedAt"];
  const miss = want.filter((k) => !c.includes(k));
  const bad = t === "CronLease" && c.includes("deletedAt");
  if (miss.length || bad) { tsOk = false; console.log(`  ✗ ${t}: ${bad ? "不该有 deletedAt" : "缺 " + miss.join(",")}`); }
}
tsOk ? pass(`${timestamped.length} 张表时间戳齐全，CronLease 按例外放行`) : (ok = false);

console.log("\n=== ⑧ 迁移账本 ===");
// 从已删除的 check-migration 搬来，并且升级成了真判据：那边只把账本打印出来，
// 从没进过它的 allOk，回滚过的迁移也照样 exit 0。
const ledger = db.prepare("SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at").all();
let ledgerOk = true;
if (ledger.length === 0) { ledgerOk = false; fail("_prisma_migrations 是空的"); }
for (const m of ledger) {
  if (m.rolled_back_at) { ledgerOk = false; fail(`${m.migration_name} 已回滚`); }
  else if (!m.finished_at) { ledgerOk = false; fail(`${m.migration_name} 未完成`); }
}
if (ledgerOk) pass(`${ledger.length} 次迁移全部完成且无回滚：${ledger.map((m) => m.migration_name).join(" → ")}`);

db.close();
console.log(`\n${ok ? "✓ 收敛完成" : "✗ 有项目未通过"}`);
process.exit(ok ? 0 : 1);

/** SQLite 把建表 / 建索引语句原样存在 sqlite_master 里，含换行、标识符引号和
 *  `--` 注释。比较之前先把这些噪声去掉，只剩语义。 */
function normalizeDdl(sql) {
  return sql.replace(/--[^\n]*/g, " ").replace(/["`[\]]/g, "").replace(/\s+/g, " ").trim();
}

/** 部分唯一索引哪里不对；`null` = 没毛病。
 *
 *  逐项判 UNIQUE / 建在哪张表哪一列 / WHERE 的条件集合，而不是 grep "WHERE"：
 *  `WHERE 1=1` 和只剩 `source IS NOT NULL` 都带 WHERE，也都是坏结构。条件按
 *  集合比而不按字面比，是为了容忍两个 AND 项换个顺序写。 */
function indexProblem(sql) {
  if (!sql) return "索引不存在";
  const flat = normalizeDdl(sql);
  if (!/^CREATE\s+UNIQUE\s+INDEX\b/i.test(flat)) return `不是 UNIQUE 索引：${flat}`;
  const on = flat.match(/\bON\s+SchemaRecord\s*\(([^)]*)\)/i);
  if (!on || on[1].trim().toLowerCase() !== "source") return `不是建在 SchemaRecord(source) 上：${flat}`;
  const where = flat.match(/\bWHERE\b(.+)$/i);
  if (!where) return `缺 WHERE 子句 —— 部分索引退化成全表唯一：${flat}`;
  const want = ["source is not null", "deletedat is null"];
  const got = new Set(where[1].split(/\bAND\b/i).map((t) => t.replace(/[()]/g, " ").replace(/\s+/g, " ").trim().toLowerCase()));
  if (got.size !== want.length || !want.every((w) => got.has(w))) {
    // deletedAt 那半个条件是最容易被顺手删掉的一半，也是最贵的一半：没有它，
    // 软删一行再重新落同一个 source 会撞 UNIQUE constraint failed。
    return `WHERE 条件应为 {${want.join(" / ")}}，实际为 {${[...got].join(" / ")}}`;
  }
  return null;
}

/** data/url 互斥的 CHECK 哪里不对；`null` = 没毛病。
 *
 *  取 CHECK(...) 的括号配对内容再抹掉空白和括号来比 —— 只认表达式本身，
 *  `CHECK (1=1)` 这种恒真写法过不去，而 `(((a) <> (b)))` 这种多层括号能过。 */
function checkProblem(ddl) {
  if (!ddl) return "读不到 SchemaRecord 的建表语句";
  const flat = normalizeDdl(ddl);
  const at = flat.search(/\bCHECK\s*\(/i);
  if (at < 0) return `建表语句里没有 CHECK：${flat}`;
  let depth = 0, start = flat.indexOf("(", at), expr = null;
  for (let i = start; i < flat.length; i++) {
    if (flat[i] === "(") depth++;
    else if (flat[i] === ")" && --depth === 0) { expr = flat.slice(start + 1, i); break; }
  }
  if (expr === null) return `CHECK 的括号没配对：${flat}`;
  const canon = expr.replace(/[\s()]/g, "").toLowerCase();
  if (canon !== "dataisnull<>urlisnull") return `表达式不是 data/url 互斥，实际为 CHECK (${expr.trim()})`;
  return null;
}
