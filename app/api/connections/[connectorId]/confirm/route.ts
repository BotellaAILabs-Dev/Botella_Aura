import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { can } from '@/lib/rbac';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { ConnectionManagerError, confirmConnection, getSetup } from '@/server/connections/manager.service';
import { checkConnectionHealth } from '@/server/connections/health.service';

/**
 * POST /api/connections/:connectorId/confirm — step 5: confirm the
 * connection. Only confirmed connections can execute. Runs a live health
 * check straight away so the status shown is real. OWNER/ADMIN.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: { connectorId: string } }) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) return jsonError('Only owners and admins can confirm connections.', 403);
    await confirmConnection({ companyId: company.id, userId: user.id, connectorId: params.connectorId });
    const check = await checkConnectionHealth(company.id, params.connectorId, { live: true, actorUserId: user.id });
    return jsonOk({ ...(await getSetup(company.id, params.connectorId)), check: check?.result ?? null });
  } catch (error) {
    if (error instanceof ConnectionManagerError) return jsonError(error.message, error.status, error.code ? { code: [error.code] } : undefined);
    return handleRouteError(error);
  }
}
