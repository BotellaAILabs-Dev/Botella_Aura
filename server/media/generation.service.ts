import crypto from 'node:crypto';

import type { ContentDraft, ImageProvider } from '@prisma/client';

import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import { resolvePlatform, type AspectRatioKey } from '@/lib/platforms';
import type { ContentTypeKey } from '@/lib/validations/content';
import { resolveFormat } from '@/server/media/aspect';
import { resolveProvider, alternativeProviders } from '@/server/media/providers';
import {
  ImageProviderError,
  STYLE_DIRECTION,
  type GeneratedImage,
} from '@/server/media/types';
import type { ImageStyleKey } from '@/lib/graphics-ui';
import { validateImageBytes, MediaValidationError } from '@/server/media/validate';
import { putImage, activeStore } from '@/server/media/storage';
import {
  assetsForJob,
  createAsset,
  toAssetView,
  type AssetView,
} from '@/server/media/asset.service';

/**
 * The generation pipeline: prompt in, stored assets out.
 *
 * Order matters and each step exists for a reason:
 *   resolve provider -> resolve format -> generate -> validate bytes ->
 *   store -> persist row -> audit.
 *
 * Validation sits BEFORE storage because the cheapest place to reject a
 * provider's HTML error page is before it becomes a row in the database.
 * Storage sits before persistence because a row pointing at bytes that were
 * never written is worse than no row at all.
 *
 * Partial success is a real outcome and is reported as one: asking for four
 * variations and getting three is a good result, not a failure, so the caller
 * gets the assets it did produce plus a note about what did not land.
 */

/** Hard ceiling per request, independent of plan. Guards against a costly typo. */
export const MAX_VARIATIONS = 4;

export interface GenerateGraphicsArgs {
  draft: ContentDraft;
  /** Null when the run was resumed by the cron reaper rather than a person. */
  userId: string | null;
  prompt: string;
  negativePrompt?: string;
  provider?: ImageProvider | null;
  aspectRatio?: AspectRatioKey;
  /** Explicit dimensions from the "Custom" format; mapped to the nearest shape. */
  custom?: { width: number; height: number };
  style: ImageStyleKey;
  variations: number;
  /** The AI-written prompt, when the user edited it before generating. */
  originalPrompt?: string;
  /**
   * The background job this run belongs to.
   *
   * Stamped onto every asset produced, which is what makes a run RESUMABLE: a
   * job killed by a serverless timeout is retried, and without this the retry
   * would generate — and charge for — the images the first attempt had already
   * finished and stored.
   */
  jobId?: string;
}

export interface GenerateGraphicsResult {
  assets: AssetView[];
  provider: ImageProvider;
  model: string;
  aspectRatio: AspectRatioKey;
  /** Set when the requested ratio was not available on the chosen provider. */
  substitutedFrom?: AspectRatioKey;
  /** Human-readable note when fewer images came back than were asked for. */
  warning?: string;
  /** Other configured providers, so the UI can offer "try another model". */
  alternatives: Array<{ id: ImageProvider; label: string }>;
}

export async function generateGraphics(
  args: GenerateGraphicsArgs,
): Promise<GenerateGraphicsResult> {
  const { draft, userId, style } = args;

  const provider = resolveProvider(args.provider);
  const platform = resolvePlatform(
    draft.type as ContentTypeKey,
    draft.platform,
  );
  const format = resolveFormat({
    ...(args.aspectRatio ? { requested: args.aspectRatio } : {}),
    ...(args.custom ? { custom: args.custom } : {}),
    platform,
    providerRatios: provider.supportedRatios,
  });

  /**
   * What the user asked for, and what this provider can deliver, kept apart.
   *
   * These used to be collapsed into one number, and the shortfall warning at
   * the bottom compared the result against the ALREADY-CLAMPED figure — so a
   * provider capped at one image satisfied "1 of 1" and said nothing, while
   * the user who asked for four variations just got one and no explanation.
   * Comparing against the request is what makes a shortfall visible.
   */
  const requested = Math.min(Math.max(1, args.variations), MAX_VARIATIONS);
  const variations = Math.min(requested, provider.maxImagesPerRequest);

  /**
   * Resume, rather than restart.
   *
   * Images are persisted one at a time as they arrive, so a run killed on
   * image 3 of 4 leaves two real, paid-for assets behind. The job then retries
   * — and without this the retry would generate four MORE images and bill the
   * workspace twice for one click. So the retry only makes up the shortfall.
   */
  const alreadyDone = args.jobId
    ? await assetsForJob(draft.companyId, args.jobId)
    : [];
  const remaining = variations - alreadyDone.length;

  if (remaining <= 0) {
    // The previous attempt actually finished; it was only the bookkeeping that
    // was lost. Report what exists instead of spending again.
    logger.info('graphic generation: run already complete, resuming result', {
      draftId: draft.id,
      jobId: args.jobId,
      assets: alreadyDone.length,
    });
    return {
      assets: alreadyDone.map((a) => toAssetView(a)),
      provider: provider.id,
      model: provider.model,
      aspectRatio: format.ratio,
      alternatives: alternativeProviders(provider.id).map((p) => ({
        id: p.id,
        label: p.label,
      })),
    };
  }

  // The style is already reflected in the AI-written prompt, but a user who
  // edits the prompt by hand can strip it out. Appending the direction keeps
  // the style selector meaningful regardless of what they typed.
  const prompt = withStyleDirection(args.prompt, style);

  let images: GeneratedImage[];
  try {
    images = await provider.generateImage({
      prompt,
      ...(args.negativePrompt ? { negativePrompt: args.negativePrompt } : {}),
      aspectRatio: format.ratio,
      width: format.width,
      height: format.height,
      numberOfImages: remaining,
      style,
    });
  } catch (err) {
    await recordAudit({
      action: 'GRAPHIC_GENERATION_FAILED',
      userId,
      companyId: draft.companyId,
      metadata: {
        draftId: draft.id,
        provider: provider.id,
        reason: err instanceof Error ? err.message : 'unknown',
      },
    });
    throw err;
  }

  // Anything a previous attempt already produced counts towards the result.
  const assets: AssetView[] = alreadyDone.map((a) => toAssetView(a));
  const rejected: string[] = [];

  for (const image of images) {
    try {
      assets.push(
        await persistImage({
          image,
          draft,
          userId,
          providerId: provider.id,
          model: provider.model,
          prompt,
          ...(args.originalPrompt ? { originalPrompt: args.originalPrompt } : {}),
          ...(args.negativePrompt ? { negativePrompt: args.negativePrompt } : {}),
          ...(args.jobId ? { jobId: args.jobId } : {}),
          style,
          aspectRatio: format.ratio,
          platform,
        }),
      );
    } catch (err) {
      // One bad image out of four must not lose the other three.
      const reason =
        err instanceof MediaValidationError ? err.message : 'could not be stored';
      rejected.push(reason);
      logger.error('graphic generation: image rejected after generation', {
        draftId: draft.id,
        provider: provider.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (assets.length === 0) {
    await recordAudit({
      action: 'GRAPHIC_GENERATION_FAILED',
      userId,
      companyId: draft.companyId,
      metadata: { draftId: draft.id, provider: provider.id, reason: 'all images rejected' },
    });
    throw new ImageProviderError(
      provider.id,
      rejected[0] ??
        `${provider.label} returned images we could not read. Try another model.`,
      502,
    );
  }

  await recordAudit({
    action: 'GRAPHIC_GENERATED',
    userId,
    companyId: draft.companyId,
    metadata: {
      draftId: draft.id,
      provider: provider.id,
      model: provider.model,
      count: assets.length,
      requested: variations,
      // Non-zero means this run resumed an attempt that was interrupted, and
      // only paid for the shortfall. Worth being able to see in the audit trail.
      resumed: alreadyDone.length,
      aspectRatio: format.ratio,
      style,
      storage: activeStore(),
    },
  });

  return {
    assets,
    provider: provider.id,
    model: provider.model,
    aspectRatio: format.ratio,
    ...(format.substituted && format.requested
      ? { substitutedFrom: format.requested }
      : {}),
    ...(assets.length < requested
      ? {
          warning: `${provider.label} returned ${assets.length} of ${requested} images. ${
            assets.length < requested && variations < requested
              ? `This model produces up to ${provider.maxImagesPerRequest} per request.`
              : (rejected[0] ?? '')
          }`.trim(),
        }
      : {}),
    alternatives: alternativeProviders(provider.id).map((p) => ({
      id: p.id,
      label: p.label,
    })),
  };
}

/** Validate, store and persist one image. Throws if it cannot be kept. */
async function persistImage(args: {
  image: GeneratedImage;
  draft: ContentDraft;
  userId: string | null;
  providerId: ImageProvider;
  model: string;
  prompt: string;
  originalPrompt?: string;
  negativePrompt?: string;
  jobId?: string;
  style: ImageStyleKey;
  aspectRatio: AspectRatioKey;
  platform: ReturnType<typeof resolvePlatform>;
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
      // Stamped so a retried job can tell which images it already paid for.
      ...(args.jobId ? { jobId: args.jobId } : {}),
    } as object,
  });

  return toAssetView(asset);
}

function withStyleDirection(prompt: string, style: ImageStyleKey): string {
  const direction = STYLE_DIRECTION[style];
  if (prompt.toLowerCase().includes(direction.slice(0, 24).toLowerCase())) {
    return prompt;
  }
  return `${prompt}\n\nStyle: ${direction}`;
}

/**
 * A cuid-shaped id generated here rather than by the database.
 *
 * Prisma's @default(cuid()) runs at insert time, but the object key has to
 * exist before the upload — so the id is minted first and passed to both.
 * Format matches Prisma's own (a 'c' prefix, timestamp, then randomness) so
 * ids stay visually consistent across tables.
 */
function cuidLike(): string {
  const time = Date.now().toString(36);
  return `c${time}${crypto.randomBytes(9).toString('base64url').toLowerCase()}`;
}
