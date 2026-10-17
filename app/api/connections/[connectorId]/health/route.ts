import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { can } from '@/lib/rbac';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { checkConnectionHealth } from '@/server/connections/health.service';
import { getConnectionRecord } from '@/server/connections/manager.service';

/**
 * POST /api/connections/:connectorId/health — re-check one connection with
 * its provider now (token, permissions, provider, account, recent failures).
 * Any member who can create content; viewers see the stored status.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** A check this recent is answered from storage (providers rate-limit). */
const MIN_INTERVAL_MS = 15_000;

export async function POST(req: Request, { params }: { params: { connectorId: string } }) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) return jsonError('Viewers can see connection health but not re-check it.', 403);
    const current = await getConnectionRecord(company.id, params.connectorId);
    if (!current) return jsonError('That connection doesn’t exist in this workspace.', 404);
    const recent = current.healthCheckedAt && Date.now() - new Date(current.healthCheckedAt).getTime() < MIN_INTERVAL_MS;
    // Throttled: no provider call, but the stored facts (expiry, failures) are re-judged.
    const check = await checkConnectionHealth(company.id, params.connectorId, { live: !recent, actorUserId: user.id });
    return jsonOk({
      connection: await getConnectionRecord(company.id, params.connectorId),
      checks: recent ? null : (check?.result.checks ?? null),
      cached: Boolean(recent),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
