-- Business material categories.
--
-- Additive and nullable throughout: existing sources and chunks keep working
-- with a NULL category, which retrieval treats exactly as it did before this
-- migration. Nothing has to be backfilled for the app to keep running.

-- CreateEnum
CREATE TYPE "MaterialCategory" AS ENUM ('COMPANY_INFO', 'PITCH_DECK', 'BRAND_GUIDELINES', 'AUDIENCE_ICP', 'PRODUCT_DOCS', 'DIFFERENTIATORS', 'PAST_CAMPAIGN', 'COMPETITOR_INTEL', 'OTHER');

-- AlterTable
ALTER TABLE "KnowledgeChunk" ADD COLUMN     "category" "MaterialCategory";

-- AlterTable
ALTER TABLE "KnowledgeSource" ADD COLUMN     "category" "MaterialCategory";

