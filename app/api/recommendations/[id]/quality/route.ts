import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { getRecommendationQuality } from '@/server/recommendations/quality.service';

/**
 * GET /api/recommendations/:id/quality — the quality checks run before a
 * recommendation is presented (lib/recommendation-quality.ts): the verdict
 * (trusted / needs_review / blocked), each check with its status and reasons,
 * and the problems and warnings in words.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    const quality = await getRecommendationQuality(company.id, params.id);
    if (!quality) return jsonError('Recommendation not found', 404);
    return jsonOk({ quality });
  } catch (error) {
    return handleRouteError(error);
  }
}
