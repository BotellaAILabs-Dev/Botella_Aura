import crypto from 'node:crypto';
import type { ContentDraft, ImageProvider } from '@prisma/client';

import type { AspectRatioKey } from '@/lib/platforms';
import type { resolvePlatform } from '@/lib/platforms';
import { createAsset, toAssetView, type AssetView } from '@/server/media/asset.service';
import { putImage } from '@/server/media/storage';
import type { GeneratedImage } from '@/server/media/types';
import { validateImageBytes } from '@/server/media/validate';

/**
 * Validate, store and persist one image. Throws if it cannot be kept.
 *
 * Shared by generation, refinement and logo placement, so every image —
 * whatever made it — goes through the same byte validation and storage.
 */
export async function persistImage(args: {
  image: GeneratedImage;
  draft: Pick<ContentDraft, 'id' | 'companyId'>;
  userId: string | null;
  providerId: ImageProvider;
  model: string;
  prompt: string;
  originalPrompt?: string;
  negativePrompt?: string;
  jobId?: string;
  style: string | null;
  aspectRatio: AspectRatioKey | string;
  platform: ReturnType<typeof resolvePlatform> | null;
  /** Variant lineage, logo state and the like (lib/image-variants.ts). */
  metadata?: Record<string, unknown>;
}): Promise<AssetView> {
  const validated = validateImageBytes(args.image.data, {
    width: args.image.width,
    height: args.image.height,
  });

  // The id is minted before the upload so the object key and the row key match,
  // which is what makes an orphaned object identifiable later.
  const assetId = cuidLike();
  const stored = await putImage({
    companyId: args.draft.companyId,
    assetId,
    data: args.image.data,
    mimeType: validated.mimeType,
  });

  const asset = await createAsset({
    id: assetId,
    companyId: args.draft.companyId,
    contentDraftId: args.draft.id,
    createdById: args.userId ?? null,
    provider: args.providerId,
    model: args.model,
    kind: 'IMAGE',
    prompt: args.prompt,
    originalPrompt: args.originalPrompt ?? null,
    revisedPrompt: args.image.revisedPrompt ?? null,
    negativePrompt: args.negativePrompt ?? null,
    style: args.style,
    aspectRatio: args.aspectRatio,
    width: validated.width,
    height: validated.height,
    mimeType: validated.mimeType,
    fileSize: validated.fileSize,
    storage: stored.storage,
    data: stored.data ?? null,
    storageUrl: stored.storageUrl ?? null,
    sourceUrl: args.image.sourceUrl ?? null,
    platform: args.platform,
    metadata: {
      ...(args.image.metadata ?? {}),
      ...(args.metadata ?? {}),
      // Stamped so a retried job can tell which images it already paid for.
      ...(args.jobId ? { jobId: args.jobId } : {}),
    } as object,
  });

  return toAssetView(asset);
}

/**
 * A cuid-shaped id generated here rather than by the database.
 *
 * Prisma's @default(cuid()) runs at insert time, but the object key has to
 * exist before the upload — so the id is minted first and passed to both.
 * Format matches Prisma's own (a 'c' prefix, timestamp, then randomness) so
 * ids stay visually consistent across tables.
 */
export function cuidLike(): string {
  const time = Date.now().toString(36);
  return `c${time}${crypto.randomBytes(9).toString('base64url').toLowerCase()}`;
}
