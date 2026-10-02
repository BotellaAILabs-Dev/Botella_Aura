-- Opportunities: what Aura detects, its evidence linked to the underlying
-- signals, and its lifecycle history.
--
-- Additive only: new enums and three tables with cascades to Company.

-- CreateEnum
CREATE TYPE "OpportunityType" AS ENUM ('TRENDING_TOPIC', 'COMPETITOR_MOVE', 'COMPETITIVE_GAP', 'CONTENT_GAP', 'SEASONAL_MOMENT', 'AUDIENCE_SEGMENT', 'CHANNEL', 'PERFORMANCE_PATTERN', 'OTHER');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('DETECTED', 'REVIEWED', 'RECOMMENDED', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OpportunityPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "OpportunityConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "OpportunitySource" AS ENUM ('ADVISOR', 'TRENDS', 'COMPETITORS', 'MEMORY', 'ANALYTICS', 'MANUAL');

-- CreateEnum
CREATE TYPE "OpportunitySignalKind" AS ENUM ('COMPETITOR_SNAPSHOT', 'TREND_ITEM', 'MEMORY_INSIGHT', 'CONTENT_DRAFT', 'ANALYTICS_REPORT', 'KNOWLEDGE_CHUNK', 'LEAD_SIGNAL', 'BUSINESS_CONTEXT', 'EXTERNAL');

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "OpportunityType" NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'DETECTED',
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "rationale" TEXT,
    "angle" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "source" "OpportunitySource" NOT NULL,
    "detectedBy" TEXT NOT NULL,
    "priority" "OpportunityPriority" NOT NULL,
    "priorityScore" INTEGER NOT NULL,
    "confidence" "OpportunityConfidence" NOT NULL,
    "confidenceReason" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "relevantUntil" TIMESTAMP(3),
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "recommendedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decisionNote" TEXT,
    "expiredAt" TIMESTAMP(3),
    "contextRevision" TEXT,
    "contextFingerprint" TEXT,
    "contextFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunitySignal" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "kind" "OpportunitySignalKind" NOT NULL,
    "refId" TEXT,
    "label" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "url" TEXT,
    "observedAt" TIMESTAMP(3),
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunitySignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityEvent" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "fromStatus" "OpportunityStatus",
    "toStatus" "OpportunityStatus" NOT NULL,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Opportunity_companyId_status_idx" ON "Opportunity"("companyId", "status");

-- CreateIndex
CREATE INDEX "Opportunity_companyId_relevantUntil_idx" ON "Opportunity"("companyId", "relevantUntil");

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_companyId_dedupeKey_key" ON "Opportunity"("companyId", "dedupeKey");

-- CreateIndex
CREATE INDEX "OpportunitySignal_kind_refId_idx" ON "OpportunitySignal"("kind", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "OpportunitySignal_opportunityId_fingerprint_key" ON "OpportunitySignal"("opportunityId", "fingerprint");

-- CreateIndex
CREATE INDEX "OpportunityEvent_opportunityId_createdAt_idx" ON "OpportunityEvent"("opportunityId", "createdAt");

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunitySignal" ADD CONSTRAINT "OpportunitySignal_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityEvent" ADD CONSTRAINT "OpportunityEvent_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

