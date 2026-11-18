-- CreateTable
CREATE TABLE "Script" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "language" TEXT NOT NULL DEFAULT 'javascript',
    "source" TEXT NOT NULL DEFAULT '',
    "inputSchema" TEXT NOT NULL DEFAULT 'null',
    "outputSchema" TEXT NOT NULL DEFAULT 'null',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT,
    "flowId" TEXT,
    "scriptId" TEXT,
    "targetType" TEXT NOT NULL DEFAULT 'book',
    "targetKey" TEXT NOT NULL DEFAULT '',
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
    CONSTRAINT "Run_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Run_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "Script" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Run_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Run" ("attempt", "bookId", "createdAt", "dedupeKey", "deletedAt", "deliveryOverridesJson", "deliverySnapshotJson", "durationMs", "errorMessage", "failedStep", "finishedAt", "flowNodeRunId", "id", "mode", "paramSchemaRef", "paramsJson", "parentRunId", "planId", "queuedAt", "ranSteps", "scheduleId", "startAttempts", "startClaimToken", "startClaimUntil", "startNextAttemptAt", "startedAt", "status", "terminalIngestedAt", "totalSteps", "trigger", "updatedAt") SELECT "attempt", "bookId", "createdAt", "dedupeKey", "deletedAt", "deliveryOverridesJson", "deliverySnapshotJson", "durationMs", "errorMessage", "failedStep", "finishedAt", "flowNodeRunId", "id", "mode", "paramSchemaRef", "paramsJson", "parentRunId", "planId", "queuedAt", "ranSteps", "scheduleId", "startAttempts", "startClaimToken", "startClaimUntil", "startNextAttemptAt", "startedAt", "status", "terminalIngestedAt", "totalSteps", "trigger", "updatedAt" FROM "Run";
DROP TABLE "Run";
ALTER TABLE "new_Run" RENAME TO "Run";
CREATE INDEX "Run_bookId_queuedAt_idx" ON "Run"("bookId", "queuedAt");
CREATE INDEX "Run_targetType_queuedAt_idx" ON "Run"("targetType", "queuedAt");
CREATE INDEX "Run_flowId_idx" ON "Run"("flowId");
CREATE INDEX "Run_scriptId_idx" ON "Run"("scriptId");
CREATE INDEX "Run_status_idx" ON "Run"("status");
CREATE INDEX "Run_flowNodeRunId_idx" ON "Run"("flowNodeRunId");
CREATE INDEX "Run_startNextAttemptAt_idx" ON "Run"("startNextAttemptAt");
CREATE INDEX "Run_startClaimUntil_idx" ON "Run"("startClaimUntil");
CREATE INDEX "Run_scheduleId_idx" ON "Run"("scheduleId");
CREATE INDEX "Run_deletedAt_idx" ON "Run"("deletedAt");
CREATE UNIQUE INDEX "uniq_book_active_dedupe" ON "Run"("bookId", "dedupeKey");
CREATE TABLE "new_Schedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "targetType" TEXT NOT NULL DEFAULT 'book',
    "bookId" TEXT,
    "flowId" TEXT,
    "scriptId" TEXT,
    "timeoutMs" INTEGER,
    "targetKey" TEXT NOT NULL DEFAULT '',
    "cronExpr" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "mode" TEXT NOT NULL DEFAULT 'auto',
    "paramsJson" TEXT NOT NULL DEFAULT '{}',
    "deliveryOverridesJson" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "lastFiredAt" DATETIME,
    "lastFiredRunId" TEXT,
    "lastFiredStatus" TEXT,
    "totalFired" INTEGER NOT NULL DEFAULT 0,
    "totalSuccess" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Schedule_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Schedule_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Schedule_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "Script" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Schedule_lastFiredRunId_fkey" FOREIGN KEY ("lastFiredRunId") REFERENCES "Run" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Schedule" ("bookId", "createdAt", "cronExpr", "deletedAt", "deliveryOverridesJson", "description", "enabled", "flowId", "id", "lastFiredAt", "lastFiredRunId", "lastFiredStatus", "mode", "name", "paramsJson", "targetKey", "targetType", "timezone", "totalFired", "totalSuccess", "updatedAt") SELECT "bookId", "createdAt", "cronExpr", "deletedAt", "deliveryOverridesJson", "description", "enabled", "flowId", "id", "lastFiredAt", "lastFiredRunId", "lastFiredStatus", "mode", "name", "paramsJson", "targetKey", "targetType", "timezone", "totalFired", "totalSuccess", "updatedAt" FROM "Schedule";
DROP TABLE "Schedule";
ALTER TABLE "new_Schedule" RENAME TO "Schedule";
CREATE INDEX "Schedule_enabled_idx" ON "Schedule"("enabled");
CREATE INDEX "Schedule_bookId_idx" ON "Schedule"("bookId");
CREATE INDEX "Schedule_flowId_idx" ON "Schedule"("flowId");
CREATE INDEX "Schedule_scriptId_idx" ON "Schedule"("scriptId");
CREATE INDEX "Schedule_deletedAt_idx" ON "Schedule"("deletedAt");
CREATE UNIQUE INDEX "Schedule_targetKey_cronExpr_paramsJson_key" ON "Schedule"("targetKey", "cronExpr", "paramsJson");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Script_deletedAt_idx" ON "Script"("deletedAt");

-- CreateIndex
CREATE INDEX "Script_updatedAt_idx" ON "Script"("updatedAt");
