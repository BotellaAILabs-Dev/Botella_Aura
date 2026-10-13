import type { GeneratedAsset, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { recordContentChange } from '@/server/approval/approval.service';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import { assetFileUrl } from '@/server/media/asset-url';
import { deleteExternal, fetchExternal } from '@/server/media/storage';
import { validateForPlatform } from '@/server/media/validate';
import { resolvePlatform, type SocialPlatformKey } from '@/lib/platforms';
import type { ContentTypeKey } from '@/lib/validations/content';

/**
 * Generated-asset persistence, retrieval and attachment.
 *
 * Every read here is company-scoped. That is the ownership guarantee: an asset
 * id is a cuid, but guessing one must still not be enough to see somebody
 * else's graphic, so the companyId is part of every WHERE clause rather than
 * something checked afterwards.
 */

export class AssetNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('That graphic was not found.');
    this.name = 'AssetNotFoundError';
  }
}

/**
 * An asset without its bytes.
 *
 * Named explicitly rather than cast away, because the distinction is load-
 * bearing: everything except the file route works from this, and a function
 * that accidentally takes the full row pulls megabytes per image into memory.
 */
export type AssetSummary = Omit<GeneratedAsset, 'data'>;

/**
 * The client-facing shape of an asset.
 *
 * Deliberately WITHOUT `data`: the bytes are served by a dedicated route, so a
 * history listing of twelve graphics stays a small JSON response instead of
 * twenty megabytes of base64.
 */
export interface AssetView {
  id: string;
  url: string;
  provider: string;
  model: string;
  prompt: string;
  originalPrompt: string | null;
  revisedPrompt: string | null;
  style: string | null;
  aspectRatio: string;
  width: number;
  height: number;
  mimeType: string;
  fileSize: number;
  platform: string | null;
  contentDraftId: string | null;
  createdAt: string;
  /** True when this asset is attached to the draft currently being viewed. */
  attached: boolean;
  /**
   * A composed marketing creative (server/media/creative): its design, and
   * whether it was made without an AI photograph. Null for plain images.
   */
  creative: {
    type: string;
    layout: string;
    headline: string;
    photoAssetId: string | null;
    /** No AI photo — a brand-colour background (labelled as such). */
    fallback: boolean;
    fallbackReason: string | null;
  } | null;
}

export function toAssetView(
  asset: AssetSummary,
  attachedAssetIds: ReadonlySet<string> = new Set(),
): AssetView {
  return {
    id: asset.id,
    url: assetFileUrl(asset.id),
    provider: asset.provider,
    model: asset.model,
    prompt: asset.prompt,
    originalPrompt: asset.originalPrompt,
    revisedPrompt: asset.revisedPrompt,
    style: asset.style,
    aspectRatio: asset.aspectRatio,
    width: asset.width,
    height: asset.height,
    mimeType: asset.mimeType,
    fileSize: asset.fileSize,
    platform: asset.platform,
    contentDraftId: asset.contentDraftId,
    createdAt: asset.createdAt.toISOString(),
    attached: attachedAssetIds.has(asset.id),
    creative: creativeOf(asset.metadata),
  };
}

function creativeOf(metadata: unknown): AssetView['creative'] {
  const m = (metadata ?? {}) as {
    kind?: string;
    spec?: { type?: string; layout?: string; text?: { headline?: string }; photo?: { assetId?: string | null; fallback?: boolean; fallbackReason?: string | null } };
  };
  if (m.kind !== 'creative' || !m.spec) return null;
  return {
    type: m.spec.type ?? 'brand_awareness',
    layout: m.spec.layout ?? 'hero',
    headline: m.spec.text?.headline ?? '',
    photoAssetId: m.spec.photo?.assetId ?? null,
    fallback: Boolean(m.spec.photo?.fallback),
    fallbackReason: m.spec.photo?.fallbackReason ?? null,
  };
}

/** One asset, scoped to the company. Includes bytes — callers that only need
 *  metadata should use `listAssets`. */
export async function getAsset(
  companyId: string,
  assetId: string,
): Promise<GeneratedAsset> {
  const asset = await db.generatedAsset.findFirst({
    where: { id: assetId, companyId },
  });
  if (!asset) throw new AssetNotFoundError();
  return asset;
}

/**
 * Read an asset's bytes, wherever they live.
 *
 * Callers do not need to know which store was in use when the asset was made,
 * which is what lets a deployment switch to a bucket without stranding the
 * images generated before the switch.
 */
export async function readAssetBytes(
  asset: GeneratedAsset,
): Promise<Buffer | null> {
  if (asset.storage === 'DATABASE') {
    return asset.data ? Buffer.from(asset.data) : null;
  }
  if (!asset.storageUrl) return null;
  return fetchExternal(asset.storageUrl);
}

export interface ListAssetsOptions {
  /** Restrict to graphics generated for one draft. */
  draftId?: string;
  limit?: number;
}

/**
 * Graphic history, newest first.
 *
 * `select` omits `data` on purpose — see AssetView. Prisma would otherwise pull
 * every image's bytes into memory to build a gallery that only needs URLs.
 */
export async function listAssets(
  companyId: string,
  options: ListAssetsOptions = {},
): Promise<AssetSummary[]> {
  return db.generatedAsset.findMany({
    where: {
      companyId,
      ...(options.draftId ? { contentDraftId: options.draftId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(options.limit ?? 60, 200),
    // Everything except `data`, which is fetched only by the file route.
    select: ASSET_SUMMARY_SELECT,
  });
}

/** Asset ids currently attached to a draft — drives the "attached" flag. */
export async function attachedAssetIds(
  companyId: string,
  draftId: string,
): Promise<Set<string>> {
  const rows = await db.contentMedia.findMany({
    where: { companyId, contentDraftId: draftId },
    select: { assetId: true },
  });
  return new Set(rows.map((r) => r.assetId));
}

export interface AttachedMedia {
  id: string;
  assetId: string;
  position: number;
  altText: string | null;
  url: string;
  width: number;
  height: number;
  mimeType: string;
  fileSize: number;
  aspectRatio: string;
  /** Platform problems with this specific image, empty when it is fine. */
  problems: string[];
}

/**
 * Media attached to a draft, in order, each checked against the platform it
 * will actually be published to.
 *
 * The check happens on read rather than only on attach because the target
 * platform can change after attachment — switching a post from LinkedIn to
 * Instagram can invalidate an image that was fine a moment ago, and the user
 * needs to see that in the composer rather than at publish time.
 */
export async function getAttachedMedia(args: {
  companyId: string;
  draftId: string;
  type: ContentTypeKey;
  platform: SocialPlatformKey | null;
}): Promise<AttachedMedia[]> {
  const rows = await db.contentMedia.findMany({
    where: { companyId: args.companyId, contentDraftId: args.draftId },
    orderBy: { position: 'asc' },
    include: {
      asset: {
        select: {
          id: true,
          width: true,
          height: true,
          mimeType: true,
          fileSize: true,
          aspectRatio: true,
        },
      },
    },
  });

  const platform = resolvePlatform(args.type, args.platform);
  return rows.map((row) => ({
    id: row.id,
    assetId: row.assetId,
    position: row.position,
    altText: row.altText,
    url: assetFileUrl(row.assetId),
    width: row.asset.width,
    height: row.asset.height,
    mimeType: row.asset.mimeType,
    fileSize: row.asset.fileSize,
    aspectRatio: row.asset.aspectRatio,
    problems: validateForPlatform(row.asset, platform).problems,
  }));
}

/**
 * Attach a graphic to a post.
 *
 * `replace` is the normal path for a single-image post: picking a new graphic
 * means swapping, not accumulating. Carousels pass replace: false and get an
 * appended, ordered set.
 */
export async function attachAsset(args: {
  companyId: string;
  /** Null when Autopilot attached it unattended — audit userId is nullable. */
  userId: string | null;
  draftId: string;
  assetId: string;
  altText?: string;
  replace?: boolean;
}): Promise<void> {
  const { companyId, userId, draftId, assetId, altText, replace = true } = args;

  // Both sides must belong to the caller's company before anything is written.
  const [draft, asset] = await Promise.all([
    db.contentDraft.findFirst({
      where: { id: draftId, companyId },
      select: { id: true, status: true },
    }),
    db.generatedAsset.findFirst({
      where: { id: assetId, companyId },
      select: { id: true, kind: true },
    }),
  ]);
  if (!draft) {
    throw Object.assign(new Error('Draft not found.'), { status: 404 });
  }
  if (!asset) throw new AssetNotFoundError();
  if (draft.status === 'PUBLISHED') {
    throw Object.assign(
      new Error('This post is already published — its media cannot change.'),
      { status: 409 },
    );
  }

  // Recorded on the draft's approval (lib/approval.ts): images are part of
  // what an approval covers, so swapping one on approved work reopens it.
  const before = await db.contentMedia.findMany({
    where: { companyId, contentDraftId: draftId },
    orderBy: { position: 'asc' },
    select: { assetId: true },
  });
  const { reopened } = await recordContentChange({
    draftId,
    companyId,
    by: userId,
    action: 'media_changed',
    previous: { media: before.map((m) => m.assetId) },
    apply: async (tx) => {
    if (replace) {
      await tx.contentMedia.deleteMany({
        where: { companyId, contentDraftId: draftId },
      });
    }
    const position = replace
      ? 0
      : await tx.contentMedia.count({
          where: { companyId, contentDraftId: draftId },
        });

    await tx.contentMedia.upsert({
      where: { contentDraftId_assetId: { contentDraftId: draftId, assetId } },
      create: {
        companyId,
        contentDraftId: draftId,
        assetId,
        kind: asset.kind,
        position,
        altText: altText ?? null,
      },
      update: { altText: altText ?? null },
    });
    },
  });

  await recordAudit({
    action: 'GRAPHIC_ATTACHED',
    userId,
    companyId,
    metadata: { draftId, assetId, replace, ...(reopened ? { reopenedApproval: true } : {}) },
  });
}

export async function detachAsset(args: {
  companyId: string;
  userId: string;
  draftId: string;
  assetId: string;
}): Promise<void> {
  const { companyId, userId, draftId, assetId } = args;
  let count = 0;
  await recordContentChange({
    draftId,
    companyId,
    by: userId,
    action: 'media_changed',
    previous: { media: [assetId] },
    apply: async (tx) => {
      ({ count } = await tx.contentMedia.deleteMany({
        where: { companyId, contentDraftId: draftId, assetId },
      }));
    },
  });
  if (count === 0) {
    throw Object.assign(new Error('That graphic is not attached to this post.'), {
      status: 404,
    });
  }
  await recordAudit({
    action: 'GRAPHIC_DETACHED',
    userId,
    companyId,
    metadata: { draftId, assetId },
  });
}

/**
 * Delete a graphic permanently.
 *
 * Refuses when the asset is attached to a post that has already been published:
 * the record of what actually went out must stay intact. Bucket cleanup is
 * best-effort — a stranded object costs pennies, a failed delete costs trust.
 */
export async function deleteAsset(args: {
  companyId: string;
  userId: string;
  assetId: string;
}): Promise<void> {
  const { companyId, userId, assetId } = args;
  const asset = await getAsset(companyId, assetId);

  const publishedUse = await db.contentMedia.findFirst({
    where: {
      companyId,
      assetId,
      contentDraft: { status: 'PUBLISHED' },
    },
    select: { id: true },
  });
  if (publishedUse) {
    throw Object.assign(
      new Error(
        'This graphic is part of a published post, so it cannot be deleted.',
      ),
      { status: 409 },
    );
  }

  await db.generatedAsset.delete({ where: { id: asset.id } });
  if (asset.storage === 'EXTERNAL' && asset.storageUrl) {
    await deleteExternal(asset.storageUrl).catch((err) => {
      logger.warn('asset delete: bucket cleanup failed', {
        assetId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  await recordAudit({
    action: 'GRAPHIC_DELETED',
    userId,
    companyId,
    metadata: { assetId },
  });
}

/**
 * Graphics a given background job already produced.
 *
 * This is what makes a generation run resumable. Assets are persisted one at a
 * time as they arrive, so a job killed by a serverless timeout leaves real,
 * already-paid-for images behind. On retry the runner asks this what exists and
 * generates only the shortfall, instead of billing the workspace twice for one
 * click.
 */
export async function assetsForJob(
  companyId: string,
  jobId: string,
): Promise<AssetSummary[]> {
  return db.generatedAsset.findMany({
    where: {
      companyId,
      // JSON path filter — the runner stamps metadata.jobId on every asset.
      metadata: { path: ['jobId'], equals: jobId },
    },
    orderBy: { createdAt: 'asc' },
    select: ASSET_SUMMARY_SELECT,
  });
}

/** Graphics generated this calendar month — the number cost control acts on. */
export async function assetsThisMonth(companyId: string): Promise<number> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const where = { companyId, createdAt: { gte: monthStart } };
  // A composed creative is a layout over a photo already counted (or the
  // brand's own colours) — re-setting its text spends no generation. Counted
  // as total minus creatives: a NOT on a JSON path would also drop every
  // asset that has no "kind" at all (NULL in SQL), i.e. all of them.
  const [all, creatives] = await Promise.all([
    db.generatedAsset.count({ where }),
    db.generatedAsset.count({
      where: { ...where, metadata: { path: ['kind'], equals: 'creative' } },
    }),
  ]);
  return all - creatives;
}

/**
 * Persist one generated image.
 *
 * The `select` matters: without it Prisma returns the inserted row including
 * the bytes it was just handed, which round-trips a megabyte-plus back from
 * Postgres for a value the caller already has and immediately discards.
 */
export async function createAsset(
  data: Prisma.GeneratedAssetUncheckedCreateInput,
): Promise<AssetSummary> {
  return db.generatedAsset.create({ data, select: ASSET_SUMMARY_SELECT });
}

/**
 * Every column except `data`. Shared by createAsset and listAssets.
 *
 * `satisfies` rather than a plain annotation: it checks the field names against
 * the model (so a schema rename fails the build here) while keeping the literal
 * `true` types Prisma needs to infer a precise return type.
 */
const ASSET_SUMMARY_SELECT = {
  id: true,
  companyId: true,
  contentDraftId: true,
  createdById: true,
  provider: true,
  model: true,
  kind: true,
  prompt: true,
  originalPrompt: true,
  revisedPrompt: true,
  negativePrompt: true,
  style: true,
  aspectRatio: true,
  width: true,
  height: true,
  mimeType: true,
  fileSize: true,
  storage: true,
  storageUrl: true,
  sourceUrl: true,
  platform: true,
  metadata: true,
  createdAt: true,
} satisfies Prisma.GeneratedAssetSelect;
