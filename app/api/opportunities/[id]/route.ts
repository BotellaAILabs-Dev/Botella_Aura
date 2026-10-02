import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { getOpportunity } from '@/server/opportunities/opportunity.service';

/** GET /api/opportunities/:id — one opportunity, its evidence and its full lifecycle history. */
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    const opportunity = await getOpportunity(company.id, params.id);
    if (!opportunity) return jsonError('Opportunity not found', 404);
    return jsonOk({ opportunity });
  } catch (error) {
    return handleRouteError(error);
  }
}
