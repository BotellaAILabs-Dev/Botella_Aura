-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('SIGNAL', 'DISCOVERY_ENGINE', 'MANUAL');

-- CreateEnum
CREATE TYPE "DiscoveryRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "InsightType" AS ENUM ('CONTENT_FORMAT', 'CONTENT_LENGTH', 'TIMING', 'TOPIC', 'HASHTAG', 'OUTREACH_APPROACH', 'OTHER');

-- CreateEnum
CREATE TYPE "MemoryConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "PerformanceSource" AS ENUM ('LINKEDIN_API', 'EXTENSION_DOM', 'MANUAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'DISCOVERY_PROFILE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'DISCOVERY_PROFILE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'DISCOVERY_PROFILE_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'DISCOVERY_RUN_STARTED';
ALTER TYPE "AuditAction" ADD VALUE 'DISCOVERY_RUN_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE 'LEAD_DISCOVERED';
ALTER TYPE "AuditAction" ADD VALUE 'LEAD_SCORED';
ALTER TYPE "AuditAction" ADD VALUE 'PERFORMANCE_SNAPSHOT_CAPTURED';
ALTER TYPE "AuditAction" ADD VALUE 'OUTREACH_OUTCOME_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'MARKETING_MEMORY_GENERATED';

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "discoveryProfileId" TEXT,
ADD COLUMN     "fitRationale" TEXT,
ADD COLUMN     "fitScore" INTEGER,
ADD COLUMN     "source" "LeadSource" NOT NULL DEFAULT 'SIGNAL';

-- CreateTable
CREATE TABLE "DiscoveryProfile" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "criteria" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "autoRun" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveryProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "discoveryProfileId" TEXT NOT NULL,
    "status" "DiscoveryRunStatus" NOT NULL DEFAULT 'RUNNING',
    "leadsFound" INTEGER NOT NULL DEFAULT 0,
    "leadsCreated" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "DiscoveryRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiscoveryProfile_companyId_idx" ON "DiscoveryProfile"("companyId");

-- CreateIndex
CREATE INDEX "DiscoveryRun_companyId_startedAt_idx" ON "DiscoveryRun"("companyId", "startedAt");

-- CreateIndex
CREATE INDEX "DiscoveryRun_discoveryProfileId_idx" ON "DiscoveryRun"("discoveryProfileId");

-- CreateIndex
CREATE INDEX "Lead_companyId_source_idx" ON "Lead"("companyId", "source");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_discoveryProfileId_fkey" FOREIGN KEY ("discoveryProfileId") REFERENCES "DiscoveryProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryProfile" ADD CONSTRAINT "DiscoveryProfile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_discoveryProfileId_fkey" FOREIGN KEY ("discoveryProfileId") REFERENCES "DiscoveryProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
