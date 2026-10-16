-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "creationContext" JSONB,
ADD COLUMN     "recommendationId" TEXT;

-- CreateIndex
CREATE INDEX "Campaign_companyId_recommendationId_idx" ON "Campaign"("companyId", "recommendationId");
