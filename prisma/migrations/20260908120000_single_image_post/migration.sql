-- A caption plus ONE image — the ordinary social post.
--
-- Purely additive: adding a value to an enum leaves every existing row
-- untouched, and nothing selects on it until a draft is created with it. No
-- backfill, no rewrite, safe to apply to a live database.
ALTER TYPE "ContentType" ADD VALUE 'IMAGE_POST';
