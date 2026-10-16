-- CreateEnum
CREATE TYPE "ExecutionHandoffStatus" AS ENUM ('READY', 'BLOCKED', 'SUPERSEDED', 'EXECUTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'EXECUTION_HANDOFF_READY';
ALTER TYPE "AuditAction" ADD VALUE 'EXECUTION_HANDOFF_BLOCKED';

-- CreateTable
CREATE TABLE "ExecutionHandoff" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contentDraftId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "status" "ExecutionHandoffStatus" NOT NULL,
    "payload" JSONB NOT NULL,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "contentVersion" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExecutionHandoff_companyId_status_idx" ON "ExecutionHandoff"("companyId", "status");

-- CreateIndex
CREATE INDEX "ExecutionHandoff_status_scheduledFor_idx" ON "ExecutionHandoff"("status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionHandoff_contentDraftId_platform_key" ON "ExecutionHandoff"("contentDraftId", "platform");

-- AddForeignKey
ALTER TABLE "ExecutionHandoff" ADD CONSTRAINT "ExecutionHandoff_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionHandoff" ADD CONSTRAINT "ExecutionHandoff_contentDraftId_fkey" FOREIGN KEY ("contentDraftId") REFERENCES "ContentDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

