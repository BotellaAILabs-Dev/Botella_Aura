import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { getSetup } from '@/server/connections/manager.service';

/** GET /api/connections/:connectorId — one connection and its setup steps. */
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { connectorId: string } }) {
  try {
    const { company } = await requireActiveCompany();
    const setup = await getSetup(company.id, params.connectorId);
    if (!setup) return jsonError('That connection doesn’t exist in this workspace.', 404);
    return jsonOk(setup);
  } catch (error) {
    return handleRouteError(error);
  }
}
