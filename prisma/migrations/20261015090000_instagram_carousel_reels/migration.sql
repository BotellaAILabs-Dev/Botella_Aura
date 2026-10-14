-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'WHATSAPP_ADMIN_MESSAGE_SENT';

-- AlterEnum
ALTER TYPE "PublicationStatus" ADD VALUE 'PROCESSING';

-- AlterTable
ALTER TABLE "ContentPublication" ADD COLUMN     "externalId" TEXT;
