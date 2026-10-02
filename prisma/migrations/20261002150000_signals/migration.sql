-- Signal aggregation: normalised signals from every Aura source in one place,
-- and an optional link from opportunity evidence to the signal it came from.
--
-- Additive only: new enums and table, and a nullable column + index on
-- OpportunitySignal.

-- CreateEnum
CREATE TYPE "SignalSource" AS ENUM ('TRENDS', 'COMPETITORS', 'ANALYTICS', 'MEMORY', 'BUSINESS_CONTEXT');

-- CreateEnum
CREATE TYPE "SignalReliability" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- AlterTable
ALTER TABLE "OpportunitySignal" ADD COLUMN     "signalId" TEXT;

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "source" "SignalSource" NOT NULL,
    "kind" "OpportunitySignalKind" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "url" TEXT,
    "refId" TEXT,
    "sightings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "reliability" "SignalReliability" NOT NULL,
    "reliabilityReason" TEXT NOT NULL,
    "strength" DOUBLE PRECISION,
    "contextRevision" TEXT,
    "contextMatches" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Signal_companyId_source_observedAt_idx" ON "Signal"("companyId", "source", "observedAt");

-- CreateIndex
CREATE INDEX "Signal_companyId_lastSeenAt_idx" ON "Signal"("companyId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "Signal_companyId_dedupeKey_key" ON "Signal"("companyId", "dedupeKey");

-- CreateIndex
CREATE INDEX "OpportunitySignal_signalId_idx" ON "OpportunitySignal"("signalId");

-- AddForeignKey
ALTER TABLE "OpportunitySignal" ADD CONSTRAINT "OpportunitySignal_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

