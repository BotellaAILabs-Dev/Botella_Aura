-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'WHATSAPP_SETTINGS_UPDATED';

-- AlterTable
ALTER TABLE "WhatsAppMessage" ADD COLUMN     "companyId" TEXT;

-- CreateIndex
CREATE INDEX "WhatsAppMessage_companyId_createdAt_idx" ON "WhatsAppMessage"("companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

