-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'COMPETITOR_ADDED';
ALTER TYPE "AuditAction" ADD VALUE 'COMPETITOR_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'COMPETITOR_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE 'COMPETITOR_SNAPSHOT_CAPTURED';
ALTER TYPE "AuditAction" ADD VALUE 'COMPETITOR_REPORT_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'COMPETITOR_REPORT_GENERATED';

-- AlterTable
ALTER TABLE "CompetitorProfile" ADD COLUMN     "githubOrg" TEXT,
ADD COLUMN     "linkedInUrl" TEXT,
ADD COLUMN     "pricingUrl" TEXT,
ADD COLUMN     "trackingEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "CompetitorSnapshot" (
    "id" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "homepageHash" TEXT,
    "homepageText" TEXT,
    "pricingHash" TEXT,
    "pricingText" TEXT,
    "changesSummary" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorReport" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "weekEnd" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "model" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompetitorSnapshot_competitorId_capturedAt_idx" ON "CompetitorSnapshot"("competitorId", "capturedAt");

-- CreateIndex
CREATE INDEX "CompetitorReport_companyId_weekStart_idx" ON "CompetitorReport"("companyId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitorReport_companyId_weekStart_key" ON "CompetitorReport"("companyId", "weekStart");

-- AddForeignKey
ALTER TABLE "CompetitorSnapshot" ADD CONSTRAINT "CompetitorSnapshot_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "CompetitorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorReport" ADD CONSTRAINT "CompetitorReport_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
