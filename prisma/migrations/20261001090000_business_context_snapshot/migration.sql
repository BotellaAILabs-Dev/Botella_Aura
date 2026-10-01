-- Business Context Snapshot: the latest AI-ready snapshot per workspace.
--
-- Additive only: a new table with a cascade to Company. No existing rows or
-- columns change, so it is safe to deploy ahead of the code that reads it.

-- CreateTable
CREATE TABLE "BusinessContextSnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "sourceStamp" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidatedAt" TIMESTAMP(3),

    CONSTRAINT "BusinessContextSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessContextSnapshot_companyId_key" ON "BusinessContextSnapshot"("companyId");

-- AddForeignKey
ALTER TABLE "BusinessContextSnapshot" ADD CONSTRAINT "BusinessContextSnapshot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

