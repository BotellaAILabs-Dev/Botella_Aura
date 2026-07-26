import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { getCompetitorOrThrow } from '@/server/competitors/competitor.service';
import { trackCompetitor } from '@/server/competitors/tracking.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

// Website fetch + diff + AI summary can take a while.
export const maxDuration = 120;

/** POST /api/competitors/:id/track — run a tracking pass for one competitor now. */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('You do not have permission to manage competitors.', 403);
    }
    // Ensures the competitor belongs to this company before tracking.
    await getCompetitorOrThrow(company.id, params.id);

    const result = await trackCompetitor({
      competitorId: params.id,
      userId: user.id,
      requestMeta: getRequestMeta(req),
    });
    if (!result) {
      return jsonError('Tracking is disabled for this competitor.', 409);
    }
    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
