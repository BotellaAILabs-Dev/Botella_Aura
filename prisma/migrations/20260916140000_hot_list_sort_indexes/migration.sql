-- Index the remaining dashboard lists' actual access patterns.
--
-- Every one of these pages runs `WHERE "companyId" = $1 ORDER BY <col> DESC`
-- and keeps only the first screenful. The existing indexes on these tables
-- cover status/source/category lookups; none of them helps that sort, so
-- Postgres reads every row belonging to the workspace and sorts the whole set
-- in memory before discarding all but the top of it.
--
-- This is the same fix already applied to ContentDraft in
-- 20260907120000_content_draft_updated_at_index, extended to the tables that
-- were missed. Lead matters most of the three: it backs both the Leads table
-- and the Outreach board.
--
-- Purely additive: no column, constraint or data changes, and
-- CREATE INDEX IF NOT EXISTS makes re-running it a no-op.
CREATE INDEX IF NOT EXISTS "Lead_companyId_updatedAt_idx"
  ON "Lead" ("companyId", "updatedAt");
CREATE INDEX IF NOT EXISTS "Campaign_companyId_createdAt_idx"
  ON "Campaign" ("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "MarketingMemory_companyId_generatedAt_idx"
  ON "MarketingMemory" ("companyId", "generatedAt");
CREATE INDEX IF NOT EXISTS "EngagementTarget_companyId_createdAt_idx"
  ON "EngagementTarget" ("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "KnowledgeSource_companyId_createdAt_idx"
  ON "KnowledgeSource" ("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "CompetitorProfile_companyId_createdAt_idx"
  ON "CompetitorProfile" ("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "DiscoveryProfile_companyId_createdAt_idx"
  ON "DiscoveryProfile" ("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "TrendDigest_companyId_date_idx"
  ON "TrendDigest" ("companyId", "date");
