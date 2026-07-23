-- DropIndex
DROP INDEX "LinkedInConnection_companyId_idx";

-- AlterTable
ALTER TABLE "LinkedInConnection" ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "errorMessage" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "LinkedInConnection_companyId_key" ON "LinkedInConnection"("companyId");

