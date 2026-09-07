-- Index the Content Studio board's actual access pattern.
--
-- The board runs `WHERE "companyId" = $1 ORDER BY "updatedAt" DESC LIMIT n`.
-- The existing indexes cover (companyId, status) and (companyId, scheduledFor);
-- neither helps that sort, so Postgres had to read every draft belonging to the
-- workspace and sort the whole set in memory before discarding all but the
-- first page. This index lets it walk the rows it needs in order and stop.
--
-- Purely additive: no column, constraint or data changes, and CREATE INDEX
-- IF NOT EXISTS makes re-running it a no-op.
CREATE INDEX IF NOT EXISTS "ContentDraft_companyId_updatedAt_idx"
  ON "ContentDraft" ("companyId", "updatedAt");
