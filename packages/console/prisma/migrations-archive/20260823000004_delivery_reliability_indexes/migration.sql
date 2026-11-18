CREATE INDEX "Run_startNextAttemptAt_idx" ON "Run"("startNextAttemptAt");
CREATE INDEX "Run_startClaimUntil_idx" ON "Run"("startClaimUntil");
CREATE INDEX "DeliveryRun_status_nextAttemptAt_idx" ON "DeliveryRun"("status", "nextAttemptAt");
