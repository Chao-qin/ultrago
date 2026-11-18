-- Flow orchestrator: Flow / FlowRun / FlowNodeRun, plus the two columns the
-- existing tables need to point at them.
--
-- The Schedule rebuild is the only part that touches existing data. Prisma's
-- generated copy statement leaves the new `targetKey` on its '' default, which
-- would be both wrong (a book schedule whose key names no book) and unsafe (the
-- unique index below is on targetKey+cron+params, so two schedules sharing a
-- cron and params across DIFFERENT books would collide on '' and abort the
-- migration). The copy below computes it instead. On a database with no
-- schedules yet this changes nothing; on one with rows it is the difference
-- between a migration that works and one that fails halfway.

-- AlterTable
ALTER TABLE "Run" ADD COLUMN "flowNodeRunId" TEXT;

-- CreateTable
CREATE TABLE "Flow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "graphJson" TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
    "inputSchema" TEXT NOT NULL DEFAULT '[]',
    "outputSchema" TEXT,
    "slotsJson" TEXT NOT NULL DEFAULT '{}',
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
    "slot" TEXT,
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

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Schedule" (
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
INSERT INTO "new_Schedule" ("bookId", "createdAt", "cronExpr", "deliveryOverridesJson", "description", "enabled", "id", "lastFiredAt", "lastFiredRunId", "lastFiredStatus", "mode", "name", "paramsJson", "timezone", "totalFired", "totalSuccess", "updatedAt", "targetType", "targetKey") SELECT "bookId", "createdAt", "cronExpr", "deliveryOverridesJson", "description", "enabled", "id", "lastFiredAt", "lastFiredRunId", "lastFiredStatus", "mode", "name", "paramsJson", "timezone", "totalFired", "totalSuccess", "updatedAt", 'book', 'book:' || "bookId" FROM "Schedule";
DROP TABLE "Schedule";
ALTER TABLE "new_Schedule" RENAME TO "Schedule";
CREATE INDEX "Schedule_enabled_idx" ON "Schedule"("enabled");
CREATE INDEX "Schedule_bookId_idx" ON "Schedule"("bookId");
CREATE INDEX "Schedule_flowId_idx" ON "Schedule"("flowId");
CREATE UNIQUE INDEX "Schedule_targetKey_cronExpr_paramsJson_key" ON "Schedule"("targetKey", "cronExpr", "paramsJson");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

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
CREATE INDEX "Run_flowNodeRunId_idx" ON "Run"("flowNodeRunId");

