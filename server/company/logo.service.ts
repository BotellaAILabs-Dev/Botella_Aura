import crypto from 'node:crypto';

import { validateImageBytes } from '@/server/media/validate';
import { putImage } from '@/server/media/storage';
import { createAsset } from '@/server/media/asset.service';
import { closestRatioFor } from '@/server/media/aspect';
import { updateBusinessContext } from '@/server/business-context/business-context-write.service';

/**
 * The workspace logo.
 *
 * Kept apart from profile.service.ts on purpose: that module is read by the
 * content generator and the image prompt builder on every draft, and it should
 * not drag the whole media stack in behind it.
 */

/**
 * Store an uploaded logo as a company-level asset.
 *
 * Deliberately the same pipeline as a post graphic — validateImageBytes, then
 * putImage, then a GeneratedAsset row — rather than a second storage path for
 * one file. The logo inherits, for free, the magic-number MIME sniff, the size
 * and dimension ceilings, the S3-or-database storage choice, and the ownership
 * check on `/api/content/graphics/:id/file` that already refuses to serve an
 * asset to anyone outside its company.
 *
 * The one difference from ingestImage is `contentDraftId: null`: a logo belongs
 * to the workspace, not to a post. That column is already nullable and the
 * serving route already keys authorisation off the asset's own companyId, so
 * nothing downstream needs a special case.
 */
export class LogoUploadError extends Error {}

export async function storeCompanyLogo(args: {
  companyId: string;
  userId: string;
  data: Buffer;
  filename?: string;
}): Promise<{ assetId: string; width: number; height: number }> {
  // Dimensions are unknown up front, so the "claimed" values are zero —
  // validateImageBytes reads the real ones out of the file header.
  const validated = validateImageBytes(args.data, { width: 0, height: 0 });
  if (validated.width === 0 || validated.height === 0) {
    throw new LogoUploadError(
      'That image’s dimensions could not be read. Re-save it as a standard PNG or JPEG and try again.',
    );
  }

  const assetId = `l${Date.now().toString(36)}${crypto
    .randomBytes(9)
    .toString('base64url')
    .toLowerCase()}`;

  const stored = await putImage({
    companyId: args.companyId,
    assetId,
    data: args.data,
    mimeType: validated.mimeType,
  });

  await createAsset({
    id: assetId,
    companyId: args.companyId,
    contentDraftId: null,
    createdById: args.userId,
    provider: 'UPLOAD',
    // No model produced this. Recording how it arrived keeps the asset history
    // readable without pretending a generator was involved.
    model: 'logo-upload',
    kind: 'IMAGE',
    prompt: args.filename ? `Brand logo: ${args.filename}` : 'Brand logo',
    aspectRatio: closestRatioFor(validated.width, validated.height),
    width: validated.width,
    height: validated.height,
    mimeType: validated.mimeType,
    fileSize: validated.fileSize,
    storage: stored.storage,
    data: stored.data ?? null,
    storageUrl: stored.storageUrl ?? null,
    metadata: {
      origin: 'logo',
      ...(args.filename ? { filename: args.filename } : {}),
    },
  });

  await updateBusinessContext({
    companyId: args.companyId,
    userId: args.userId,
    patch: { identity: { visual: { logoAssetId: assetId } } },
    origin: 'settings',
  });

  return { assetId, width: validated.width, height: validated.height };
}

/** Where the browser fetches a stored logo. Session-gated by the asset route. */
export function logoAssetUrl(assetId: string): string {
  return `/api/content/graphics/${assetId}/file`;
}
