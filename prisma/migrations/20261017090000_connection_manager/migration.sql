-- CreateEnum
CREATE TYPE "ConnectionHealth" AS ENUM ('CONNECTED', 'HEALTHY', 'WARNING', 'EXPIRED', 'DISCONNECTED', 'ACTION_REQUIRED');

-- CreateEnum
CREATE TYPE "ConnectionSetupStage" AS ENUM ('AUTHORIZED', 'ACCOUNT_SELECTED', 'CONFIRMED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'CONNECTION_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE 'CONNECTION_HEALTH_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'CONNECTION_TOKEN_REFRESHED';
ALTER TYPE "AuditAction" ADD VALUE 'CONNECTION_REAUTH_REQUIRED';
ALTER TYPE "AuditAction" ADD VALUE 'CONNECTION_REVOKED';

-- AlterEnum
ALTER TYPE "ConnectionStatus" ADD VALUE 'REVOKED';

-- AlterTable
ALTER TABLE "Connection" ADD COLUMN     "capabilities" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "credentialRef" TEXT NOT NULL DEFAULT 'self',
ADD COLUMN     "health" "ConnectionHealth" NOT NULL DEFAULT 'CONNECTED',
ADD COLUMN     "healthCheckedAt" TIMESTAMP(3),
ADD COLUMN     "healthReason" TEXT,
ADD COLUMN     "lastExecutionAt" TIMESTAMP(3),
ADD COLUMN     "lastExecutionError" TEXT,
ADD COLUMN     "lastExecutionFailedAt" TIMESTAMP(3),
ADD COLUMN     "lastHealthyAt" TIMESTAMP(3),
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "providerAccountId" TEXT,
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "setupStage" "ConnectionSetupStage" NOT NULL DEFAULT 'CONFIRMED';

-- CreateTable
CREATE TABLE "ConnectedAccount" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "channel" TEXT,
    "selectable" BOOLEAN NOT NULL DEFAULT false,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConnectedAccount_companyId_idx" ON "ConnectedAccount"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedAccount_connectionId_kind_externalId_key" ON "ConnectedAccount"("connectionId", "kind", "externalId");

-- CreateIndex
CREATE INDEX "Connection_health_idx" ON "Connection"("health");

-- AddForeignKey
ALTER TABLE "ConnectedAccount" ADD CONSTRAINT "ConnectedAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectedAccount" ADD CONSTRAINT "ConnectedAccount_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ConnectedAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: describe existing connections in Connection Manager terms.
UPDATE "Connection" SET "provider" = CASE "connectorId"
    WHEN 'ga4' THEN 'google'
    WHEN 'search-console' THEN 'google'
    WHEN 'google-cse' THEN 'google'
    ELSE "connectorId" END
  WHERE "provider" IS NULL;

UPDATE "Connection" SET "channels" = CASE "connectorId"
    WHEN 'meta' THEN ARRAY['FACEBOOK','INSTAGRAM']
    WHEN 'ga4' THEN ARRAY['WEB']
    WHEN 'search-console' THEN ARRAY['WEB']
    WHEN 'mailchimp' THEN ARRAY['EMAIL']
    WHEN 'hubspot' THEN ARRAY['CRM']
    WHEN 'slack' THEN ARRAY['SLACK']
    ELSE ARRAY[]::TEXT[] END;

UPDATE "Connection" SET "scopes" = regexp_split_to_array(btrim("scope"), '[\s,]+')
  WHERE "scope" IS NOT NULL AND btrim("scope") <> '';

UPDATE "Connection" SET "confirmedAt" = "createdAt";

UPDATE "Connection" SET "health" = CASE "status"
    WHEN 'EXPIRED' THEN 'EXPIRED'::"ConnectionHealth"
    WHEN 'ERROR' THEN 'ACTION_REQUIRED'::"ConnectionHealth"
    WHEN 'DISCONNECTED' THEN 'DISCONNECTED'::"ConnectionHealth"
    ELSE 'CONNECTED'::"ConnectionHealth" END,
  "healthReason" = "errorMessage";

-- Mirror LinkedIn (which keeps its own table and tokens) into the Connection
-- Manager. No secret is copied: credentialRef points at LinkedInConnection.
INSERT INTO "Connection" ("id", "companyId", "connectorId", "kind", "status", "accountLabel", "scope",
    "expiresAt", "metadata", "errorMessage", "provider", "channels", "providerAccountId", "scopes",
    "credentialRef", "setupStage", "health", "healthReason", "confirmedAt", "createdAt", "updatedAt")
SELECT 'lim_' || li."id", li."companyId", 'linkedin', 'OAUTH',
    CASE li."status"
      WHEN 'ACTIVE' THEN 'CONNECTED'::"ConnectionStatus"
      WHEN 'EXPIRED' THEN 'EXPIRED'::"ConnectionStatus"
      WHEN 'ERROR' THEN 'ERROR'::"ConnectionStatus"
      ELSE 'DISCONNECTED'::"ConnectionStatus" END,
    li."displayName", li."scope", li."expiresAt", '{}'::jsonb, li."errorMessage",
    'linkedin', ARRAY['LINKEDIN'], li."linkedInUserId",
    CASE WHEN li."scope" IS NULL OR btrim(li."scope") = '' THEN ARRAY[]::TEXT[]
         ELSE regexp_split_to_array(btrim(li."scope"), '[\s,]+') END,
    'linkedin_connection',
    CASE WHEN li."status" = 'PENDING' THEN 'AUTHORIZED'::"ConnectionSetupStage" ELSE 'CONFIRMED'::"ConnectionSetupStage" END,
    CASE li."status"
      WHEN 'ACTIVE' THEN 'CONNECTED'::"ConnectionHealth"
      WHEN 'EXPIRED' THEN 'EXPIRED'::"ConnectionHealth"
      WHEN 'ERROR' THEN 'ACTION_REQUIRED'::"ConnectionHealth"
      ELSE 'DISCONNECTED'::"ConnectionHealth" END,
    li."errorMessage", li."connectedAt", li."createdAt", CURRENT_TIMESTAMP
FROM "LinkedInConnection" li
ON CONFLICT ("companyId", "connectorId") DO NOTHING;
