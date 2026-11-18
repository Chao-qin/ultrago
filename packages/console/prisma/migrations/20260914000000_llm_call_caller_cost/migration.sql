-- AlterTable
-- 全部 nullable 且无默认值：老行没有这些信息，填 0 / "" 会把「不知道」伪装成
-- 「零花费」「匿名调用方」。SQLite 的 ADD COLUMN 对 nullable 列是纯元数据操作，
-- 不重写表，所以这一步对已有数据量不敏感。
ALTER TABLE "LlmCall" ADD COLUMN "caller" TEXT;
ALTER TABLE "LlmCall" ADD COLUMN "costMicros" INTEGER;
ALTER TABLE "LlmCall" ADD COLUMN "costCurrency" TEXT;
ALTER TABLE "LlmCall" ADD COLUMN "attempt" INTEGER;

-- CreateIndex
CREATE INDEX "LlmCall_caller_idx" ON "LlmCall"("caller");

-- CreateIndex
-- 保留策略按 startedAt 删（「这次调用什么时候发生的」），不按 receivedAt。
CREATE INDEX "LlmCall_startedAt_idx" ON "LlmCall"("startedAt");
