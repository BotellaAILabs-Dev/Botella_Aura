-- Recommendation guardrails (docs/RECOMMENDATION-RULES.md).

-- AlterTable
ALTER TABLE "Recommendation" ADD COLUMN     "blockers" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "executable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "flags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Flags the engine already recorded in details.engine.flags become the column.
UPDATE "Recommendation"
SET "flags" = ARRAY(SELECT jsonb_array_elements_text("details"->'engine'->'flags'))
WHERE jsonb_typeof("details"->'engine'->'flags') = 'array';

-- Existing low-confidence recommendations still waiting for a decision become
-- advisory, as new ones are.
UPDATE "Recommendation"
SET "executable" = false,
    "blockers" = ARRAY['Low confidence: accept it after reviewing the evidence to make it actionable.']
WHERE "confidence" = 'LOW' AND "status" = 'PROPOSED';
