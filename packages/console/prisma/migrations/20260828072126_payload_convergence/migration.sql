/*
  Warnings:

  - Added the required column `updatedAt` to the `Artifact` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `CronLease` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `DeliveryRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `FlowNodeRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `FlowRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Run` table without a default value. This is not possible if the table is not empty.
  - Added the required column `bytes` to the `SchemaRecord` table without a default value. This is not possible if the table is not empty.
  - Added the required column `contentType` to the `SchemaRecord` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `StepRun` table without a default value. This is not possible if the table is not empty.

  ── 上面这些警告已在本文件中手工消解，不要因为看到它们就以为迁移会失败 ────────

  Prisma 对 SQLite 改列本来就走 "new table + INSERT SELECT + rename"。新增的
  NOT NULL 无默认值列（updatedAt / SchemaRecord.contentType / SchemaRecord.bytes）
  之所以"不可执行"，只是因为生成器不知道该给存量行填什么 —— 值补进那几条
  INSERT SELECT 即可，下面每一处都补了。

  时间戳回填规则（统一，逐表照此执行）：
    createdAt ← 该行已有的最早时间戳；updatedAt ← 该行已有的最晚时间戳；
    两者都没有时退回 `strftime('%s','now') * 1000`（整数毫秒）。
  用整数毫秒而不是 CURRENT_TIMESTAMP，是为了和 Prisma client 自己写入的
  DATETIME 表示保持一致（实测存量行 typeof(createdAt) = 'integer'）。

  本文件中 Prisma 生成不了、必须由人维护的三处（改这张表时别丢）：
    1. new_SchemaRecord 的 CHECK：data / url 二选一互斥；
    2. uniq_active_record_source：带 WHERE 的部分唯一索引（幂等键）；
    3. SchemaRecord 存量行的 contentType / bytes 取值，见该处行内注释。

*/
-- AlterTable
ALTER TABLE "Book" ADD COLUMN "deletedAt" DATETIME;
-- 契约引用：指向 Schema 注册表的 "name@version"，真相源是 playbook 文件里的同名字段。
-- 两列都可空 —— 未收敛的 book 继续走内联的 paramSchema / outputSchema。
ALTER TABLE "Book" ADD COLUMN "paramSchemaRef" TEXT;
ALTER TABLE "Book" ADD COLUMN "outputSchemaRef" TEXT;

-- AlterTable
ALTER TABLE "Flow" ADD COLUMN "deletedAt" DATETIME;

-- AlterTable
ALTER TABLE "OutputRecord" ADD COLUMN "deletedAt" DATETIME;

-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN "deletedAt" DATETIME;

-- AlterTable
ALTER TABLE "Schema" ADD COLUMN "deletedAt" DATETIME;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Artifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Artifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- 手写回填：updatedAt ← createdAt（这些行从未被更新过）。
INSERT INTO "new_Artifact" ("createdAt", "id", "kind", "mimeType", "path", "runId", "size", "updatedAt")
SELECT "createdAt", "id", "kind", "mimeType", "path", "runId", "size", "createdAt" FROM "Artifact";
DROP TABLE "Artifact";
ALTER TABLE "new_Artifact" RENAME TO "Artifact";
CREATE INDEX "Artifact_runId_idx" ON "Artifact"("runId");
CREATE INDEX "Artifact_deletedAt_idx" ON "Artifact"("deletedAt");
CREATE UNIQUE INDEX "Artifact_runId_path_key" ON "Artifact"("runId", "path");
CREATE TABLE "new_CronLease" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "holder" TEXT NOT NULL,
    "acquiredAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
    -- 无 deletedAt：本表是单行分布式锁，逻辑删除对它没有语义（软删后那行仍占着
    -- id="singleton"，既释放不了锁也表达不了锁状态），且会引诱后来者在 acquire 里
    -- 加 WHERE deletedAt IS NULL，造出"锁被软删后永远无人能获取"的死锁。
    -- 全表逻辑删除的唯一例外，project maintainer 2026-08-28 决定。
);
-- 手写回填：这张表原本一个审计时间戳都没有，acquiredAt 是唯一可信的"这行上次
-- 被写入"的时刻，createdAt / updatedAt 都取它。
INSERT INTO "new_CronLease" ("acquiredAt", "expiresAt", "holder", "id", "createdAt", "updatedAt")
SELECT "acquiredAt", "expiresAt", "holder", "id", "acquiredAt", "acquiredAt" FROM "CronLease";
DROP TABLE "CronLease";
ALTER TABLE "new_CronLease" RENAME TO "CronLease";
CREATE TABLE "new_DeliveryRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "deliveryIndex" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "on" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "detail" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimToken" TEXT,
    "claimUntil" DATETIME,
    "nextAttemptAt" DATETIME,
    "lastError" TEXT,
    "deadLettered" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "DeliveryRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- 手写回填：updatedAt ← 最晚的已知时间戳（投递完成时刻，未完成则退回创建时刻）。
INSERT INTO "new_DeliveryRun" ("attempts", "claimToken", "claimUntil", "createdAt", "deadLettered", "deliveryIndex", "detail", "finishedAt", "id", "idempotencyKey", "kind", "lastError", "nextAttemptAt", "on", "payloadJson", "runId", "status", "updatedAt")
SELECT "attempts", "claimToken", "claimUntil", "createdAt", "deadLettered", "deliveryIndex", "detail", "finishedAt", "id", "idempotencyKey", "kind", "lastError", "nextAttemptAt", "on", "payloadJson", "runId", "status",
       COALESCE("finishedAt", "createdAt") FROM "DeliveryRun";
DROP TABLE "DeliveryRun";
ALTER TABLE "new_DeliveryRun" RENAME TO "DeliveryRun";
CREATE INDEX "DeliveryRun_status_idx" ON "DeliveryRun"("status");
CREATE INDEX "DeliveryRun_status_nextAttemptAt_idx" ON "DeliveryRun"("status", "nextAttemptAt");
CREATE INDEX "DeliveryRun_nextAttemptAt_idx" ON "DeliveryRun"("nextAttemptAt");
CREATE INDEX "DeliveryRun_claimUntil_idx" ON "DeliveryRun"("claimUntil");
CREATE INDEX "DeliveryRun_deletedAt_idx" ON "DeliveryRun"("deletedAt");
CREATE UNIQUE INDEX "DeliveryRun_runId_deliveryIndex_key" ON "DeliveryRun"("runId", "deliveryIndex");
CREATE TABLE "new_FlowNodeRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "flowRunId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "nodeType" TEXT NOT NULL,
    "iteration" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "runId" TEXT,
    "childFlowRunId" TEXT,
    "inputJson" TEXT,
    "outputJson" TEXT,
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "FlowNodeRun_flowRunId_fkey" FOREIGN KEY ("flowRunId") REFERENCES "FlowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- 手写回填：本表无既有审计列，用节点自身的起止时刻；两者都为 NULL（pending 节点）
-- 时退回当前整数毫秒。当前库里 FlowNodeRun 为 0 行，补这段是为了让本迁移在任何
-- 有数据的环境上都能照跑，而不是只在这一台机器上成立。
INSERT INTO "new_FlowNodeRun" ("childFlowRunId", "durationMs", "errorMessage", "finishedAt", "flowRunId", "id", "inputJson", "iteration", "nodeId", "nodeType", "outputJson", "runId", "startedAt", "status", "createdAt", "updatedAt")
SELECT "childFlowRunId", "durationMs", "errorMessage", "finishedAt", "flowRunId", "id", "inputJson", "iteration", "nodeId", "nodeType", "outputJson", "runId", "startedAt", "status",
       COALESCE("startedAt", "finishedAt", CAST(strftime('%s','now') AS INTEGER) * 1000),
       COALESCE("finishedAt", "startedAt", CAST(strftime('%s','now') AS INTEGER) * 1000) FROM "FlowNodeRun";
DROP TABLE "FlowNodeRun";
ALTER TABLE "new_FlowNodeRun" RENAME TO "FlowNodeRun";
CREATE INDEX "FlowNodeRun_flowRunId_status_idx" ON "FlowNodeRun"("flowRunId", "status");
CREATE INDEX "FlowNodeRun_runId_idx" ON "FlowNodeRun"("runId");
CREATE INDEX "FlowNodeRun_deletedAt_idx" ON "FlowNodeRun"("deletedAt");
CREATE UNIQUE INDEX "FlowNodeRun_flowRunId_nodeId_iteration_key" ON "FlowNodeRun"("flowRunId", "nodeId", "iteration");
CREATE TABLE "new_FlowRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "flowId" TEXT NOT NULL,
    "graphSnapshot" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'auto',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paramsJson" TEXT NOT NULL DEFAULT '{}',
    "outputsJson" TEXT,
    "errorMessage" TEXT,
    "failedNodeId" TEXT,
    "scheduleId" TEXT,
    "parentFlowRunId" TEXT,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "dedupeKey" TEXT,
    CONSTRAINT "FlowRun_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- 手写回填：createdAt ← queuedAt（现有数据里能拿到的最早时刻），
-- updatedAt ← 最晚的已知时刻。注意 queuedAt 会被 retry/resume 重写，所以这只是
-- 存量行的最佳近似，不是真正的出生时间；新行之后由 @default(now()) 记准。
INSERT INTO "new_FlowRun" ("dedupeKey", "durationMs", "errorMessage", "failedNodeId", "finishedAt", "flowId", "graphSnapshot", "id", "mode", "outputsJson", "paramsJson", "parentFlowRunId", "queuedAt", "scheduleId", "startedAt", "status", "trigger", "createdAt", "updatedAt")
SELECT "dedupeKey", "durationMs", "errorMessage", "failedNodeId", "finishedAt", "flowId", "graphSnapshot", "id", "mode", "outputsJson", "paramsJson", "parentFlowRunId", "queuedAt", "scheduleId", "startedAt", "status", "trigger",
       "queuedAt",
       COALESCE("finishedAt", "startedAt", "queuedAt") FROM "FlowRun";
DROP TABLE "FlowRun";
ALTER TABLE "new_FlowRun" RENAME TO "FlowRun";
CREATE INDEX "FlowRun_status_idx" ON "FlowRun"("status");
CREATE INDEX "FlowRun_flowId_queuedAt_idx" ON "FlowRun"("flowId", "queuedAt");
CREATE INDEX "FlowRun_parentFlowRunId_idx" ON "FlowRun"("parentFlowRunId");
CREATE INDEX "FlowRun_deletedAt_idx" ON "FlowRun"("deletedAt");
CREATE UNIQUE INDEX "FlowRun_flowId_dedupeKey_key" ON "FlowRun"("flowId", "dedupeKey");
CREATE TABLE "new_Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startAttempts" INTEGER NOT NULL DEFAULT 0,
    "startNextAttemptAt" DATETIME,
    "startClaimToken" TEXT,
    "startClaimUntil" DATETIME,
    "planId" TEXT,
    "paramsJson" TEXT NOT NULL,
    "paramsTypeJson" TEXT NOT NULL DEFAULT '{}',
    "deliveryOverridesJson" TEXT,
    "deliverySnapshotJson" TEXT,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "failedStep" INTEGER,
    "outputsJson" TEXT,
    "outputsData" TEXT,
    "outputsType" TEXT,
    "outputsContentType" TEXT,
    "outputsSchemaErrors" TEXT,
    "terminalIngestedAt" DATETIME,
    "ranSteps" INTEGER,
    "totalSteps" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "parentRunId" TEXT,
    "dedupeKey" TEXT,
    "flowNodeRunId" TEXT,
    "scheduleId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Run_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Run_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
-- 手写回填：createdAt ← queuedAt（现有数据里能拿到的最早时刻），
-- updatedAt ← 最晚的已知时刻。queuedAt 会被 retry 重写，所以对重试过的存量行
-- 这只是近似；createdAt 从此刻起才真正"永不重写"。
INSERT INTO "new_Run" ("attempt", "bookId", "dedupeKey", "deliveryOverridesJson", "deliverySnapshotJson", "durationMs", "errorMessage", "failedStep", "finishedAt", "flowNodeRunId", "id", "mode", "outputsContentType", "outputsData", "outputsJson", "outputsSchemaErrors", "outputsType", "paramsJson", "paramsTypeJson", "parentRunId", "planId", "queuedAt", "ranSteps", "scheduleId", "startAttempts", "startClaimToken", "startClaimUntil", "startNextAttemptAt", "startedAt", "status", "terminalIngestedAt", "totalSteps", "trigger", "createdAt", "updatedAt")
SELECT "attempt", "bookId", "dedupeKey", "deliveryOverridesJson", "deliverySnapshotJson", "durationMs", "errorMessage", "failedStep", "finishedAt", "flowNodeRunId", "id", "mode", "outputsContentType", "outputsData", "outputsJson", "outputsSchemaErrors", "outputsType", "paramsJson", "paramsTypeJson", "parentRunId", "planId", "queuedAt", "ranSteps", "scheduleId", "startAttempts", "startClaimToken", "startClaimUntil", "startNextAttemptAt", "startedAt", "status", "terminalIngestedAt", "totalSteps", "trigger",
       "queuedAt",
       COALESCE("finishedAt", "startedAt", "queuedAt") FROM "Run";
DROP TABLE "Run";
ALTER TABLE "new_Run" RENAME TO "Run";
CREATE INDEX "Run_bookId_queuedAt_idx" ON "Run"("bookId", "queuedAt");
CREATE INDEX "Run_status_idx" ON "Run"("status");
CREATE INDEX "Run_flowNodeRunId_idx" ON "Run"("flowNodeRunId");
CREATE INDEX "Run_startNextAttemptAt_idx" ON "Run"("startNextAttemptAt");
CREATE INDEX "Run_startClaimUntil_idx" ON "Run"("startClaimUntil");
CREATE INDEX "Run_scheduleId_idx" ON "Run"("scheduleId");
CREATE INDEX "Run_deletedAt_idx" ON "Run"("deletedAt");
CREATE UNIQUE INDEX "uniq_book_active_dedupe" ON "Run"("bookId", "dedupeKey");
CREATE TABLE "new_SchemaRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contentType" TEXT NOT NULL,
    "schemaName" TEXT,
    "schemaVersion" INTEGER,
    "data" TEXT,
    "schemaErrors" TEXT,
    "fileName" TEXT,
    "url" TEXT,
    "bytes" INTEGER NOT NULL,
    "source" TEXT,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
    -- 手写：JSON 分支与文件分支互斥，恰好一支有值。Prisma schema 语言表达不了
    -- CHECK，SQLite 又只能在建表时加，所以它只能活在这里 —— 以后再对这张表
    -- 做 RedefineTables，必须把这行一起带过去，否则约束会静默消失。
  , CHECK ((("data" IS NULL) <> ("url" IS NULL)))
);
-- 手写：给存量行补上两个 NOT NULL 无默认值的新列。
--   contentType ← 'application/json'：旧表结构里 `data` 是 NOT NULL 且根本没有
--     文件分支，所以每一条存量行按定义都是 JSON，这是推导出来的、不是猜的。
--   bytes ← length(CAST("data" AS BLOB))：CAST 成 BLOB 才是 UTF-8 字节数；
--     直接 length("data") 返回的是字符数，中文内容下会显著偏小
--     （实测存量那行：968733 字符 / 1171535 字节）。
--   source 保持 NULL：旧表没有这一列，无从推导。NULL 的含义是"手工创建、
--     不参与幂等唯一性"，对一条来历不明的历史行是诚实的默认值 —— 不要为了
--     好看编一个 "run:xxx" 出来，那会污染 uniq_active_record_source。
INSERT INTO "new_SchemaRecord" ("createdAt", "data", "deletedAt", "id", "schemaName", "schemaVersion", "updatedAt", "contentType", "bytes")
SELECT "createdAt", "data", "deletedAt", "id", "schemaName", "schemaVersion", "updatedAt",
       'application/json',
       length(CAST("data" AS BLOB))
FROM "SchemaRecord";
DROP TABLE "SchemaRecord";
ALTER TABLE "new_SchemaRecord" RENAME TO "SchemaRecord";
CREATE INDEX "SchemaRecord_schemaName_idx" ON "SchemaRecord"("schemaName");
CREATE INDEX "SchemaRecord_contentType_idx" ON "SchemaRecord"("contentType");
CREATE INDEX "SchemaRecord_source_idx" ON "SchemaRecord"("source");
CREATE INDEX "SchemaRecord_deletedAt_idx" ON "SchemaRecord"("deletedAt");
-- 手写：幂等键。只对"有可重现 source 且未软删"的行生效。
-- source IS NULL（手工创建）不参与唯一性；软删的行释放键位，可以重建。
CREATE UNIQUE INDEX "uniq_active_record_source"
  ON "SchemaRecord"("source")
  WHERE "source" IS NOT NULL AND "deletedAt" IS NULL;
CREATE TABLE "new_StepRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "goal" TEXT NOT NULL,
    "actionMethod" TEXT,
    "actionParams" TEXT,
    "verifySummary" TEXT,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "durationMs" INTEGER,
    "valuePreview" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "StepRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- 手写回填：本表无既有审计列，用步骤自身的起止时刻；两者都为 NULL（pending /
-- skipped 步骤）时退回当前整数毫秒。
INSERT INTO "new_StepRun" ("actionMethod", "actionParams", "durationMs", "errorMessage", "finishedAt", "goal", "id", "runId", "startedAt", "status", "stepIndex", "valuePreview", "verifySummary", "createdAt", "updatedAt")
SELECT "actionMethod", "actionParams", "durationMs", "errorMessage", "finishedAt", "goal", "id", "runId", "startedAt", "status", "stepIndex", "valuePreview", "verifySummary",
       COALESCE("startedAt", "finishedAt", CAST(strftime('%s','now') AS INTEGER) * 1000),
       COALESCE("finishedAt", "startedAt", CAST(strftime('%s','now') AS INTEGER) * 1000) FROM "StepRun";
DROP TABLE "StepRun";
ALTER TABLE "new_StepRun" RENAME TO "StepRun";
CREATE INDEX "StepRun_runId_stepIndex_idx" ON "StepRun"("runId", "stepIndex");
CREATE INDEX "StepRun_deletedAt_idx" ON "StepRun"("deletedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Book_deletedAt_idx" ON "Book"("deletedAt");

-- CreateIndex
CREATE INDEX "Flow_deletedAt_idx" ON "Flow"("deletedAt");

-- CreateIndex
CREATE INDEX "OutputRecord_deletedAt_idx" ON "OutputRecord"("deletedAt");

-- CreateIndex
CREATE INDEX "Schedule_deletedAt_idx" ON "Schedule"("deletedAt");

-- CreateIndex
CREATE INDEX "Schema_deletedAt_idx" ON "Schema"("deletedAt");
