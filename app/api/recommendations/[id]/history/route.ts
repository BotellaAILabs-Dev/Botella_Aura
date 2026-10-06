import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { getRecommendationHistory } from '@/server/recommendations/recommendation.service';

/**
 * GET /api/recommendations/:id/history — everything that happened to one
 * recommendation, oldest first: each action, from → to status, who (and
 * whether a person, the engine, the system or its opportunity), when, the
 * note, and the detail (an edit's field changes, where it was presented).
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    const history = await getRecommendationHistory(company.id, params.id);
    if (!history) return jsonError('Recommendation not found', 404);
    return jsonOk(history);
  } catch (error) {
    return handleRouteError(error);
  }
}
