-- AlterEnum
ALTER TYPE "CompanyRole" ADD VALUE 'VIEWER';

-- AlterTable
ALTER TABLE "CompanyTrendConfig" ADD COLUMN     "geoCity" TEXT,
ADD COLUMN     "geoCountry" TEXT,
ADD COLUMN     "geoRegion" TEXT,
ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "timeRangeDays" INTEGER NOT NULL DEFAULT 4;

