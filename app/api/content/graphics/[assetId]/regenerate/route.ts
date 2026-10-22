import { requireActiveCompany } from '@/lib/auth-helpers';
import { z } from 'zod';

import { jsonError } from '@/lib/api';
import { getAsset } from '@/server/media/asset.service';

import { queueVariantJob, variantError, variantRequest } from '../_variant';

/**
 * POST /api/content/graphics/:assetId/regenerate { draftId }
 *
 * Regenerate ONE variant from its original prompt (keeping its logo
 * setting). The new image is that variant's next version; the others are
 * not touched.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ draftId: z.string().min(1) });

export async function POST(req: Request, { params }: { params: { assetId: string } }) {
  try {
    // Who is asking comes before what they sent (an outsider gets 401, not 422).
    await requireActiveCompany();
    const input = bodySchema.parse(await req.json());
    const ctx = await variantRequest(input.draftId);
    if (ctx instanceof Response) return ctx;
    const asset = await getAsset(ctx.companyId, params.assetId);
    if (asset.contentDraftId !== ctx.draft.id) return jsonError('Open the post this image was made for to regenerate it.', 400);
    return await queueVariantJob(ctx, { action: 'regenerate', assetId: asset.id });
  } catch (error) {
    return variantError(error);
  }
}
