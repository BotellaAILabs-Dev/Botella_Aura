-- Hugging Face joins the image-provider registry.
--
-- GeneratedAsset.provider is an enum column, so a provider cannot be offered in
-- the Content Studio until its value exists here: the row written after a
-- successful generation would fail to insert.
--
-- Additive only: adding a value to an enum cannot invalidate existing rows, and
-- IF NOT EXISTS makes re-running this a no-op.
ALTER TYPE "ImageProvider" ADD VALUE IF NOT EXISTS 'HUGGINGFACE';
