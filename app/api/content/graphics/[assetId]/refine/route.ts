import { requireActiveCompany } from '@/lib/auth-helpers';
import { jsonError } from '@/lib/api';
import { refineImageSchema } from '@/lib/validations/media';
import { getAsset } from '@/server/media/asset.service';
import { isEditingAvailable } from '@/server/media/providers';

import { queueVariantJob, variantError, variantRequest } from '../_variant';

/**
 * POST /api/content/graphics/:assetId/refine { draftId, instruction }
 *
 * Refine one image with a single natural-language instruction. Queued (an
 * image model call); the result is this image's next version — the image
 * itself, the other variants and the post's text are untouched.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { assetId: string } }) {
  try {
    // Who is asking comes before what they sent (an outsider gets 401, not 422).
    await requireActiveCompany();
    const input = refineImageSchema.parse(await req.json());
    const ctx = await variantRequest(input.draftId);
    if (ctx instanceof Response) return ctx;
    const asset = await getAsset(ctx.companyId, params.assetId);
    if (asset.contentDraftId !== ctx.draft.id) return jsonError('Open the post this image was made for to refine it.', 400);
    if (!isEditingAvailable()) {
      return jsonError(
        'No configured image model can edit images. Set GOOGLE_AI_API_KEY (Gemini image models) or OPENAI_API_KEY (gpt-image-1) to refine images.',
        503,
      );
    }
    return await queueVariantJob(ctx, { action: 'refine', assetId: asset.id, instruction: input.instruction });
  } catch (error) {
    return variantError(error);
  }
}
