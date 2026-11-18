/*
  Warnings（来自 `prisma migrate diff`；每一条都是本次的目的 —— 这个迁移就是
  「删除」本身，它点名的数据已经先搬走了）：

  - 删表 `Artifact`（6 行）、`OutputRecord`（0 行）
  - 删列 `DeliveryRun.payloadJson`（55 行非空）
  - 删列 `Run.outputsJson` / `outputsData` / `outputsType` / `outputsContentType`
    （各 33 行非空）与 `outputsSchemaErrors`（4 行）
  - 删列 `Run.paramsTypeJson`（105 行非空）
  - 删列 `FlowRun.outputsJson`（0 行非空）

  ── 每一项的去向，逐条 ────────────────────────────────────────────────────

  Artifact           → SchemaRecord，`source = "run:<runId>:artifact:<报告路径>"`。
                       6 行已由 scripts/migrate-payloads.mjs 搬完，字节落
                       resource/records/。file 投递的**归属校验**现在读这些行
                       （delivery-executor.ts 的 verifyFile）—— 这道闸在本库里
                       已经拦下过 9 次，不是形式主义，所以表可以删、行不能丢。
  OutputRecord       → 无可迁（0 行）。它是 `db` 投递的落地表，而 `db` 投递本身
                       一并删除：产出现在无条件落 SchemaRecord，一个只覆盖
                       「配了 db 投递的那些 run」的落地点不可能是真相源。
  Run.outputs*       → SchemaRecord，`source = "run:<runId>"`。其中 outputsType
                       = 'json' 的 4 行已迁；另 29 行 markdown/text 共 98,259 字节
                       **随本次删列丢弃**（project maintainer 决策 B：测试垃圾产出，
                       不值得进契约表）。
  FlowRun.outputsJson→ SchemaRecord，`source = "flow:<flowRunId>"`（flow-runner
                       的 finishRun 改为落地）。库里 0 行非空，无存量可迁。
  DeliveryRun.       → 不需要迁移：实测 31/31 与 `Run.deliverySnapshotJson`
    payloadJson        [deliveryIndex] 逐字节相等，而快照才是不可变的 SSOT
                       （`Book.deliveriesJson` 被 filesync 覆写，**不能**当历史
                       真相源）。另 24 行属于 snapshot 列加入之前的历史行，已全部
                       终态：21 行 attempts=5 已超重投上限、3 行 status='ok'，
                       **没有一行还会被重投递循环选中**。代码侧对导不出的行优雅
                       降级为 deadLettered 并写明原因，不抛错。
  Run.paramsTypeJson → `Run.paramSchemaRef`（本迁移新增），换算规则见下面
                       INSERT INTO "new_Run" 上方的注释。

  ⚠️ 本迁移**没有**波及 `SchemaRecord` 表 —— 下面的 RedefineTables 里没有
  `new_SchemaRecord`，被重建的只有 DeliveryRun / FlowRun / Run 三张。所以
  migration 1 手写的两处（`data`/`url` 互斥的 CHECK、带 WHERE 的部分唯一索引
  `uniq_active_record_source`）原封不动留在原表上，不需要也不应该在这里重建。
  **以后哪次迁移真的重建了这张表，必须把那两处一起带过去**，否则约束会静默消失。
*/

-- DropIndex
DROP INDEX "Artifact_runId_path_key";

-- DropIndex
DROP INDEX "Artifact_deletedAt_idx";

-- DropIndex
DROP INDEX "Artifact_runId_idx";

-- DropIndex
DROP INDEX "OutputRecord_deletedAt_idx";

-- DropIndex
DROP INDEX "OutputRecord_table_planId_key";

-- DropIndex
DROP INDEX "OutputRecord_runId_idx";

-- DropIndex
DROP INDEX "OutputRecord_table_idx";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Artifact";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "OutputRecord";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DeliveryRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "deliveryIndex" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "on" TEXT NOT NULL,
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
INSERT INTO "new_DeliveryRun" ("attempts", "claimToken", "claimUntil", "createdAt", "deadLettered", "deletedAt", "deliveryIndex", "detail", "finishedAt", "id", "idempotencyKey", "kind", "lastError", "nextAttemptAt", "on", "runId", "status", "updatedAt") SELECT "attempts", "claimToken", "claimUntil", "createdAt", "deadLettered", "deletedAt", "deliveryIndex", "detail", "finishedAt", "id", "idempotencyKey", "kind", "lastError", "nextAttemptAt", "on", "runId", "status", "updatedAt" FROM "DeliveryRun";
DROP TABLE "DeliveryRun";
ALTER TABLE "new_DeliveryRun" RENAME TO "DeliveryRun";
CREATE INDEX "DeliveryRun_status_idx" ON "DeliveryRun"("status");
CREATE INDEX "DeliveryRun_status_nextAttemptAt_idx" ON "DeliveryRun"("status", "nextAttemptAt");
CREATE INDEX "DeliveryRun_nextAttemptAt_idx" ON "DeliveryRun"("nextAttemptAt");
CREATE INDEX "DeliveryRun_claimUntil_idx" ON "DeliveryRun"("claimUntil");
CREATE INDEX "DeliveryRun_deletedAt_idx" ON "DeliveryRun"("deletedAt");
CREATE UNIQUE INDEX "DeliveryRun_runId_deliveryIndex_key" ON "DeliveryRun"("runId", "deliveryIndex");
CREATE TABLE "new_FlowRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "flowId" TEXT NOT NULL,
    "graphSnapshot" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'auto',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paramsJson" TEXT NOT NULL DEFAULT '{}',
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
INSERT INTO "new_FlowRun" ("createdAt", "dedupeKey", "deletedAt", "durationMs", "errorMessage", "failedNodeId", "finishedAt", "flowId", "graphSnapshot", "id", "mode", "paramsJson", "parentFlowRunId", "queuedAt", "scheduleId", "startedAt", "status", "trigger", "updatedAt") SELECT "createdAt", "dedupeKey", "deletedAt", "durationMs", "errorMessage", "failedNodeId", "finishedAt", "flowId", "graphSnapshot", "id", "mode", "paramsJson", "parentFlowRunId", "queuedAt", "scheduleId", "startedAt", "status", "trigger", "updatedAt" FROM "FlowRun";
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
    "paramSchemaRef" TEXT,
    "deliveryOverridesJson" TEXT,
    "deliverySnapshotJson" TEXT,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "failedStep" INTEGER,
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
-- 手写：末尾多带一列 `paramSchemaRef`，值由 `paramsTypeJson` 现场换算 —— 这是
-- 本迁移唯一一处保留旧列内容的地方，必须发生在 DROP TABLE "Run" 之前。
--
-- 换算条件只有一个：run 当初记下的 schema 快照与 book 现在的 `paramSchema`
-- 逐字节相等时，才认这本书的 `paramSchemaRef` 也适用于它。实测 105 行里 14 行
-- 满足（1688-offer-snatch 7 / 1688-random-offer-snatch 7），另 91 行
-- （baidu-hot-search 70 / doubao-ask 16 / doudian-category-tree 5）当初记的是
-- 一份**后来改过**的 schema —— 给它们贴上当前的 `@1` 等于凭空断言历史，所以
-- 一律留 NULL，含义是"这次运行的入参契约没有登记成注册表引用"。
--
-- ⚠️ 列数与表达式数必须一一对应：31 列 / 31 个表达式，末位对末位。
INSERT INTO "new_Run" ("attempt", "bookId", "createdAt", "dedupeKey", "deletedAt", "deliveryOverridesJson", "deliverySnapshotJson", "durationMs", "errorMessage", "failedStep", "finishedAt", "flowNodeRunId", "id", "mode", "paramsJson", "parentRunId", "planId", "queuedAt", "ranSteps", "scheduleId", "startAttempts", "startClaimToken", "startClaimUntil", "startNextAttemptAt", "startedAt", "status", "terminalIngestedAt", "totalSteps", "trigger", "updatedAt", "paramSchemaRef")
SELECT "attempt", "bookId", "createdAt", "dedupeKey", "deletedAt", "deliveryOverridesJson", "deliverySnapshotJson", "durationMs", "errorMessage", "failedStep", "finishedAt", "flowNodeRunId", "id", "mode", "paramsJson", "parentRunId", "planId", "queuedAt", "ranSteps", "scheduleId", "startAttempts", "startClaimToken", "startClaimUntil", "startNextAttemptAt", "startedAt", "status", "terminalIngestedAt", "totalSteps", "trigger", "updatedAt",
       (SELECT CASE WHEN b."paramSchema" = "Run"."paramsTypeJson" THEN b."paramSchemaRef" END
          FROM "Book" b WHERE b."id" = "Run"."bookId")
FROM "Run";
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
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
