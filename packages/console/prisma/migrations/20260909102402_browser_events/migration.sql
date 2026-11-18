-- CreateTable
CREATE TABLE "BrowserEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "browser" TEXT,
    "tabId" INTEGER NOT NULL,
    "occurredAt" DATETIME NOT NULL,
    "seq" INTEGER,
    "summary" TEXT NOT NULL,
    "detail" TEXT,
    "screenshotName" TEXT,
    "screenshotUrl" TEXT,
    "acknowledgedAt" DATETIME,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "BrowserEvent_kind_idx" ON "BrowserEvent"("kind");

-- CreateIndex
CREATE INDEX "BrowserEvent_browser_idx" ON "BrowserEvent"("browser");

-- CreateIndex
CREATE INDEX "BrowserEvent_receivedAt_idx" ON "BrowserEvent"("receivedAt");

-- CreateIndex
CREATE INDEX "BrowserEvent_acknowledgedAt_idx" ON "BrowserEvent"("acknowledgedAt");

-- CreateIndex
CREATE INDEX "BrowserEvent_deletedAt_idx" ON "BrowserEvent"("deletedAt");
