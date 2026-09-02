-- Media handling: user-supplied graphics (upload + remote URL)
--
-- A graphic the user supplies themselves goes through the SAME pipeline as a
-- generated one — validate bytes, store, attach, validate per platform,
-- publish — so it is the same model with a different origin, not a new one.
-- Additive: no existing row or column changes.
ALTER TYPE "ImageProvider" ADD VALUE IF NOT EXISTS 'UPLOAD';
