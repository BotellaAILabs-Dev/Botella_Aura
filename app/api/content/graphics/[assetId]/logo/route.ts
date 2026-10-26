import { requireActiveCompany } from '@/lib/auth-helpers';
import { jsonError, jsonOk } from '@/lib/api';
import { imageLogoSchema } from '@/lib/validations/media';
import { getAsset } from '@/server/media/asset.service';
import { isEditingAvailable } from '@/server/media/providers';
import { setVariantLogo } from '@/server/media/variant.service';

import { queueVariantJob, variantError, variantRequest } from '../_variant';

/**
 * POST /api/content/graphics/:assetId/logo { draftId, mode, position, tint }
 *
 * Change ONE image's logo setting; the result is its next version.
 *   include — the exact uploaded logo is placed on it (instant, no AI)
 *   none    — the logo-free image (instant, no AI)
 *   space   — the image model clears a corner for a logo (queued, counts as
 *             one image)
 * If the logo cannot be placed (none uploaded, unreadable), the image is
 * unchanged and `note` says why.
 *
 * `tint` recolours the mark for legibility (white on a dark photograph, say).
 * Its shape and transparency are the uploaded file's; only its ink changes.
 * A change of tint alone is a real change, so it produces a new version.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { assetId: string } }) {
  try {
    // Who is asking comes before what they sent (an outsider gets 401, not 422).
    await requireActiveCompany();
    const input = imageLogoSchema.parse(await req.json());
    const ctx = await variantRequest(input.draftId);
    if (ctx instanceof Response) return ctx;
    const asset = await getAsset(ctx.companyId, params.assetId);
    if (asset.contentDraftId !== ctx.draft.id) return jsonError('Open the post this image was made for to change it.', 400);

    if (input.mode === 'space') {
      if (!isEditingAvailable()) {
        return jsonError('Making room for a logo needs an image model that can edit (Gemini or gpt-image-1).', 503);
      }
      return await queueVariantJob(ctx, { action: 'make_space', assetId: asset.id, position: input.position });
    }
    const result = await setVariantLogo({
      draft: ctx.draft,
      userId: ctx.userId,
      assetId: asset.id,
      mode: input.mode,
      position: input.position,
      tint: input.tint,
    });
    return jsonOk(result);
  } catch (error) {
    return variantError(error);
  }
}
