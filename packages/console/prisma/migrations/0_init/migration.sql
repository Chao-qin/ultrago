-- Baseline —— 不是增量迁移，是「从空库建出当前完整结构」的单一起点。
--
-- 2026-08-27 重建。此前的迁移历史无法从零重放：名为 0_init 的那份其实是 6 个
-- 增量迁移的合并产物，开头就对 Run 表做 ALTER、中间又从 Schedule 表搬数据，
-- 而 Run / Book / StepRun / DeliveryRun / OutputRecord / Artifact / CronLease 七张表
-- 从未被任何迁移创建过（库当初是 `prisma db push` 建的，迁移只记了增量）。
-- 结果是 `prisma migrate deploy` 在新机器上第一条语句就报 no such table: Run。
--
-- 本文件由 `prisma migrate diff --from-empty --to-schema-datamodel` 生成，并与当时的
-- 真实库交叉核对通过（`migrate diff --from-url <真实库> --to-schema-datamodel` 输出
-- 为空，即二者在 Prisma 眼中完全等价）。
--
-- 往后照常用 `pnpm prisma:migrate` 生成增量迁移，不要再手写目录名与时间戳。

-- CreateTable
CREATE TABLE "Book" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "goal" TEXT NOT NULL,
    "goalDetail" TEXT,
    "filePath" TEXT NOT NULL,
    "fileMtime" DATETIME NOT NULL,
    "fileHash" TEXT NOT NULL,
    "playbookJson" TEXT,
    "paramSchema" TEXT NOT NULL,
    "outputSchema" TEXT,
    "deliveriesJson" TEXT NOT NULL DEFAULT '[]',
    "stepsCount" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "tags" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "targetType" TEXT NOT NULL DEFAULT 'book',
    "bookId" TEXT,
    "flowId" TEXT,
    "targetKey" TEXT NOT NULL DEFAULT '',
    "cronExpr" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "mode" TEXT NOT NULL DEFAULT 'auto',
    "paramsJson" TEXT NOT NULL DEFAULT '{}',
    "deliveryOverridesJson" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastFiredAt" DATETIME,
    "lastFiredRunId" TEXT,
    "lastFiredStatus" TEXT,
    "totalFired" INTEGER NOT NULL DEFAULT 0,
    "totalSuccess" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Schedule_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Schedule_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Schedule_lastFiredRunId_fkey" FOREIGN KEY ("lastFiredRunId") REFERENCES "Run" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Run" (
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
    CONSTRAINT "Run_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Run_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StepRun" (
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
    CONSTRAINT "StepRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeliveryRun" (
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
    "finishedAt" DATETIME,
    CONSTRAINT "DeliveryRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OutputRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "table" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "bookName" TEXT NOT NULL,
    "outputData" TEXT NOT NULL,
    "outputType" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "paramsJson" TEXT NOT NULL,
    "paramsTypeJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "runId" TEXT NOT NULL,
    CONSTRAINT "OutputRecord_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Artifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CronLease" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "holder" TEXT NOT NULL,
    "acquiredAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Schema" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "kind" TEXT NOT NULL,
    "entity" TEXT,
    "title" TEXT,
    "description" TEXT,
    "jsonSchema" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "upstreamRef" TEXT,
    "derivesFrom" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Flow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "graphJson" TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
    "inputSchema" TEXT NOT NULL DEFAULT '[]',
    "outputSchema" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "tags" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FlowRun" (
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
    "dedupeKey" TEXT,
    CONSTRAINT "FlowRun_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FlowNodeRun" (
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
    CONSTRAINT "FlowNodeRun_flowRunId_fkey" FOREIGN KEY ("flowRunId") REFERENCES "FlowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SchemaRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "schemaName" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "data" TEXT NOT NULL,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Book_name_key" ON "Book"("name");

-- CreateIndex
CREATE INDEX "Book_enabled_idx" ON "Book"("enabled");

-- CreateIndex
CREATE INDEX "Schedule_enabled_idx" ON "Schedule"("enabled");

-- CreateIndex
CREATE INDEX "Schedule_bookId_idx" ON "Schedule"("bookId");

-- CreateIndex
CREATE INDEX "Schedule_flowId_idx" ON "Schedule"("flowId");

-- CreateIndex
CREATE UNIQUE INDEX "Schedule_targetKey_cronExpr_paramsJson_key" ON "Schedule"("targetKey", "cronExpr", "paramsJson");

-- CreateIndex
CREATE INDEX "Run_bookId_queuedAt_idx" ON "Run"("bookId", "queuedAt");

-- CreateIndex
CREATE INDEX "Run_status_idx" ON "Run"("status");

-- CreateIndex
CREATE INDEX "Run_flowNodeRunId_idx" ON "Run"("flowNodeRunId");

-- CreateIndex
CREATE INDEX "Run_startNextAttemptAt_idx" ON "Run"("startNextAttemptAt");

-- CreateIndex
CREATE INDEX "Run_startClaimUntil_idx" ON "Run"("startClaimUntil");

-- CreateIndex
CREATE INDEX "Run_scheduleId_idx" ON "Run"("scheduleId");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_book_active_dedupe" ON "Run"("bookId", "dedupeKey");

-- CreateIndex
CREATE INDEX "StepRun_runId_stepIndex_idx" ON "StepRun"("runId", "stepIndex");

-- CreateIndex
CREATE INDEX "DeliveryRun_status_idx" ON "DeliveryRun"("status");

-- CreateIndex
CREATE INDEX "DeliveryRun_status_nextAttemptAt_idx" ON "DeliveryRun"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "DeliveryRun_nextAttemptAt_idx" ON "DeliveryRun"("nextAttemptAt");

-- CreateIndex
CREATE INDEX "DeliveryRun_claimUntil_idx" ON "DeliveryRun"("claimUntil");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryRun_runId_deliveryIndex_key" ON "DeliveryRun"("runId", "deliveryIndex");

-- CreateIndex
CREATE INDEX "OutputRecord_table_idx" ON "OutputRecord"("table");

-- CreateIndex
CREATE INDEX "OutputRecord_runId_idx" ON "OutputRecord"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "OutputRecord_table_planId_key" ON "OutputRecord"("table", "planId");

-- CreateIndex
CREATE INDEX "Artifact_runId_idx" ON "Artifact"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "Artifact_runId_path_key" ON "Artifact"("runId", "path");

-- CreateIndex
CREATE INDEX "Schema_kind_idx" ON "Schema"("kind");

-- CreateIndex
CREATE INDEX "Schema_entity_idx" ON "Schema"("entity");

-- CreateIndex
CREATE INDEX "Schema_active_idx" ON "Schema"("active");

-- CreateIndex
CREATE UNIQUE INDEX "Schema_name_version_key" ON "Schema"("name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Flow_name_key" ON "Flow"("name");

-- CreateIndex
CREATE INDEX "Flow_enabled_idx" ON "Flow"("enabled");

-- CreateIndex
CREATE INDEX "FlowRun_status_idx" ON "FlowRun"("status");

-- CreateIndex
CREATE INDEX "FlowRun_flowId_queuedAt_idx" ON "FlowRun"("flowId", "queuedAt");

-- CreateIndex
CREATE INDEX "FlowRun_parentFlowRunId_idx" ON "FlowRun"("parentFlowRunId");

-- CreateIndex
CREATE UNIQUE INDEX "FlowRun_flowId_dedupeKey_key" ON "FlowRun"("flowId", "dedupeKey");

-- CreateIndex
CREATE INDEX "FlowNodeRun_flowRunId_status_idx" ON "FlowNodeRun"("flowRunId", "status");

-- CreateIndex
CREATE INDEX "FlowNodeRun_runId_idx" ON "FlowNodeRun"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "FlowNodeRun_flowRunId_nodeId_iteration_key" ON "FlowNodeRun"("flowRunId", "nodeId", "iteration");

-- CreateIndex
CREATE INDEX "SchemaRecord_schemaName_idx" ON "SchemaRecord"("schemaName");

-- CreateIndex
CREATE INDEX "SchemaRecord_schemaName_schemaVersion_idx" ON "SchemaRecord"("schemaName", "schemaVersion");

-- CreateIndex
CREATE INDEX "SchemaRecord_deletedAt_idx" ON "SchemaRecord"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SchemaRecord_schemaName_schemaVersion_id_key" ON "SchemaRecord"("schemaName", "schemaVersion", "id");

