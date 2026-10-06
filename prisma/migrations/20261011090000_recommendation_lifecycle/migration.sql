-- Recommendation lifecycle (docs/RECOMMENDATION-LIFECYCLE.md).
--
-- Hand-written so existing rows keep their status: PROPOSED is renamed in
-- place to GENERATED (a generated SQL recreates the type and would fail on
-- any row still PROPOSED), and the new states are added alongside.

ALTER TYPE "RecommendationStatus" RENAME VALUE 'PROPOSED' TO 'GENERATED';
ALTER TYPE "RecommendationStatus" ADD VALUE 'PRESENTED' AFTER 'GENERATED';
ALTER TYPE "RecommendationStatus" ADD VALUE 'EDITED' AFTER 'ACCEPTED';
ALTER TYPE "RecommendationStatus" ADD VALUE 'SKIPPED' AFTER 'EDITED';

ALTER TABLE "Recommendation" ALTER COLUMN "status" SET DEFAULT 'GENERATED';

-- AlterTable
ALTER TABLE "Recommendation" ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "presentedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RecommendationEvent" ADD COLUMN     "action" TEXT NOT NULL DEFAULT 'status',
ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'user';

-- Name the action of every existing history entry from what it did.
UPDATE "RecommendationEvent" SET
  "action" = CASE
    WHEN "fromStatus" IS NULL THEN 'generate'
    WHEN "fromStatus" = "toStatus" THEN 'defer'
    ELSE CASE "toStatus"::text
      WHEN 'ACCEPTED' THEN 'accept'
      WHEN 'REJECTED' THEN 'reject'
      WHEN 'IN_PROGRESS' THEN 'start'
      WHEN 'COMPLETED' THEN 'complete'
      WHEN 'WITHDRAWN' THEN 'withdraw'
      WHEN 'EXPIRED' THEN 'expire'
      ELSE 'status' END
  END,
  "source" = CASE
    WHEN "fromStatus" IS NULL AND "actorId" IS NULL THEN 'engine'
    WHEN "toStatus"::text = 'EXPIRED' THEN 'system'
    WHEN "actorId" IS NULL THEN 'system'
    ELSE 'user'
  END;
