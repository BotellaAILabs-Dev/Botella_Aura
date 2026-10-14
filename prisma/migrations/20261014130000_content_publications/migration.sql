-- CreateEnum
CREATE TYPE "PublicationStatus" AS ENUM ('PUBLISHING', 'PUBLISHED', 'FAILED', 'MANUAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'CONTENT_PUBLISH_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'CONTENT_PUBLISH_FAILED';

-- CreateTable
CREATE TABLE "ContentPublication" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contentDraftId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "status" "PublicationStatus" NOT NULL,
    "contentHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "url" TEXT,
    "message" TEXT,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentPublication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentPublication_companyId_status_idx" ON "ContentPublication"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ContentPublication_contentDraftId_platform_key" ON "ContentPublication"("contentDraftId", "platform");

-- AddForeignKey
ALTER TABLE "ContentPublication" ADD CONSTRAINT "ContentPublication_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPublication" ADD CONSTRAINT "ContentPublication_contentDraftId_fkey" FOREIGN KEY ("contentDraftId") REFERENCES "ContentDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

