import {
  requireExtensionAuth,
  handleOptions,
  extJson,
  extError,
  handleExtensionError,
} from '@/lib/extension-auth';
import { getAsset, readAssetBytes } from '@/server/media/asset.service';

/**
 * GET /api/extension/media/:assetId — one graphic, for the extension.
 *
 * Returns base64 inside JSON rather than raw bytes, and that is deliberate.
 * The extension authenticates with a bearer token and no cookies, so every
 * request it makes is cross-origin and needs CORS headers on the response. The
 * existing extension helpers (`extJson`) attach those to JSON responses, and
 * the content script has to turn the image into a File object for LinkedIn's
 * uploader anyway — which means decoding it client-side either way.
 *
 * Authorisation reuses the same extension token and company scoping as the rest
 * of /api/extension/*: `getAsset` is company-scoped, so a token for workspace A
 * cannot read workspace B's graphic. No new auth path was introduced.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function OPTIONS(req: Request) {
  return handleOptions(req);
}

export async function GET(
  req: Request,
  { params }: { params: { assetId: string } },
) {
  try {
    const ctx = await requireExtensionAuth(req);
    const asset = await getAsset(ctx.companyId, params.assetId);
    // Videos are published to Instagram by Aura itself (too large to pass
    // through here as base64); the extension carries images only.
    if (asset.kind === 'VIDEO') {
      return extError(req, 'Videos aren’t carried by the extension — Aura publishes them to Instagram directly.', 422);
    }

    const bytes = await readAssetBytes(asset);
    if (!bytes) {
      return extError(req, 'That graphic could not be read.', 404);
    }

    return extJson(req, {
      assetId: asset.id,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
      fileSize: asset.fileSize,
      /** Base64 — the content script rebuilds it as a File. */
      data: bytes.toString('base64'),
    });
  } catch (error) {
    return handleExtensionError(req, error);
  }
}
