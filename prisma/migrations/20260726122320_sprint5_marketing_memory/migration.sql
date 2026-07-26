-- AlterTable
ALTER TABLE "OutreachMessage" ADD COLUMN     "connectionAccepted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "replyReceived" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PerformanceSnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contentDraftId" TEXT,
    "outreachMessageId" TEXT,
    "engagementCommentId" TEXT,
    "source" "PerformanceSource" NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingMemory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "insightType" "InsightType" NOT NULL,
    "insight" TEXT NOT NULL,
    "confidence" "MemoryConfidence" NOT NULL DEFAULT 'LOW',
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "supportingDataSummary" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingMemory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PerformanceSnapshot_companyId_capturedAt_idx" ON "PerformanceSnapshot"("companyId", "capturedAt");

-- CreateIndex
CREATE INDEX "PerformanceSnapshot_contentDraftId_idx" ON "PerformanceSnapshot"("contentDraftId");

-- CreateIndex
CREATE INDEX "MarketingMemory_companyId_insightType_idx" ON "MarketingMemory"("companyId", "insightType");

-- CreateIndex
CREATE INDEX "MarketingMemory_companyId_isActive_idx" ON "MarketingMemory"("companyId", "isActive");

-- AddForeignKey
ALTER TABLE "PerformanceSnapshot" ADD CONSTRAINT "PerformanceSnapshot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceSnapshot" ADD CONSTRAINT "PerformanceSnapshot_contentDraftId_fkey" FOREIGN KEY ("contentDraftId") REFERENCES "ContentDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceSnapshot" ADD CONSTRAINT "PerformanceSnapshot_outreachMessageId_fkey" FOREIGN KEY ("outreachMessageId") REFERENCES "OutreachMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceSnapshot" ADD CONSTRAINT "PerformanceSnapshot_engagementCommentId_fkey" FOREIGN KEY ("engagementCommentId") REFERENCES "EngagementComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingMemory" ADD CONSTRAINT "MarketingMemory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
