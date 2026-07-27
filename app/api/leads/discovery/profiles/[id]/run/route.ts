import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { runDiscovery } from '@/server/leads/discovery/discovery.service';
import { requireEntitlement } from '@/server/billing/entitlements';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

// Multi-source network calls + AI scoring.
export const maxDuration = 300;

/** POST /api/leads/discovery/profiles/:id/run — run discovery now (OWNER/ADMIN). */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to run discovery.', 403);
    }
    await requireEntitlement(company.id, 'discovery');
    const result = await runDiscovery({
      companyId: company.id,
      profileId: params.id,
      userId: user.id,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk(result, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
