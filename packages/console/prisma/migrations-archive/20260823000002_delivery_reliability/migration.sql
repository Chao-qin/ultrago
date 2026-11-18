ALTER TABLE "Run" ADD COLUMN "startAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Run" ADD COLUMN "startNextAttemptAt" DATETIME;
ALTER TABLE "Run" ADD COLUMN "startClaimToken" TEXT;
ALTER TABLE "Run" ADD COLUMN "startClaimUntil" DATETIME;
ALTER TABLE "Run" ADD COLUMN "deliverySnapshotJson" TEXT;
ALTER TABLE "Run" ADD COLUMN "terminalIngestedAt" DATETIME;

ALTER TABLE "DeliveryRun" ADD COLUMN "claimToken" TEXT;
ALTER TABLE "DeliveryRun" ADD COLUMN "claimUntil" DATETIME;
ALTER TABLE "DeliveryRun" ADD COLUMN "nextAttemptAt" DATETIME;
ALTER TABLE "DeliveryRun" ADD COLUMN "lastError" TEXT;
ALTER TABLE "DeliveryRun" ADD COLUMN "deadLettered" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "DeliveryRun_nextAttemptAt_idx" ON "DeliveryRun"("nextAttemptAt");
CREATE INDEX "DeliveryRun_claimUntil_idx" ON "DeliveryRun"("claimUntil");
CREATE UNIQUE INDEX "Artifact_runId_path_key" ON "Artifact"("runId", "path");
