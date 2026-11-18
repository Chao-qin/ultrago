ALTER TABLE "Book" ADD COLUMN "deliveriesJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Run" ADD COLUMN "deliveryOverridesJson" TEXT;

CREATE TABLE "OutputRecord" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "table" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "bookName" TEXT NOT NULL,
  "outputJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "runId" TEXT NOT NULL,
  CONSTRAINT "OutputRecord_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OutputRecord_table_planId_key" ON "OutputRecord"("table", "planId");
CREATE INDEX "OutputRecord_table_idx" ON "OutputRecord"("table");
CREATE INDEX "OutputRecord_runId_idx" ON "OutputRecord"("runId");
