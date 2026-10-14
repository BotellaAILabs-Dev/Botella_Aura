-- CreateEnum
CREATE TYPE "WhatsAppLinkChallengeStatus" AS ENUM ('ISSUED', 'CONFIRMED', 'COMPLETED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'WHATSAPP_LINK_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE 'WHATSAPP_LINKED';
ALTER TYPE "AuditAction" ADD VALUE 'WHATSAPP_UNLINKED';
ALTER TYPE "AuditAction" ADD VALUE 'WHATSAPP_WORKSPACE_SELECTED';

-- CreateTable
CREATE TABLE "WhatsAppLinkChallenge" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "WhatsAppLinkChallengeStatus" NOT NULL DEFAULT 'ISSUED',
    "userId" TEXT,
    "codeHash" TEXT,
    "codeAttempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppLinkChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppAccountLink" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activeCompanyId" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppAccountLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppLinkChallenge_tokenHash_key" ON "WhatsAppLinkChallenge"("tokenHash");

-- CreateIndex
CREATE INDEX "WhatsAppLinkChallenge_conversationId_createdAt_idx" ON "WhatsAppLinkChallenge"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAccountLink_conversationId_key" ON "WhatsAppAccountLink"("conversationId");

-- CreateIndex
CREATE INDEX "WhatsAppAccountLink_userId_idx" ON "WhatsAppAccountLink"("userId");

-- AddForeignKey
ALTER TABLE "WhatsAppLinkChallenge" ADD CONSTRAINT "WhatsAppLinkChallenge_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WhatsAppConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppLinkChallenge" ADD CONSTRAINT "WhatsAppLinkChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppAccountLink" ADD CONSTRAINT "WhatsAppAccountLink_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WhatsAppConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppAccountLink" ADD CONSTRAINT "WhatsAppAccountLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppAccountLink" ADD CONSTRAINT "WhatsAppAccountLink_activeCompanyId_fkey" FOREIGN KEY ("activeCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

