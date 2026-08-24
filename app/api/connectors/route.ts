import { requireActiveCompany } from '@/lib/auth-helpers';
import { listConnections } from '@/server/connectors/connection.service';
import { handleRouteError, jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** GET /api/connectors — this workspace's live connections (no secrets). */
export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    return jsonOk({ connections: await listConnections(company.id) });
  } catch (error) {
    return handleRouteError(error);
  }
}
