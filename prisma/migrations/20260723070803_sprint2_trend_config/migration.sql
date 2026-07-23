-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'LINKEDIN_TOKEN_REFRESHED';
ALTER TYPE "AuditAction" ADD VALUE 'TREND_CONFIG_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'TREND_DIGEST_GENERATED';
ALTER TYPE "AuditAction" ADD VALUE 'TREND_DIGEST_REQUESTED';

-- CreateTable
CREATE TABLE "CompanyTrendConfig" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subreddits" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rssFeeds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "competitorNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabledSources" JSONB NOT NULL DEFAULT '{"reddit":true,"hackernews":true,"news":true,"twitter":false}',
    "defaultsSeeded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyTrendConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyTrendConfig_companyId_key" ON "CompanyTrendConfig"("companyId");

-- AddForeignKey
ALTER TABLE "CompanyTrendConfig" ADD CONSTRAINT "CompanyTrendConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
