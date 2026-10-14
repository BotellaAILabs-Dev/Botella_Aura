import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getMembership } from '@/server/services/company.service';
import { readAssetBytes } from '@/server/media/asset.service';
import { verifyAssetSignature } from '@/server/media/asset-url';
import { needsJpeg, toJpeg } from '@/server/media/jpeg';
import { logger } from '@/lib/logger';

/**
 * GET /api/content/graphics/:assetId/file — the image bytes.
 *
 * Two ways in, and only two:
 *
 *   1. A signed link (`?exp=&sig=`). Publishing to Instagram means handing
 *      Meta's servers a URL they can fetch with no session at all, so this path
 *      exists specifically for that. The signature is HMAC'd over the asset id
 *      and an expiry, so it cannot be edited to reach a different asset and
 *      stops working minutes later.
 *
 *   2. A session that belongs to the asset's company. Membership is checked
 *      against the asset's OWN companyId rather than the caller's active
 *      workspace — someone who is a member of two companies should still not be
 *      able to pull an asset into the wrong one by switching tabs.
 *
 * Anything else is a 404, not a 403: telling an unauthorised caller that an id
 * exists is itself a leak.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  req: Request,
  { params }: { params: { assetId: string } },
) {
  const url = new URL(req.url);
  const signed = verifyAssetSignature(
    params.assetId,
    url.searchParams.get('exp'),
    url.searchParams.get('sig'),
  );

  // Who owns it first, WITHOUT the image bytes: the multi-MB blob is only
  // read once the caller is known to be allowed it. (This used to load the
  // whole image before the session check, so every preview — and every
  // refused request — paid for a full read.)
  const owner = await db.generatedAsset.findUnique({
    where: { id: params.assetId },
    select: { companyId: true, kind: true, storageUrl: true },
  });
  if (!owner) return notFound();

  if (!signed) {
    const user = await getCurrentUser();
    if (!user) return notFound();
    const membership = await getMembership(user.id, owner.companyId);
    if (!membership) return notFound();
  }

  // A video is never streamed through here (too large for a function
  // response): once the caller is allowed it, send them to the bucket copy.
  if (owner.kind === 'VIDEO') {
    if (!owner.storageUrl) return notFound();
    return new Response(null, {
      status: 302,
      headers: { location: owner.storageUrl, 'cache-control': 'private, no-store' },
    });
  }

  const asset = await db.generatedAsset.findUnique({
    where: { id: params.assetId },
  });
  if (!asset) return notFound();
  let bytes = await readAssetBytes(asset);
  if (!bytes) return notFound();
  let mimeType = asset.mimeType;

  // ?format=jpeg — Instagram takes JPEG only, and fetches through this route.
  if (url.searchParams.get('format') === 'jpeg' && needsJpeg(mimeType)) {
    try {
      bytes = await toJpeg(bytes);
      mimeType = 'image/jpeg';
    } catch (err) {
      // Served as stored: Instagram's refusal then says what is wrong.
      logger.warn('asset file: JPEG conversion failed', {
        assetId: asset.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': mimeType,
      'content-length': String(bytes.byteLength),
      // Assets are immutable once generated — regenerating produces a new row
      // with a new id — so this can be cached hard. `private` keeps it out of
      // shared caches, since the URL is either session-gated or signed.
      'cache-control': 'private, max-age=31536000, immutable',
      'content-disposition': `inline; filename="graphic-${asset.id}.${extensionFor(mimeType)}"`,
      // The bytes are ours, but they came from a generative model — never let a
      // browser sniff this into something executable.
      'x-content-type-options': 'nosniff',
    },
  });
}

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'video/mp4') return 'mp4';
  if (mimeType === 'video/quicktime') return 'mov';
  return 'png';
}
