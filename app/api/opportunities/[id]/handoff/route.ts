import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { getOpportunityHandoff } from '@/server/recommendations/recommendation.service';

/**
 * GET /api/opportunities/:id/handoff
 *
 * What this opportunity hands a recommendation (lib/recommendation-handoff.ts):
 * the opportunity, its assessment, its evidence (marked current or not), the
 * business context it relies on, and how it was detected — plus whether it
 * can be recommended now, and why not. The input contract for the Sprint 8
 * recommendation engine.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    const result = await getOpportunityHandoff(company.id, params.id);
    if (!result) return jsonError('Opportunity not found', 404);
    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
