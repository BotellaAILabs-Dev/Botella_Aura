-- CreateEnum
CREATE TYPE "CampaignTaskType" AS ENUM ('GENERATE_CONTENT', 'RUN_OUTREACH_BATCH', 'RUN_DISCOVERY', 'REVIEW_CHECKPOINT');

-- CreateEnum
CREATE TYPE "CampaignTaskStatus" AS ENUM ('PENDING', 'GENERATED', 'APPROVED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('TRIAL', 'STARTER', 'GROWTH', 'AGENCY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'CAMPAIGN_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'CAMPAIGN_PLAN_GENERATED';
ALTER TYPE "AuditAction" ADD VALUE 'CAMPAIGN_TASK_GENERATED';
ALTER TYPE "AuditAction" ADD VALUE 'CAMPAIGN_TASK_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'CAMPAIGN_PAUSED';
ALTER TYPE "AuditAction" ADD VALUE 'CAMPAIGN_RESUMED';
ALTER TYPE "AuditAction" ADD VALUE 'CAMPAIGN_CHECKPOINT_GENERATED';
ALTER TYPE "AuditAction" ADD VALUE 'ANALYTICS_REPORT_GENERATED';
ALTER TYPE "AuditAction" ADD VALUE 'CHECKOUT_STARTED';
ALTER TYPE "AuditAction" ADD VALUE 'TRIAL_STARTED';
ALTER TYPE "AuditAction" ADD VALUE 'SUBSCRIPTION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'SUBSCRIPTION_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'SUBSCRIPTION_CANCELED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_FAILED';

-- AlterEnum
ALTER TYPE "CampaignStatus" ADD VALUE 'PAUSED';

-- DropIndex
DROP INDEX "Campaign_companyId_idx";

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "durationDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "endDate" TIMESTAMP(3),
ADD COLUMN     "modulesIncluded" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "plan" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "startDate" TIMESTAMP(3),
ADD COLUMN     "targetAudience" TEXT,
ADD COLUMN     "themes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "CampaignTask" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "scheduledDate" TIMESTAMP(3) NOT NULL,
    "taskType" "CampaignTaskType" NOT NULL,
    "status" "CampaignTaskStatus" NOT NULL DEFAULT 'PENDING',
    "contentType" "ContentType",
    "topic" TEXT,
    "rationale" TEXT,
    "relatedContentDraftId" TEXT,
    "relatedDiscoveryRunId" TEXT,
    "checkpointSummary" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "plan" "Plan" NOT NULL DEFAULT 'TRIAL',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsReport" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "summary" TEXT NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignTask_companyId_scheduledDate_idx" ON "CampaignTask"("companyId", "scheduledDate");

-- CreateIndex
CREATE INDEX "CampaignTask_campaignId_scheduledDate_idx" ON "CampaignTask"("campaignId", "scheduledDate");

-- CreateIndex
CREATE INDEX "CampaignTask_status_scheduledDate_idx" ON "CampaignTask"("status", "scheduledDate");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_companyId_key" ON "Subscription"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_stripeCustomerId_key" ON "Subscription"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "Subscription_stripeCustomerId_idx" ON "Subscription"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "AnalyticsReport_companyId_periodStart_idx" ON "AnalyticsReport"("companyId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsReport_companyId_periodStart_key" ON "AnalyticsReport"("companyId", "periodStart");

-- CreateIndex
CREATE INDEX "Campaign_companyId_status_idx" ON "Campaign"("companyId", "status");

-- AddForeignKey
ALTER TABLE "CampaignTask" ADD CONSTRAINT "CampaignTask_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTask" ADD CONSTRAINT "CampaignTask_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsReport" ADD CONSTRAINT "AnalyticsReport_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
