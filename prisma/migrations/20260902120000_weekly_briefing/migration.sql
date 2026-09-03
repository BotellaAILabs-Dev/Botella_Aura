-- Autonomous agent — the weekly briefing
--
-- Every input already existed (trend digests, competitor reports, advisor
-- opportunities, intelligence scores, marketing memory, content drafts). What
-- did not exist was anything that ASSEMBLED them into one artifact a person
-- opens on Monday. Additive: no existing table or column changes.

CREATE TYPE "BriefingStatus" AS ENUM ('WORKING', 'READY', 'FAILED');

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BRIEFING_GENERATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BRIEFING_FAILED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AUTOPILOT_RUN';

CREATE TABLE "WorkspaceBriefing" (
  "id"          TEXT NOT NULL,
  "companyId"   TEXT NOT NULL,
  -- Monday 00:00 UTC of the week this covers, matching how CompetitorReport
  -- already keys its weeks.
  "weekStart"   TIMESTAMP(3) NOT NULL,
  "weekEnd"     TIMESTAMP(3) NOT NULL,
  "status"      "BriefingStatus" NOT NULL DEFAULT 'WORKING',
  "payload"     JSONB NOT NULL DEFAULT '{}',
  -- What the autonomous cycle actually did, kept separate from the assembled
  -- payload so the record of the agent's own actions survives a reshape.
  "activity"    JSONB NOT NULL DEFAULT '{}',
  "error"       TEXT,
  "model"       TEXT NOT NULL DEFAULT 'none',
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readAt"      TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceBriefing_pkey" PRIMARY KEY ("id")
);

-- One briefing per company per week; a re-run replaces rather than duplicates.
CREATE UNIQUE INDEX "WorkspaceBriefing_companyId_weekStart_key"
  ON "WorkspaceBriefing"("companyId", "weekStart");
CREATE INDEX "WorkspaceBriefing_companyId_weekStart_idx"
  ON "WorkspaceBriefing"("companyId", "weekStart");

ALTER TABLE "WorkspaceBriefing"
  ADD CONSTRAINT "WorkspaceBriefing_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
