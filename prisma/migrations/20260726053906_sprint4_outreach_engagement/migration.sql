-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'QUALIFIED', 'DRAFTED', 'CONTACTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('FUNDING', 'HIRING', 'GITHUB_ACTIVITY', 'NEWS', 'LEADERSHIP_CHANGE');

-- CreateEnum
CREATE TYPE "OutreachType" AS ENUM ('CONNECTION_NOTE', 'FOLLOWUP');

-- CreateEnum
CREATE TYPE "OutreachStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'REJECTED');

-- CreateEnum
CREATE TYPE "EngagementStatus" AS ENUM ('DRAFT', 'POSTED', 'DISCARDED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'OUTREACH_CONFIG_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'LEAD_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'LEAD_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'LEAD_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE 'LEAD_SIGNAL_DETECTED';
ALTER TYPE "AuditAction" ADD VALUE 'OUTREACH_DRAFTED';
ALTER TYPE "AuditAction" ADD VALUE 'OUTREACH_SUBMITTED_FOR_APPROVAL';
ALTER TYPE "AuditAction" ADD VALUE 'OUTREACH_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'OUTREACH_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'OUTREACH_SENT';
ALTER TYPE "AuditAction" ADD VALUE 'ENGAGEMENT_TARGET_ADDED';
ALTER TYPE "AuditAction" ADD VALUE 'ENGAGEMENT_TARGET_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE 'ENGAGEMENT_COMMENT_DRAFTED';
ALTER TYPE "AuditAction" ADD VALUE 'ENGAGEMENT_COMMENT_POSTED';

-- CreateTable
CREATE TABLE "OutreachConfig" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "industries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "roleTitles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "companyStages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabledSources" JSONB NOT NULL DEFAULT '{"crunchbase":false,"github":true,"jobs":true,"news":true}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT,
    "title" TEXT,
    "companyName" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "linkedInProfileUrl" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSignal" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "signalType" "SignalType" NOT NULL,
    "description" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachMessage" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "OutreachType" NOT NULL,
    "status" "OutreachStatus" NOT NULL DEFAULT 'DRAFT',
    "draftText" TEXT NOT NULL,
    "aiMetadata" JSONB NOT NULL DEFAULT '{}',
    "rejectionReason" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngagementTarget" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngagementTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngagementComment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdById" TEXT,
    "targetPostUrl" TEXT NOT NULL,
    "targetAuthor" TEXT,
    "postExcerpt" TEXT,
    "draftText" TEXT NOT NULL,
    "status" "EngagementStatus" NOT NULL DEFAULT 'DRAFT',
    "aiMetadata" JSONB NOT NULL DEFAULT '{}',
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngagementComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutreachConfig_companyId_key" ON "OutreachConfig"("companyId");

-- CreateIndex
CREATE INDEX "Lead_companyId_status_idx" ON "Lead"("companyId", "status");

-- CreateIndex
CREATE INDEX "LeadSignal_leadId_idx" ON "LeadSignal"("leadId");

-- CreateIndex
CREATE INDEX "OutreachMessage_companyId_status_idx" ON "OutreachMessage"("companyId", "status");

-- CreateIndex
CREATE INDEX "OutreachMessage_leadId_idx" ON "OutreachMessage"("leadId");

-- CreateIndex
CREATE INDEX "EngagementTarget_companyId_idx" ON "EngagementTarget"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "EngagementTarget_companyId_profileUrl_key" ON "EngagementTarget"("companyId", "profileUrl");

-- CreateIndex
CREATE INDEX "EngagementComment_companyId_status_idx" ON "EngagementComment"("companyId", "status");

-- AddForeignKey
ALTER TABLE "OutreachConfig" ADD CONSTRAINT "OutreachConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSignal" ADD CONSTRAINT "LeadSignal_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachMessage" ADD CONSTRAINT "OutreachMessage_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachMessage" ADD CONSTRAINT "OutreachMessage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngagementTarget" ADD CONSTRAINT "EngagementTarget_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngagementComment" ADD CONSTRAINT "EngagementComment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
