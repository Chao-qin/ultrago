-- CreateTable
CREATE TABLE "FileAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "cdnUrl" TEXT NOT NULL,
    "githubUrl" TEXT NOT NULL,
    "htmlUrl" TEXT,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha" TEXT,
    "source" TEXT NOT NULL DEFAULT 'api',
    "tags" TEXT,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "FileAsset_path_idx" ON "FileAsset"("path");

-- CreateIndex
CREATE INDEX "FileAsset_createdAt_idx" ON "FileAsset"("createdAt");

-- CreateIndex
CREATE INDEX "FileAsset_deletedAt_idx" ON "FileAsset"("deletedAt");

-- 同一远程路径只保留一行活跃记录。Prisma schema 表达不了部分索引（没有
-- `where`），所以只能写在迁移里 —— 这是全仓既有做法
-- （`uniq_active_record_source` 同样是手写进 migration.sql 的）。
-- 软删后同名文件可以再传一次，不会撞这条索引。
CREATE UNIQUE INDEX "FileAsset_path_active" ON "FileAsset"("path") WHERE "deletedAt" IS NULL;
