# 归档的 migration（2026-08-26 baseline 之前）

这些 migration **不可重放**，这就是它们被归档的原因。

## 出了什么问题

`Book` / `Run` / `Schedule` / `StepRun` / `DeliveryRun` / `CronLease` 这些基础表从来没有
migration 创建过 —— 它们由 `scripts/init.sh` 的 `prisma db push` 建立，而 db push 不写
migration 文件。migration 目录是后来才开始记录的，第一个 `20260823000000` 直接
`CREATE TABLE "OutputRecord"` 并外键引用 `Run`，而 `Run` 在这段历史里从未被创建。

后果是任何走 shadow database 的命令都会失败：

```
Error: P3006
Migration `20260823000000_book_deliveries_db_output` failed to apply cleanly to the
shadow database. Error: SQLite database error: no such table: Book
```

`prisma migrate dev` 因此永久不可用，团队只能一直用 `db push`，而 db push 又不写
migration —— 这个循环会让缺口越来越大。

注意 `prisma migrate status` 在此期间一直报告 "Database schema is up to date"。它只比对
`_prisma_migrations` 表的记录与 migrations 目录，**不重放**，所以看不出历史是断的。别把它
的绿灯当作历史健康的证据。

## 怎么修的

按 Prisma 官方的 baselining / squashing 流程，用 `migrate diff --from-empty` 生成了单个
`migrations/0_init/migration.sql`，包含当前全部 9 张表，并标记为已应用。

生成后验证过 `migrate diff --from-url <实际库> --to-schema-datamodel` 输出
`-- This is an empty migration.` —— 即 0_init 反映的是数据库的真实结构，不是照着
schema.prisma 想当然写出来的。

## 这些文件还留着干什么

只作为历史参考：想知道某个字段是哪次加的、当时为什么加，这里的 SQL 和目录名仍然有用。
**不要把它们移回 `migrations/`**，那会让 shadow database 重新失败。

从 0_init 之后，正常的 `prisma migrate dev` 流程恢复可用，新的 migration 直接进
`migrations/`。
