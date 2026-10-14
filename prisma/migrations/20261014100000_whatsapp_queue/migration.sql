-- CreateEnum
CREATE TYPE "WhatsAppJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'DEAD');

-- AlterTable
ALTER TABLE "WhatsAppConversation" ADD COLUMN     "leaseUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WhatsAppMessage" ADD COLUMN     "payload" JSONB;

-- CreateTable
CREATE TABLE "WhatsAppJob" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "status" "WhatsAppJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppJob_messageId_key" ON "WhatsAppJob"("messageId");

-- CreateIndex
CREATE INDEX "WhatsAppJob_status_runAfter_idx" ON "WhatsAppJob"("status", "runAfter");

-- CreateIndex
CREATE INDEX "WhatsAppJob_conversationId_status_createdAt_idx" ON "WhatsAppJob"("conversationId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "WhatsAppJob" ADD CONSTRAINT "WhatsAppJob_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WhatsAppConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppJob" ADD CONSTRAINT "WhatsAppJob_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "WhatsAppMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

