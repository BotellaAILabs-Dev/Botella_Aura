import type { ContentDraft, GeneratedAsset, ImageProvider, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  isHiddenAsset,
  logoOf,
  logoSpaceInstruction,
  makeSpaceInstruction,
  refinePrompt,
  variantOf,
  type LogoMode,
  type LogoPosition,
  type VariantAction,
} from '@/lib/image-variants';
import { ASPECT_RATIOS, type AspectRatioKey } from '@/lib/platforms';
import { getAsset, readAssetBytes, toAssetView, type AssetView } from '@/server/media/asset.service';
import { LogoOverlayError, overlayLogo } from '@/server/media/logo-overlay';
import { persistImage } from '@/server/media/persist';
import { resolveEditProvider, resolveProvider } from '@/server/media/providers';
import { ImageProviderError } from '@/server/media/types';
import { recordAudit } from '@/server/services/audit.service';

/**
 * Per-variant image work (lib/image-variants.ts holds the rules): refine one
 * image with a single instruction, regenerate one variant, change one
 * variant's logo setting. Each makes a NEW version of that variant — no
 * image is ever modified or deleted, other variants are not touched, and the
 * post's text is never involved.
 */

export class VariantError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'VariantError';
  }
}

const ratioOf = (r: string): AspectRatioKey =>
  ((ASPECT_RATIOS as readonly string[]).includes(r) ? r : '1:1') as AspectRatioKey;

const isCreative = (a: Pick<GeneratedAsset, 'metadata'>) => (a.metadata as { kind?: string } | null)?.kind === 'creative';

/** The asset, checked to belong to this post. */
async function ownAsset(draft: ContentDraft, assetId: string): Promise<GeneratedAsset> {
  const asset = await getAsset(draft.companyId, assetId);
  if (asset.contentDraftId !== draft.id) {
    throw new VariantError('Open the post this image was made for to change it.');
  }
  if (asset.kind !== 'IMAGE') throw new VariantError('Only images can be refined.');
  return asset;
}

/** The next version number in this variant. */
async function nextVersion(draft: ContentDraft, rootId: string): Promise<number> {
  const rows = await db.generatedAsset.findMany({
    where: { companyId: draft.companyId, contentDraftId: draft.id, metadata: { path: ['variant', 'rootId'], equals: rootId } },
    select: { metadata: true },
  });
  return rows.reduce((max, r) => Math.max(max, variantOf('', r.metadata).version), 1) + 1;
}

function lineage(asset: GeneratedAsset, version: number, action: VariantAction, instruction: string | null) {
  const parent = variantOf(asset.id, asset.metadata);
  return { variant: { rootId: parent.rootId, parentId: asset.id, version, action, instruction } };
}

/** The logo-free image behind an asset (itself, unless a logo was placed on it). */
async function cleanSource(draft: ContentDraft, asset: GeneratedAsset): Promise<GeneratedAsset> {
  const cleanId = (asset.metadata as { cleanId?: unknown } | null)?.cleanId;
  if (typeof cleanId === 'string') {
    const clean = await db.generatedAsset.findFirst({ where: { id: cleanId, companyId: draft.companyId } });
    if (clean) return clean;
  }
  return asset;
}

async function bytesOf(asset: GeneratedAsset): Promise<Buffer> {
  const data = await readAssetBytes(asset);
  if (!data) throw new VariantError('This image’s file could not be read.', 409);
  return data;
}

/** The brand's uploaded logo file, or why it cannot be used. */
async function brandLogo(companyId: string): Promise<{ data: Buffer } | { reason: string }> {
  const { loadBrand } = await import('@/server/media/creative/creative.service');
  const brand = await loadBrand(companyId);
  if (!brand.logoAssetId) {
    return {
      reason: brand.logoUrl
        ? 'Your logo is only a link, not an uploaded file. Upload the logo file in Settings → Brand to place it exactly.'
        : 'No logo uploaded yet. Upload it in Settings → Brand, or choose “No logo” or “Add logo later”.',
    };
  }
  const logo = await db.generatedAsset.findFirst({ where: { id: brand.logoAssetId, companyId } });
  const data = logo ? await readAssetBytes(logo) : null;
  return data ? { data } : { reason: 'Your logo file could not be read. Upload it again in Settings → Brand.' };
}

/** Record the logo state on an asset without making a new version. */
async function noteLogo(asset: GeneratedAsset, logo: { mode: LogoMode; position: LogoPosition; applied: boolean; reason: string | null }) {
  const updated = await db.generatedAsset.update({
    where: { id: asset.id },
    data: { metadata: { ...((asset.metadata ?? {}) as object), logo } as Prisma.InputJsonObject },
  });
  return toAssetView(updated);
}

/**
 * Place the exact logo on an image, as the variant's next version. `source`
 * is the logo-free image; with `hideSource` (a fresh generation the person
 * never saw without its logo) it is kept but not listed.
 */
export async function placeLogoOn(args: {
  draft: ContentDraft;
  userId: string | null;
  assetId: string;
  position: LogoPosition;
  hideSource?: boolean;
}): Promise<AssetView> {
  const source = await getAsset(args.draft.companyId, args.assetId);
  const logo = await brandLogo(args.draft.companyId);
  if ('reason' in logo) {
    return noteLogo(source, { mode: 'include', position: args.position, applied: false, reason: logo.reason });
  }
  let placed;
  try {
    placed = await overlayLogo({ image: await bytesOf(source), logo: logo.data, position: args.position });
  } catch (err) {
    const reason = err instanceof LogoOverlayError ? err.message : 'The logo could not be placed on this image.';
    logger.warn('logo overlay failed', { assetId: source.id, error: err instanceof Error ? err.message : String(err) });
    return noteLogo(source, { mode: 'include', position: args.position, applied: false, reason });
  }
  const variant = variantOf(source.id, source.metadata);
  const version = await nextVersion(args.draft, variant.rootId);
  const view = await persistImage({
    image: { data: placed.data, mimeType: placed.mimeType, width: placed.width, height: placed.height },
    draft: args.draft,
    userId: args.userId,
    providerId: source.provider,
    model: source.model,
    prompt: source.prompt,
    style: source.style,
    aspectRatio: source.aspectRatio,
    platform: source.platform,
    metadata: {
      ...lineage(source, version, 'logo', null),
      logo: { mode: 'include', position: args.position, applied: true, reason: null, box: placed.box },
      cleanId: source.id,
    },
  });
  if (args.hideSource) {
    await db.generatedAsset.update({
      where: { id: source.id },
      data: { metadata: { ...((source.metadata ?? {}) as object), hidden: true } as Prisma.InputJsonObject },
    });
  }
  return view;
}

/** Store an image as the next version of `from`'s variant, then apply its logo setting. */
async function storeVersion(args: {
  draft: ContentDraft;
  userId: string | null;
  from: GeneratedAsset;
  image: { data: Buffer; mimeType: string; width: number; height: number; metadata?: Record<string, unknown> };
  providerId: ImageProvider;
  model: string;
  prompt: string;
  action: VariantAction;
  instruction: string | null;
  logo: { mode: LogoMode; position: LogoPosition } | null;
  jobId?: string;
}): Promise<AssetView> {
  const variant = variantOf(args.from.id, args.from.metadata);
  const version = await nextVersion(args.draft, variant.rootId);
  const stored = await persistImage({
    image: args.image,
    draft: args.draft,
    userId: args.userId,
    providerId: args.providerId,
    model: args.model,
    prompt: args.prompt,
    style: args.from.style,
    aspectRatio: args.from.aspectRatio,
    platform: args.from.platform,
    ...(args.jobId ? { jobId: args.jobId } : {}),
    metadata: {
      ...lineage(args.from, version, args.action, args.instruction),
      ...(args.logo ? { logo: { ...args.logo, applied: false, reason: null } } : {}),
    },
  });
  if (args.logo?.mode === 'include') {
    return placeLogoOn({ draft: args.draft, userId: args.userId, assetId: stored.id, position: args.logo.position, hideSource: true });
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Refine with one instruction
// ---------------------------------------------------------------------------

export async function refineVariant(args: {
  draft: ContentDraft;
  userId: string | null;
  assetId: string;
  instruction: string;
  /** "Add logo later" on an existing image: make room, then mark it. */
  makeSpace?: LogoPosition;
  jobId?: string;
}): Promise<AssetView> {
  const asset = await ownAsset(args.draft, args.assetId);
  if (isCreative(asset)) return refineCreative({ ...args, asset });

  const current = logoOf(asset.metadata);
  const logo = args.makeSpace
    ? { mode: 'space' as const, position: args.makeSpace }
    : current
      ? { mode: current.mode, position: current.position }
      : null;
  const instruction = args.makeSpace ? makeSpaceInstruction(args.makeSpace) : args.instruction.trim();
  if (!instruction) throw new VariantError('Describe the change you want.');

  const provider = resolveEditProvider(asset.provider);
  if (!provider?.editImage) {
    throw new VariantError(
      'No configured image model can edit images. Set GOOGLE_AI_API_KEY (Gemini image models) or OPENAI_API_KEY (gpt-image-1) to refine images.',
      503,
    );
  }
  // Refined from the logo-free copy, so the model never sees — or redraws — the logo.
  const source = await cleanSource(args.draft, asset);
  const edited = await provider.editImage({
    image: { data: await bytesOf(source), mimeType: source.mimeType },
    prompt: refinePrompt({ instruction, logo: logo?.mode ?? null, position: logo?.position ?? 'bottom-right' }),
    aspectRatio: ratioOf(asset.aspectRatio),
    width: asset.width,
    height: asset.height,
  });
  const view = await storeVersion({
    draft: args.draft,
    userId: args.userId,
    from: asset,
    image: edited,
    providerId: provider.id,
    model: provider.model,
    prompt: `${source.prompt}\n\nRefined: ${instruction}`.slice(0, 4000),
    action: 'refined',
    instruction: args.makeSpace ? 'Make room for a logo' : instruction,
    logo,
    ...(args.jobId ? { jobId: args.jobId } : {}),
  });
  await recordAudit({
    action: 'GRAPHIC_GENERATED',
    userId: args.userId,
    companyId: args.draft.companyId,
    metadata: { draftId: args.draft.id, refined: true, from: asset.id, provider: provider.id, makeSpace: Boolean(args.makeSpace) },
  });
  return view;
}

/**
 * A creative is a design over a photograph: the PHOTO is refined, then the
 * design (text, logo, layout) is put back on exactly as it was — the model
 * never touches the words or the logo.
 */
async function refineCreative(args: {
  draft: ContentDraft;
  userId: string | null;
  asset: GeneratedAsset;
  instruction: string;
  makeSpace?: LogoPosition;
  jobId?: string;
}): Promise<AssetView> {
  const { specOf, composeAndStore } = await import('@/server/media/creative/creative.service');
  const spec = specOf(args.asset.metadata);
  if (!spec) throw new VariantError('This creative’s design could not be read.', 409);
  if (args.makeSpace) {
    throw new VariantError('A creative places the logo in its own layout — choose “Add logo later” in the creative settings instead.');
  }
  if (!spec.photo.assetId) {
    throw new VariantError('This creative has no photograph to refine (it uses a brand background). Generate a new photo first.');
  }
  const photo = await refineVariant({
    draft: args.draft,
    userId: args.userId,
    assetId: spec.photo.assetId,
    instruction: args.instruction,
    ...(args.jobId ? { jobId: args.jobId } : {}),
  });
  const variant = variantOf(args.asset.id, args.asset.metadata);
  const version = await nextVersion(args.draft, variant.rootId);
  const result = await composeAndStore({
    draft: args.draft,
    userId: args.userId,
    spec: { ...spec, photo: { ...spec.photo, assetId: photo.id } },
    ...(args.jobId ? { jobId: args.jobId } : {}),
  });
  const row = await db.generatedAsset.findFirstOrThrow({ where: { id: result.asset.id } });
  const updated = await db.generatedAsset.update({
    where: { id: row.id },
    data: {
      metadata: {
        ...((row.metadata ?? {}) as object),
        ...lineage(args.asset, version, 'refined', args.instruction.trim()),
      } as Prisma.InputJsonObject,
    },
  });
  return toAssetView(updated);
}

// ---------------------------------------------------------------------------
// Regenerate one variant
// ---------------------------------------------------------------------------

export async function regenerateVariant(args: {
  draft: ContentDraft;
  userId: string | null;
  assetId: string;
  jobId?: string;
}): Promise<AssetView> {
  const asset = await ownAsset(args.draft, args.assetId);
  if (isCreative(asset)) {
    throw new VariantError('Use “New photo, keep text” in the creative studio to regenerate a creative.');
  }
  const variant = variantOf(asset.id, asset.metadata);
  const root = (await db.generatedAsset.findFirst({ where: { id: variant.rootId, companyId: args.draft.companyId } })) ?? asset;
  const current = logoOf(asset.metadata);
  const logo = current ? { mode: current.mode, position: current.position } : null;
  if (root.provider === 'UPLOAD') throw new VariantError('An uploaded image cannot be regenerated — refine it instead.');

  const provider = resolveProvider(root.provider);
  const basePrompt = root.prompt.split('\n\nRefined:')[0]!;
  const prompt =
    logo && logo.mode !== 'none' && !basePrompt.includes('Composition: keep the')
      ? `${basePrompt}\n\n${logoSpaceInstruction(logo.position)}`
      : basePrompt;
  const [image] = await provider.generateImage({
    prompt,
    ...(root.negativePrompt ? { negativePrompt: root.negativePrompt } : {}),
    aspectRatio: ratioOf(root.aspectRatio),
    width: root.width,
    height: root.height,
    numberOfImages: 1,
    ...(root.style ? { style: root.style } : {}),
  });
  if (!image) throw new ImageProviderError(provider.id, `${provider.label} returned no image. Try again.`, 502);
  const view = await storeVersion({
    draft: args.draft,
    userId: args.userId,
    from: asset,
    image,
    providerId: provider.id,
    model: provider.model,
    prompt,
    action: 'regenerated',
    instruction: null,
    logo,
    ...(args.jobId ? { jobId: args.jobId } : {}),
  });
  await recordAudit({
    action: 'GRAPHIC_GENERATED',
    userId: args.userId,
    companyId: args.draft.companyId,
    metadata: { draftId: args.draft.id, regenerated: true, from: asset.id, provider: provider.id },
  });
  return view;
}

// ---------------------------------------------------------------------------
// Logo setting for one variant (no AI for include / none)
// ---------------------------------------------------------------------------

export async function setVariantLogo(args: {
  draft: ContentDraft;
  userId: string;
  assetId: string;
  mode: Exclude<LogoMode, 'space'>;
  position: LogoPosition;
}): Promise<{ asset: AssetView; changed: boolean; note: string | null }> {
  const asset = await ownAsset(args.draft, args.assetId);
  if (isCreative(asset)) {
    throw new VariantError('A creative’s logo is set in its design — change it in the creative settings.');
  }
  if (isHiddenAsset(asset.metadata)) throw new VariantError('That image is not one of this post’s versions.');
  const current = logoOf(asset.metadata);

  if (args.mode === 'include') {
    if (current?.mode === 'include' && current.applied && current.position === args.position) {
      return { asset: toAssetView(asset), changed: false, note: null };
    }
    const source = await cleanSource(args.draft, asset);
    const view = await placeLogoOn({ draft: args.draft, userId: args.userId, assetId: source.id, position: args.position });
    const placed = view.id !== source.id;
    return {
      asset: view,
      changed: placed,
      note: placed ? null : (logoOf((await getAsset(args.draft.companyId, source.id)).metadata)?.reason ?? 'The logo could not be placed.'),
    };
  }

  // No logo: the logo-free image becomes the next version (a copy of it, so
  // the version with the logo stays exactly as it was).
  if (!current?.applied) {
    return {
      asset: await noteLogo(asset, { mode: 'none', position: current?.position ?? args.position, applied: false, reason: null }),
      changed: false,
      note: null,
    };
  }
  const source = await cleanSource(args.draft, asset);
  const variant = variantOf(asset.id, asset.metadata);
  const version = await nextVersion(args.draft, variant.rootId);
  const view = await persistImage({
    image: { data: await bytesOf(source), mimeType: source.mimeType, width: source.width, height: source.height },
    draft: args.draft,
    userId: args.userId,
    providerId: source.provider,
    model: source.model,
    prompt: source.prompt,
    style: source.style,
    aspectRatio: source.aspectRatio,
    platform: source.platform,
    metadata: {
      ...lineage(asset, version, 'logo', null),
      logo: { mode: 'none', position: current.position, applied: false, reason: null },
    },
  });
  return { asset: view, changed: true, note: null };
}
