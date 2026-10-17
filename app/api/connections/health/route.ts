import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { can } from '@/lib/rbac';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { refreshWorkspaceHealth } from '@/server/connections/health.service';
import { listConnectionRecords } from '@/server/connections/manager.service';

/** POST /api/connections/health — re-check every connection in the workspace. */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) return jsonError('Viewers can see connection health but not re-check it.', 403);
    const results = await refreshWorkspaceHealth(company.id, user.id);
    return jsonOk({
      connections: await listConnectionRecords(company.id),
      changed: results.filter((r) => r.health !== r.previous).map((r) => ({ connectorId: r.connectorId, from: r.previous, to: r.health })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
