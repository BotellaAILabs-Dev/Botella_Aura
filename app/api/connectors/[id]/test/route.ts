import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import {
  ConnectorError,
  testConnection,
} from '@/server/connectors/connection.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/connectors/:id/test — re-verify stored credentials against the
 * provider right now. "Connected" should mean "working", not "was working once".
 */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('You do not have permission to test connectors.', 403);
    }
    const result = await testConnection({
      companyId: company.id,
      userId: user.id,
      connectorId: params.id,
    });
    return jsonOk(result);
  } catch (error) {
    if (error instanceof ConnectorError) {
      return jsonError(error.message, error.status);
    }
    return handleRouteError(error);
  }
}
