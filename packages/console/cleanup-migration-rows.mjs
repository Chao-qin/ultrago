/**
 * 一次性清理：删除 _prisma_migrations 里指向已归档目录的 6 条记录。
 *
 * 这 6 条的 applied_steps_count 都是 0 —— 它们是被 `migrate resolve --applied` 标记的，
 * 从未真正执行过任何 SQL（表由 db push 建立）。删除它们不会丢任何 schema 变更，只是把
 * 记录表和已经归档的目录对齐。
 *
 * 白名单式删除：只删下面这 6 个确切的名字，不用通配、不按时间范围。
 *
 * 用法（在 packages/console 目录下）：
 *   DATABASE_URL="file:/home/project/agentchrome/resource/db/console.db" \
 *     node /tmp/.../cleanup-migration-rows.mjs [--apply]
 *
 * 不带 --apply 只打印将要删除的内容，不写库。
 */
import { PrismaClient } from "@prisma/client";

const ARCHIVED = [
  "20260823000000_book_deliveries_db_output",
  "20260823000001_typed_outputs",
  "20260823000002_delivery_reliability",
  "20260823000003_schedule_delivery_overrides",
  "20260823000004_delivery_reliability_indexes",
  "20260826000000_book_output_contract",
];

const apply = process.argv.includes("--apply");
const prisma = new PrismaClient();

const before = await prisma.$queryRawUnsafe(
  `SELECT migration_name, applied_steps_count FROM _prisma_migrations ORDER BY started_at`,
);
console.log("当前 _prisma_migrations:");
console.table(before.map((r) => ({
  migration: r.migration_name,
  steps: String(r.applied_steps_count),
  将删除: ARCHIVED.includes(r.migration_name) ? "是" : "",
})));

const targets = before.filter((r) => ARCHIVED.includes(r.migration_name));

// steps > 0 表示这条 migration 真的执行过 SQL（其余是被 resolve 标记的空记录）。
// 这本身不构成危险——危险的是「它的效果没被 0_init 包含」。0_init 由
// `migrate diff --from-empty --to-schema-datamodel` 生成，且验证过
// `migrate diff --from-url <实际库>` 输出 "This is an empty migration."，
// 即 0_init 与数据库真实结构一致，已经包含了这些变更的全部效果。
// 归档目录里的 migration.sql 也原样保留，SQL 内容不会丢。
// 丢的只是「何时、以几步执行」这条审计记录。
const executed = targets.filter((r) => Number(r.applied_steps_count) > 0);
if (executed.length) {
  console.log(`\n注意：${executed.length} 条待删记录真的执行过 SQL：`);
  console.log(executed.map((r) => `  ${r.migration_name} steps=${r.applied_steps_count}`).join("\n"));
  console.log("  它们的效果已包含在 0_init 中（已用 migrate diff 验证），SQL 原文保留在");
  console.log("  prisma/migrations-archive/ 下；删除只丢失执行时间这条审计信息。");
}

if (!apply) {
  console.log(`\n(dry-run) 将删除 ${targets.length} 条，未写库。加 --apply 真正执行。`);
  await prisma.$disconnect();
  process.exit(0);
}

const placeholders = ARCHIVED.map(() => "?").join(",");
const deleted = await prisma.$executeRawUnsafe(
  `DELETE FROM _prisma_migrations WHERE migration_name IN (${placeholders})`,
  ...ARCHIVED,
);
console.log(`\n已删除 ${deleted} 条`);

const after = await prisma.$queryRawUnsafe(
  `SELECT migration_name, applied_steps_count FROM _prisma_migrations ORDER BY started_at`,
);
console.log("清理后:");
console.table(after.map((r) => ({ migration: r.migration_name, steps: String(r.applied_steps_count) })));
await prisma.$disconnect();
