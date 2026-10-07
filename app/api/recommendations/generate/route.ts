import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { suggestFromOpportunities } from '@/server/recommendations/autosuggest.service';

/**
 * POST /api/recommendations/generate — "Get Aura's suggestions": run the
 * recommendation engine over open opportunities that have no suggestion yet
 * (server/recommendations/autosuggest.service.ts). The engine's guardrails
 * still decide; what it skips comes back with the reason.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST() {
  try {
    const { company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError(
        'Only owners and admins can ask Aura for suggestions.',
        403,
      );
    }
    const report = await suggestFromOpportunities(company.id);
    return jsonOk(report);
  } catch (error) {
    return handleRouteError(error);
  }
}
