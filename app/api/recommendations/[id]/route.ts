import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { getRecommendation } from '@/server/recommendations/recommendation.service';

/**
 * GET /api/recommendations/:id — one recommendation: what, why, action,
 * expected outcome, channel, audience, confidence, priority, status and its
 * history, its evidence, its originating opportunity, and `execution` — the
 * brief handed to the workflow that carries it out (lib/recommendations.ts).
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    const recommendation = await getRecommendation(company.id, params.id);
    if (!recommendation) return jsonError('Recommendation not found', 404);
    return jsonOk({ recommendation });
  } catch (error) {
    return handleRouteError(error);
  }
}
