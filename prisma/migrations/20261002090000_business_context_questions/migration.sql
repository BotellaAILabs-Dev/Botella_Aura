-- Business Context questions: what happened to each question Aura asked
-- about missing business information, so it does not ask the same thing
-- repeatedly.
--
-- Additive only: a new enum and table with a cascade to Company.

-- CreateEnum
CREATE TYPE "ContextQuestionStatus" AS ENUM ('OPEN', 'ANSWERED', 'SNOOZED', 'DISMISSED', 'RESOLVED');

-- CreateTable
CREATE TABLE "BusinessContextQuestion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "questionKey" TEXT NOT NULL,
    "status" "ContextQuestionStatus" NOT NULL DEFAULT 'OPEN',
    "timesAsked" INTEGER NOT NULL DEFAULT 0,
    "lastAskedAt" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "answeredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessContextQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessContextQuestion_companyId_status_idx" ON "BusinessContextQuestion"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessContextQuestion_companyId_questionKey_key" ON "BusinessContextQuestion"("companyId", "questionKey");

-- AddForeignKey
ALTER TABLE "BusinessContextQuestion" ADD CONSTRAINT "BusinessContextQuestion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

