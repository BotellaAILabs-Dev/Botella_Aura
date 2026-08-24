-- Client review (Phases 1–3)
--  * truthful invitation email delivery status
--  * lead requirement/category so different requirements never mix
--  * real connector credential storage
--  * AI Marketing Advisor / Planner
--  * AI Marketing Intelligence snapshots

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'NOT_CONFIGURED');
CREATE TYPE "ConnectionKind" AS ENUM ('OAUTH', 'API_KEY');
CREATE TYPE "ConnectionStatus" AS ENUM ('CONNECTED', 'ERROR', 'EXPIRED', 'DISCONNECTED');

-- New audit actions
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'INVITATION_EMAIL_SENT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'INVITATION_EMAIL_FAILED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMAIL_TEST_SENT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LEAD_SENT_TO_OUTREACH';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONNECTOR_CONNECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONNECTOR_DISCONNECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONNECTOR_CREDENTIALS_SAVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONNECTOR_SYNCED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ADVISOR_REPORT_GENERATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_PLAN_GENERATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'INTELLIGENCE_SNAPSHOT_GENERATED';

-- ---------------------------------------------------------------------------
-- Invitation email delivery truth
-- ---------------------------------------------------------------------------
ALTER TABLE "CompanyInvitation"
  ADD COLUMN "emailStatus" "EmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "emailTransport" TEXT,
  ADD COLUMN "emailError" TEXT,
  ADD COLUMN "emailSentAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- Lead requirement / category
-- ---------------------------------------------------------------------------
ALTER TABLE "DiscoveryProfile" ADD COLUMN "category" TEXT;
ALTER TABLE "Lead" ADD COLUMN "category" TEXT;

-- Backfill: existing discovered leads inherit their profile's name as category
-- so nothing is left uncategorised after the upgrade.
UPDATE "Lead" AS l
SET "category" = p."name"
FROM "DiscoveryProfile" AS p
WHERE l."discoveryProfileId" = p."id" AND l."category" IS NULL;

CREATE INDEX "Lead_companyId_category_idx" ON "Lead"("companyId", "category");
CREATE INDEX "Lead_discoveryProfileId_idx" ON "Lead"("discoveryProfileId");

-- ---------------------------------------------------------------------------
-- Connectors
-- ---------------------------------------------------------------------------
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "kind" "ConnectionKind" NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "accountLabel" TEXT,
    "scope" TEXT,
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "apiKeyEnc" TEXT,
    "expiresAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "lastSyncedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "connectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Connection_companyId_connectorId_key" ON "Connection"("companyId", "connectorId");
CREATE INDEX "Connection_companyId_idx" ON "Connection"("companyId");
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- AI Marketing Advisor
-- ---------------------------------------------------------------------------
CREATE TABLE "AdvisorReport" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "model" TEXT NOT NULL DEFAULT 'none',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdvisorReport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdvisorReport_companyId_date_key" ON "AdvisorReport"("companyId", "date");
CREATE INDEX "AdvisorReport_companyId_date_idx" ON "AdvisorReport"("companyId", "date");
ALTER TABLE "AdvisorReport" ADD CONSTRAINT "AdvisorReport_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- AI Marketing Planner
-- ---------------------------------------------------------------------------
CREATE TABLE "MarketingPlan" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "month" TIMESTAMP(3) NOT NULL,
    "inputs" JSONB NOT NULL DEFAULT '{}',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "model" TEXT NOT NULL DEFAULT 'none',
    "createdById" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MarketingPlan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MarketingPlan_companyId_month_key" ON "MarketingPlan"("companyId", "month");
CREATE INDEX "MarketingPlan_companyId_month_idx" ON "MarketingPlan"("companyId", "month");
ALTER TABLE "MarketingPlan" ADD CONSTRAINT "MarketingPlan_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- AI Marketing Intelligence
-- ---------------------------------------------------------------------------
CREATE TABLE "IntelligenceSnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "overallScore" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT NOT NULL DEFAULT 'none',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IntelligenceSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntelligenceSnapshot_companyId_date_key" ON "IntelligenceSnapshot"("companyId", "date");
CREATE INDEX "IntelligenceSnapshot_companyId_date_idx" ON "IntelligenceSnapshot"("companyId", "date");
ALTER TABLE "IntelligenceSnapshot" ADD CONSTRAINT "IntelligenceSnapshot_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
