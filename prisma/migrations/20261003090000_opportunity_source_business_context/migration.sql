-- Opportunities detected from the business's own context (e.g. a channel it
-- uses but has not connected) get their own source, instead of "MANUAL".
--
-- Additive only: one new enum value.

-- AlterEnum
ALTER TYPE "OpportunitySource" ADD VALUE 'BUSINESS_CONTEXT';

