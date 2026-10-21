-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('APPROVED', 'READY_FOR_EXECUTION', 'SCHEDULED', 'QUEUED', 'EXECUTING', 'COMPLETED', 'FAILED', 'ACTION_REQUIRED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'EXECUTION_STATE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'EXECUTION_ROUTING_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_TIMEZONE_CHANGED';

-- AlterEnum
ALTER TYPE "PerformanceSource" ADD VALUE 'META_API';

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- CreateTable
CREATE TABLE "Execution" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contentDraftId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'APPROVED',
    "provider" TEXT,
    "connectorId" TEXT,
    "connectionId" TEXT,
    "connectedAccountId" TEXT,
    "targetKind" TEXT,
    "targetExternalId" TEXT,
    "targetName" TEXT,
    "traceId" TEXT,
    "businessContextRevision" TEXT,
    "opportunityId" TEXT,
    "recommendationId" TEXT,
    "approvalId" TEXT,
    "approvedVersion" INTEGER,
    "contentHash" TEXT,
    "assetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "handoffId" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "scheduledTimeZone" TEXT,
    "scheduledLocal" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextAttemptAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "providerResponse" JSONB NOT NULL DEFAULT '{}',
    "externalId" TEXT,
    "url" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionEvent" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "from" "ExecutionStatus",
    "to" "ExecutionStatus" NOT NULL,
    "actor" TEXT NOT NULL,
    "actorUserId" TEXT,
    "reason" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Execution_companyId_status_idx" ON "Execution"("companyId", "status");

-- CreateIndex
CREATE INDEX "Execution_status_scheduledFor_idx" ON "Execution"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "Execution_status_nextAttemptAt_idx" ON "Execution"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_contentDraftId_platform_key" ON "Execution"("contentDraftId", "platform");

-- CreateIndex
CREATE INDEX "ExecutionEvent_executionId_at_idx" ON "ExecutionEvent"("executionId", "at");

-- CreateIndex
CREATE INDEX "ExecutionEvent_companyId_at_idx" ON "ExecutionEvent"("companyId", "at");

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_contentDraftId_fkey" FOREIGN KEY ("contentDraftId") REFERENCES "ContentDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionEvent" ADD CONSTRAINT "ExecutionEvent_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: every post already approved or published gets its execution record,
-- so the lifecycle is visible for existing work too.
INSERT INTO "Execution" ("id", "companyId", "contentDraftId", "platform", "status", "scheduledFor", "scheduledTimeZone",
    "url", "completedAt", "attemptCount", "createdAt", "updatedAt")
SELECT 'exb_' || p."id", p."companyId", p."contentDraftId", p."platform",
    CASE p."status"
      WHEN 'PUBLISHED' THEN 'COMPLETED'::"ExecutionStatus"
      WHEN 'PROCESSING' THEN 'EXECUTING'::"ExecutionStatus"
      WHEN 'PUBLISHING' THEN 'EXECUTING'::"ExecutionStatus"
      WHEN 'FAILED' THEN 'FAILED'::"ExecutionStatus"
      ELSE 'ACTION_REQUIRED'::"ExecutionStatus" END,
    d."scheduledFor", 'UTC', p."url", p."publishedAt", p."attempts", p."createdAt", CURRENT_TIMESTAMP
FROM "ContentPublication" p JOIN "ContentDraft" d ON d."id" = p."contentDraftId"
ON CONFLICT ("contentDraftId", "platform") DO NOTHING;

INSERT INTO "Execution" ("id", "companyId", "contentDraftId", "platform", "status", "scheduledFor", "scheduledTimeZone", "createdAt", "updatedAt")
SELECT 'exd_' || d."id", d."companyId", d."id", d."platform",
    CASE WHEN d."scheduledFor" IS NOT NULL THEN 'SCHEDULED'::"ExecutionStatus" ELSE 'READY_FOR_EXECUTION'::"ExecutionStatus" END,
    d."scheduledFor", 'UTC', d."createdAt", CURRENT_TIMESTAMP
FROM "ContentDraft" d
WHERE d."status" = 'APPROVED' AND d."platform" IS NOT NULL
ON CONFLICT ("contentDraftId", "platform") DO NOTHING;

INSERT INTO "ExecutionEvent" ("id", "executionId", "companyId", "from", "to", "actor", "reason", "at")
SELECT 'eve_' || e."id", e."id", e."companyId", NULL, e."status", 'system', 'Recorded when the execution model was introduced.', CURRENT_TIMESTAMP
FROM "Execution" e;
