-- Screens review
--  * background generation jobs (trend digest / planner / intelligence)
--  * lead fit breakdown + "not relevant, because…" feedback
--  * connect a data source by email verification code
--  * manual performance logging

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "GenerationJobKind" AS ENUM (
  'TREND_DIGEST', 'MARKETING_PLAN', 'INTELLIGENCE', 'BRAND_VOICE_PREVIEW'
);
CREATE TYPE "GenerationJobStatus" AS ENUM (
  'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'
);

-- Connecting by verified email, where a provider's OAuth app is not registered.
ALTER TYPE "ConnectionKind" ADD VALUE IF NOT EXISTS 'EMAIL_CODE';

-- New audit actions
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PERFORMANCE_LOGGED_MANUALLY';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LEAD_MARKED_IRRELEVANT';

-- ---------------------------------------------------------------------------
-- Background generation jobs
-- ---------------------------------------------------------------------------
CREATE TABLE "GenerationJob" (
  "id"         TEXT NOT NULL,
  "companyId"  TEXT NOT NULL,
  "userId"     TEXT,
  "kind"       "GenerationJobKind" NOT NULL,
  "status"     "GenerationJobStatus" NOT NULL DEFAULT 'QUEUED',
  "inputs"     JSONB NOT NULL DEFAULT '{}',
  "progress"   JSONB NOT NULL DEFAULT '{}',
  "result"     JSONB NOT NULL DEFAULT '{}',
  "error"      TEXT,
  "attempts"   INTEGER NOT NULL DEFAULT 0,
  "startedAt"  TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GenerationJob_companyId_kind_status_idx"
  ON "GenerationJob"("companyId", "kind", "status");
-- The reaper scans by status + age.
CREATE INDEX "GenerationJob_status_createdAt_idx"
  ON "GenerationJob"("status", "createdAt");

ALTER TABLE "GenerationJob"
  ADD CONSTRAINT "GenerationJob_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Lead fit breakdown + relevance feedback
-- ---------------------------------------------------------------------------
ALTER TABLE "Lead"
  ADD COLUMN "fitMatched"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "fitMissed"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "irrelevantReason" TEXT,
  ADD COLUMN "irrelevantAt"     TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- Connect by verified email
-- ---------------------------------------------------------------------------
ALTER TABLE "Connection"
  ADD COLUMN "verifiedEmail" TEXT,
  ADD COLUMN "verifiedAt"    TIMESTAMP(3);

CREATE TABLE "ConnectorEmailVerification" (
  "id"          TEXT NOT NULL,
  "companyId"   TEXT NOT NULL,
  "connectorId" TEXT NOT NULL,
  "email"       TEXT NOT NULL,
  "codeHash"    TEXT NOT NULL,
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  "consumedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectorEmailVerification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConnectorEmailVerification_companyId_connectorId_idx"
  ON "ConnectorEmailVerification"("companyId", "connectorId");
CREATE INDEX "ConnectorEmailVerification_expiresAt_idx"
  ON "ConnectorEmailVerification"("expiresAt");
