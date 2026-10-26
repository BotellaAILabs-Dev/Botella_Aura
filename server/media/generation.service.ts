
import type { ContentDraft, ImageProvider } from '@prisma/client';

import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import { resolvePlatform, type AspectRatioKey } from '@/lib/platforms';
import type { ContentTypeKey } from '@/lib/validations/content';
import { resolveFormat } from '@/server/media/aspect';
import { visualBriefForDraft } from '@/server/media/visual-brief.service';
import { resolveProvider, alternativeProviders } from '@/server/media/providers';
import {
  ImageProviderError,
  STYLE_DIRECTION,
  type GeneratedImage,
} from '@/server/media/types';
import type { ImageStyleKey } from '@/lib/graphics-ui';
import { MediaValidationError } from '@/server/media/validate';
import { activeStore } from '@/server/media/storage';
import {
  assetsForJob,
  toAssetView,
  type AssetView,
} from '@/server/media/asset.service';
import { persistImage } from '@/server/media/persist';
import { logoSpaceInstruction, type LogoMode, type LogoPosition, type LogoTint } from '@/lib/image-variants';

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
  /**
   * The logo setting for these images (lib/image-variants.ts). "include" and
   * "space" ask for clean space in a corner; "include" then places the exact
   * uploaded logo there. Absent: as before — no logo, no reserved space.
   */
  logo?: { mode: LogoMode; position: LogoPosition; tint?: LogoTint };
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
  // No shape asked for: the one the visual brief names for this format and
  // channel (lib/visual-brief.ts), rather than the network's default alone.
  const briefRatio =
    args.aspectRatio || args.custom
      ? null
      : (await visualBriefForDraft(draft, platform)).brief.format.aspectRatio;
  const format = resolveFormat({
    ...(args.aspectRatio
      ? { requested: args.aspectRatio }
      : briefRatio
        ? { requested: briefRatio }
        : {}),
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
  const styled = withStyleDirection(args.prompt, style);
  // Room for a logo, never a drawn one (the real file is placed afterwards).
  const prompt =
    args.logo && args.logo.mode !== 'none'
      ? `${styled}\n\n${logoSpaceInstruction(args.logo.position)}`
      : styled;

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
      const stored = await persistImage({
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
          ...(args.logo
            ? { metadata: { logo: { mode: args.logo.mode, position: args.logo.position, applied: false, reason: null, tint: args.logo.tint ?? 'original' } } }
            : {}),
        });
      // "Include logo": the exact uploaded logo goes on as the image's next
      // version; the logo-free one is kept (hidden) for refinements.
      if (args.logo?.mode === 'include') {
        const { placeLogoOn } = await import('@/server/media/variant.service');
        assets.push(await placeLogoOn({ draft, userId, assetId: stored.id, position: args.logo.position, ...(args.logo.tint ? { tint: args.logo.tint } : {}), hideSource: true }));
      } else {
        assets.push(stored);
      }
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

function withStyleDirection(prompt: string, style: ImageStyleKey): string {
  const direction = STYLE_DIRECTION[style];
  if (prompt.toLowerCase().includes(direction.slice(0, 24).toLowerCase())) {
    return prompt;
  }
  return `${prompt}\n\nStyle: ${direction}`;
}

