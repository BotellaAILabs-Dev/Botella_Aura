-- Graphic Generation — Content Studio visuals
--  * platform targeting on a draft (LinkedIn / Instagram / X / Facebook)
--  * GeneratedAsset: an image produced by an image-generation provider
--  * ContentMedia: the generic, ordered media attachment layer for a post
--
-- Every change is additive. No existing column changes type or nullability, so
-- drafts, the approval state machine and the publish queue behave unchanged.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "SocialPlatform" AS ENUM ('LINKEDIN', 'INSTAGRAM', 'X', 'FACEBOOK');
CREATE TYPE "ImageProvider" AS ENUM ('OPENAI', 'GOOGLE', 'STABILITY', 'REPLICATE');
CREATE TYPE "AssetStorageKind" AS ENUM ('DATABASE', 'EXTERNAL');
CREATE TYPE "MediaKind" AS ENUM ('IMAGE', 'VIDEO');

-- New audit actions. IF NOT EXISTS keeps a re-run harmless.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'GRAPHIC_PROMPT_GENERATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'GRAPHIC_GENERATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'GRAPHIC_GENERATION_FAILED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'GRAPHIC_ATTACHED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'GRAPHIC_DETACHED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'GRAPHIC_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONTENT_QUEUED';

-- ---------------------------------------------------------------------------
-- Platform targeting on an existing draft
-- ---------------------------------------------------------------------------
-- Nullable on purpose: NULL means "derive from the content type", which is
-- exactly how every pre-existing draft already behaved.
ALTER TABLE "ContentDraft" ADD COLUMN "platform" "SocialPlatform";

-- ---------------------------------------------------------------------------
-- GeneratedAsset — a stored, durable graphic
-- ---------------------------------------------------------------------------
CREATE TABLE "GeneratedAsset" (
  "id"             TEXT NOT NULL,
  "companyId"      TEXT NOT NULL,
  "contentDraftId" TEXT,
  "createdById"    TEXT,
  "provider"       "ImageProvider" NOT NULL,
  "model"          TEXT NOT NULL,
  "kind"           "MediaKind" NOT NULL DEFAULT 'IMAGE',
  "prompt"         TEXT NOT NULL,
  "originalPrompt" TEXT,
  "revisedPrompt"  TEXT,
  "negativePrompt" TEXT,
  "style"          TEXT,
  "aspectRatio"    TEXT NOT NULL,
  "width"          INTEGER NOT NULL,
  "height"         INTEGER NOT NULL,
  "mimeType"       TEXT NOT NULL,
  "fileSize"       INTEGER NOT NULL,
  "storage"        "AssetStorageKind" NOT NULL DEFAULT 'DATABASE',
  -- Provider URLs expire; the bytes are pulled once and kept here (or in a
  -- bucket, when one is configured — then "storageUrl" is authoritative).
  "data"           BYTEA,
  "storageUrl"     TEXT,
  "sourceUrl"      TEXT,
  "platform"       "SocialPlatform",
  "metadata"       JSONB NOT NULL DEFAULT '{}',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GeneratedAsset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GeneratedAsset_companyId_createdAt_idx"
  ON "GeneratedAsset"("companyId", "createdAt");
CREATE INDEX "GeneratedAsset_contentDraftId_createdAt_idx"
  ON "GeneratedAsset"("contentDraftId", "createdAt");

ALTER TABLE "GeneratedAsset"
  ADD CONSTRAINT "GeneratedAsset_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull, not Cascade: deleting a draft must not destroy a graphic the user
-- may have reused on another post.
ALTER TABLE "GeneratedAsset"
  ADD CONSTRAINT "GeneratedAsset_contentDraftId_fkey"
  FOREIGN KEY ("contentDraftId") REFERENCES "ContentDraft"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GeneratedAsset"
  ADD CONSTRAINT "GeneratedAsset_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ContentMedia — the ordered media attachment layer
-- ---------------------------------------------------------------------------
CREATE TABLE "ContentMedia" (
  "id"             TEXT NOT NULL,
  "companyId"      TEXT NOT NULL,
  "contentDraftId" TEXT NOT NULL,
  "assetId"        TEXT NOT NULL,
  "kind"           "MediaKind" NOT NULL DEFAULT 'IMAGE',
  "position"       INTEGER NOT NULL DEFAULT 0,
  "altText"        TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContentMedia_pkey" PRIMARY KEY ("id")
);

-- Attaching the same graphic twice to one post is a no-op, not a duplicate.
CREATE UNIQUE INDEX "ContentMedia_contentDraftId_assetId_key"
  ON "ContentMedia"("contentDraftId", "assetId");
CREATE INDEX "ContentMedia_contentDraftId_position_idx"
  ON "ContentMedia"("contentDraftId", "position");
CREATE INDEX "ContentMedia_assetId_idx" ON "ContentMedia"("assetId");

ALTER TABLE "ContentMedia"
  ADD CONSTRAINT "ContentMedia_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContentMedia"
  ADD CONSTRAINT "ContentMedia_contentDraftId_fkey"
  FOREIGN KEY ("contentDraftId") REFERENCES "ContentDraft"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContentMedia"
  ADD CONSTRAINT "ContentMedia_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "GeneratedAsset"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Image generation runs on the existing background-job queue
-- ---------------------------------------------------------------------------
-- Several variations on a slow provider comfortably exceed a serverless
-- function budget run inline — the same failure GenerationJob was introduced to
-- solve for the trend digest and the monthly planner.
ALTER TYPE "GenerationJobKind" ADD VALUE IF NOT EXISTS 'IMAGE_GENERATION';
