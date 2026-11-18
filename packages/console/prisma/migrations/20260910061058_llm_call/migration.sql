-- CreateTable
CREATE TABLE "LlmCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channel" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "stream" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "errorKind" TEXT,
    "errorMessage" TEXT,
    "latencyMs" INTEGER,
    "ttfbMs" INTEGER,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "requestPreview" TEXT,
    "responsePreview" TEXT,
    "startedAt" DATETIME NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "LlmCall_channel_idx" ON "LlmCall"("channel");

-- CreateIndex
CREATE INDEX "LlmCall_adapter_idx" ON "LlmCall"("adapter");

-- CreateIndex
CREATE INDEX "LlmCall_status_idx" ON "LlmCall"("status");

-- CreateIndex
CREATE INDEX "LlmCall_receivedAt_idx" ON "LlmCall"("receivedAt");

-- CreateIndex
CREATE INDEX "LlmCall_deletedAt_idx" ON "LlmCall"("deletedAt");
