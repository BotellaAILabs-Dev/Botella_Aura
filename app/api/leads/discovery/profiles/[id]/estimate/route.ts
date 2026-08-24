import { requireActiveCompany } from '@/lib/auth-helpers';
import { estimateDiscoveryRun } from '@/server/leads/discovery/estimate';
import { handleRouteError, jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * GET /api/leads/discovery/profiles/:id/estimate — what a run would produce,
 * how long it would take, and what it would cost in model usage. Shown before
 * "Run now" so nobody has to guess.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    const estimate = await estimateDiscoveryRun({
      companyId: company.id,
      profileId: params.id,
    });
    return jsonOk(estimate);
  } catch (error) {
    return handleRouteError(error);
  }
}
