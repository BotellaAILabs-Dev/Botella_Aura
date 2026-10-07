import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { getRecommendationContext } from '@/server/recommendations/context.service';

/**
 * GET /api/recommendations/:id/context — the recommendation as it travels
 * between Aura's modules (lib/recommendation-context.ts): what, why, the
 * expected outcome, the module that carries it out and the related ones,
 * each with what to do there and what it receives. Read by the context bar
 * on any module page opened with `?rec=<id>`.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    const context = await getRecommendationContext(company.id, params.id);
    if (!context) return jsonError('Recommendation not found', 404);
    return jsonOk({ context });
  } catch (error) {
    return handleRouteError(error);
  }
}
