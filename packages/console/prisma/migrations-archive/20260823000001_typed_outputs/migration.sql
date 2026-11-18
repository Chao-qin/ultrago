ALTER TABLE "Run" ADD COLUMN "paramsTypeJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "Run" ADD COLUMN "outputsData" TEXT;
ALTER TABLE "Run" ADD COLUMN "outputsType" TEXT;
ALTER TABLE "Run" ADD COLUMN "outputsContentType" TEXT;

ALTER TABLE "OutputRecord" RENAME COLUMN "outputJson" TO "outputData";
ALTER TABLE "OutputRecord" ADD COLUMN "outputType" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "OutputRecord" ADD COLUMN "contentType" TEXT NOT NULL DEFAULT 'text/plain';
ALTER TABLE "OutputRecord" ADD COLUMN "paramsJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "OutputRecord" ADD COLUMN "paramsTypeJson" TEXT NOT NULL DEFAULT '{}';
