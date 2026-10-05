-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN     "effort" TEXT,
ADD COLUMN     "impact" TEXT;

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'PROPOSED',
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "content" JSONB NOT NULL DEFAULT '{}',
    "confidence" "OpportunityConfidence" NOT NULL,
    "confidenceReason" TEXT,
    "priority" "OpportunityPriority" NOT NULL,
    "priorityScore" INTEGER NOT NULL,
    "handoff" JSONB NOT NULL,
    "handoffVersion" INTEGER NOT NULL,
    "contextRevision" TEXT,
    "contextFingerprint" TEXT,
    "contextFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationEvidence" (
    "id" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "opportunitySignalId" TEXT,
    "signalId" TEXT,
    "kind" "OpportunitySignalKind" NOT NULL,
    "refId" TEXT,
    "label" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "url" TEXT,
    "observedAt" TIMESTAMP(3),
    "reliability" "SignalReliability",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Recommendation_companyId_status_idx" ON "Recommendation"("companyId", "status");

-- CreateIndex
CREATE INDEX "Recommendation_opportunityId_idx" ON "Recommendation"("opportunityId");

-- CreateIndex
CREATE INDEX "RecommendationEvidence_recommendationId_idx" ON "RecommendationEvidence"("recommendationId");

-- CreateIndex
CREATE INDEX "RecommendationEvidence_signalId_idx" ON "RecommendationEvidence"("signalId");

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationEvidence" ADD CONSTRAINT "RecommendationEvidence_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationEvidence" ADD CONSTRAINT "RecommendationEvidence_opportunitySignalId_fkey" FOREIGN KEY ("opportunitySignalId") REFERENCES "OpportunitySignal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationEvidence" ADD CONSTRAINT "RecommendationEvidence_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

