import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { disconnectCompany } from '@/server/services/linkedin.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * POST /api/linkedin/disconnect — revoke the token (best-effort) and delete the
 * stored connection for the active company. RBAC-guarded + audited.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const { active } = await resolveActiveCompany(user.id);
    if (!active) return jsonError('No active company', 400);

    const membership = await getMembership(user.id, active.id);
    if (!membership || !can(membership.role, 'linkedin:connect')) {
      return jsonError('You are not permitted to manage this connection.', 403);
    }

    await disconnectCompany({
      companyId: active.id,
      userId: user.id,
      requestMeta: getRequestMeta(req),
    });

    return jsonOk({ disconnected: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
