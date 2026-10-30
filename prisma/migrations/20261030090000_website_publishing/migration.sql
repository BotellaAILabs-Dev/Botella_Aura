-- CreateEnum
CREATE TYPE "WebsiteConnectionStatus" AS ENUM ('CONNECTED', 'ERROR', 'REAUTH_REQUIRED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "WebsitePublicationStatus" AS ENUM ('SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'DRAFTED', 'FAILED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'WEBSITE_CONNECTED';
ALTER TYPE "AuditAction" ADD VALUE 'WEBSITE_DISCONNECTED';
ALTER TYPE "AuditAction" ADD VALUE 'WEBSITE_REAUTH_REQUIRED';
ALTER TYPE "AuditAction" ADD VALUE 'WEBSITE_PUBLISH_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'WEBSITE_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE 'WEBSITE_PUBLISH_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'WEBSITE_SCHEDULE_UPDATED';

-- CreateTable
CREATE TABLE "WebsiteConnection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "status" "WebsiteConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "authKind" TEXT NOT NULL,
    "credentialsEnc" TEXT,
    "accountLabel" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "lastError" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "connectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsiteConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebsitePublication" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contentDraftId" TEXT NOT NULL,
    "websiteConnectionId" TEXT NOT NULL,
    "status" "WebsitePublicationStatus" NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'publish',
    "scheduledFor" TIMESTAMP(3),
    "viaSchedule" BOOLEAN NOT NULL DEFAULT false,
    "contentHash" TEXT,
    "options" JSONB NOT NULL DEFAULT '{}',
    "seoReport" JSONB NOT NULL DEFAULT '{}',
    "remoteState" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "externalId" TEXT,
    "externalUrl" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "log" JSONB NOT NULL DEFAULT '[]',
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsitePublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebsitePublishSchedule" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "websiteConnectionId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "timeOfDay" TEXT NOT NULL DEFAULT '09:00',
    "mode" TEXT NOT NULL DEFAULT 'publish',
    "postsPerSlot" INTEGER NOT NULL DEFAULT 1,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsitePublishSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebsiteConnection_companyId_idx" ON "WebsiteConnection"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WebsiteConnection_companyId_platform_siteUrl_key" ON "WebsiteConnection"("companyId", "platform", "siteUrl");

-- CreateIndex
CREATE INDEX "WebsitePublication_companyId_updatedAt_idx" ON "WebsitePublication"("companyId", "updatedAt");

-- CreateIndex
CREATE INDEX "WebsitePublication_status_scheduledFor_idx" ON "WebsitePublication"("status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "WebsitePublication_contentDraftId_websiteConnectionId_key" ON "WebsitePublication"("contentDraftId", "websiteConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "WebsitePublishSchedule_websiteConnectionId_key" ON "WebsitePublishSchedule"("websiteConnectionId");

-- CreateIndex
CREATE INDEX "WebsitePublishSchedule_enabled_nextRunAt_idx" ON "WebsitePublishSchedule"("enabled", "nextRunAt");

-- AddForeignKey
ALTER TABLE "WebsiteConnection" ADD CONSTRAINT "WebsiteConnection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsitePublication" ADD CONSTRAINT "WebsitePublication_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsitePublication" ADD CONSTRAINT "WebsitePublication_contentDraftId_fkey" FOREIGN KEY ("contentDraftId") REFERENCES "ContentDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsitePublication" ADD CONSTRAINT "WebsitePublication_websiteConnectionId_fkey" FOREIGN KEY ("websiteConnectionId") REFERENCES "WebsiteConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsitePublishSchedule" ADD CONSTRAINT "WebsitePublishSchedule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsitePublishSchedule" ADD CONSTRAINT "WebsitePublishSchedule_websiteConnectionId_fkey" FOREIGN KEY ("websiteConnectionId") REFERENCES "WebsiteConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

