-- Recommendation data model (docs/RECOMMENDATION-MODEL.md).
--
-- Hand-written rather than generated so it is safe for recommendations that
-- already exist (created by the Sprint 7 foundation): new required fields are
-- filled from each recommendation's opportunity before they become NOT NULL,
-- and the old `content` bag is carried over into `details`.

-- Every recommendation must have an originating opportunity. Stop, rather than
-- guess, if one does not.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Recommendation" WHERE "opportunityId" IS NULL) THEN
    RAISE EXCEPTION 'Recommendation rows without an opportunity exist; resolve them before applying this migration.';
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "RecommendationType" AS ENUM ('CONTENT', 'CAMPAIGN', 'COMPETITIVE_RESPONSE', 'AUDIENCE', 'CHANNEL', 'OPTIMIZATION', 'OTHER');

-- AlterEnum (not used until a later statement commits; safe on PostgreSQL 12+)
ALTER TYPE "RecommendationStatus" ADD VALUE 'IN_PROGRESS';
ALTER TYPE "RecommendationStatus" ADD VALUE 'COMPLETED';
ALTER TYPE "RecommendationStatus" ADD VALUE 'EXPIRED';

-- DropForeignKey (re-created below as NO ACTION)
ALTER TABLE "Recommendation" DROP CONSTRAINT "Recommendation_opportunityId_fkey";

-- New columns, nullable first so existing rows can be filled in.
ALTER TABLE "Recommendation"
ADD COLUMN "type" "RecommendationType",
ADD COLUMN "action" TEXT,
ADD COLUMN "steps" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "rationale" TEXT,
ADD COLUMN "expectedOutcome" TEXT,
ADD COLUMN "outcomeMetric" TEXT,
ADD COLUMN "channel" TEXT,
ADD COLUMN "contentType" TEXT,
ADD COLUMN "audience" TEXT,
ADD COLUMN "details" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "relevantUntil" TIMESTAMP(3),
ADD COLUMN "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "startedAt" TIMESTAMP(3),
ADD COLUMN "completedAt" TIMESTAMP(3),
ADD COLUMN "expiredAt" TIMESTAMP(3);

-- Fill existing rows from their opportunity (same mapping as
-- lib/recommendations.ts TYPE_FOR_OPPORTUNITY).
UPDATE "Recommendation" r SET
  "type" = (CASE o."type"
    WHEN 'TRENDING_TOPIC' THEN 'CONTENT'
    WHEN 'CONTENT_GAP' THEN 'CONTENT'
    WHEN 'SEASONAL_MOMENT' THEN 'CONTENT'
    WHEN 'COMPETITOR_MOVE' THEN 'COMPETITIVE_RESPONSE'
    WHEN 'COMPETITIVE_GAP' THEN 'COMPETITIVE_RESPONSE'
    WHEN 'AUDIENCE_SEGMENT' THEN 'AUDIENCE'
    WHEN 'CHANNEL' THEN 'CHANNEL'
    WHEN 'PERFORMANCE_PATTERN' THEN 'OPTIMIZATION'
    ELSE 'OTHER' END)::"RecommendationType",
  "action" = 'Act on this opportunity: ' || r."title",
  "rationale" = COALESCE(o."rationale", r."summary"),
  "expectedOutcome" = 'Not recorded: created before recommendations had an expected outcome.',
  "relevantUntil" = o."relevantUntil",
  "details" = r."content",
  "statusChangedAt" = COALESCE(r."decidedAt", r."createdAt")
FROM "Opportunity" o
WHERE o."id" = r."opportunityId";

ALTER TABLE "Recommendation"
ALTER COLUMN "type" SET NOT NULL,
ALTER COLUMN "action" SET NOT NULL,
ALTER COLUMN "rationale" SET NOT NULL,
ALTER COLUMN "expectedOutcome" SET NOT NULL,
ALTER COLUMN "opportunityId" SET NOT NULL,
DROP COLUMN "content";

-- CreateTable
CREATE TABLE "RecommendationEvent" (
    "id" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "fromStatus" "RecommendationStatus",
    "toStatus" "RecommendationStatus" NOT NULL,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationEvent_pkey" PRIMARY KEY ("id")
);

-- History for existing rows: their current status, as of when it was set.
INSERT INTO "RecommendationEvent" ("id", "recommendationId", "fromStatus", "toStatus", "actorId", "note", "createdAt")
SELECT 'mig_' || r."id", r."id", NULL, r."status", r."decidedById",
       'Recorded before status history existed.', COALESCE(r."decidedAt", r."createdAt")
FROM "Recommendation" r;

-- CreateIndex
CREATE INDEX "RecommendationEvent_recommendationId_createdAt_idx" ON "RecommendationEvent"("recommendationId", "createdAt");

-- CreateIndex
CREATE INDEX "Recommendation_companyId_relevantUntil_idx" ON "Recommendation"("companyId", "relevantUntil");

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationEvent" ADD CONSTRAINT "RecommendationEvent_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
