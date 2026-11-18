-- 去掉资源槽：Flow.slotsJson 与 FlowNodeRun.slot
--
-- 这两列支撑的是节点级「并行/串行」开关，该开关已被移除。它在任何真实场景里都
-- 不生效：book 因为浏览器独占永远排队，transform/flowInput/flowOutput 是同步
-- 计算本就瞬时，唯一能真并行的多脚本场景在数据依赖成链的管道里不会出现。留着
-- 两列死数据只会让后来的人以为这里还有一套调度策略。
--
-- 现在的规则更简单也更诚实：一条 flow run 同时至多一个「会做事」的节点在跑。
--
-- SQLite 无法直接 DROP COLUMN，Prisma 因此重建两张表。Flow 与 FlowNodeRun
-- 的既有行会被原样搬过去（下面的 INSERT ... SELECT 列全）。

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Flow" (
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
INSERT INTO "new_Flow" ("createdAt", "description", "enabled", "graphJson", "id", "inputSchema", "name", "outputSchema", "tags", "updatedAt") SELECT "createdAt", "description", "enabled", "graphJson", "id", "inputSchema", "name", "outputSchema", "tags", "updatedAt" FROM "Flow";
DROP TABLE "Flow";
ALTER TABLE "new_Flow" RENAME TO "Flow";
CREATE UNIQUE INDEX "Flow_name_key" ON "Flow"("name");
CREATE INDEX "Flow_enabled_idx" ON "Flow"("enabled");
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
    CONSTRAINT "FlowNodeRun_flowRunId_fkey" FOREIGN KEY ("flowRunId") REFERENCES "FlowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_FlowNodeRun" ("childFlowRunId", "durationMs", "errorMessage", "finishedAt", "flowRunId", "id", "inputJson", "iteration", "nodeId", "nodeType", "outputJson", "runId", "startedAt", "status") SELECT "childFlowRunId", "durationMs", "errorMessage", "finishedAt", "flowRunId", "id", "inputJson", "iteration", "nodeId", "nodeType", "outputJson", "runId", "startedAt", "status" FROM "FlowNodeRun";
DROP TABLE "FlowNodeRun";
ALTER TABLE "new_FlowNodeRun" RENAME TO "FlowNodeRun";
CREATE INDEX "FlowNodeRun_flowRunId_status_idx" ON "FlowNodeRun"("flowRunId", "status");
CREATE INDEX "FlowNodeRun_runId_idx" ON "FlowNodeRun"("runId");
CREATE UNIQUE INDEX "FlowNodeRun_flowRunId_nodeId_iteration_key" ON "FlowNodeRun"("flowRunId", "nodeId", "iteration");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

