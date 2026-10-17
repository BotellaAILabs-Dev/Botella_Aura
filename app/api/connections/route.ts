import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonOk } from '@/lib/api';
import { listConnectionRecords } from '@/server/connections/manager.service';

/**
 * GET /api/connections — the Connection Manager: every connection in the
 * active workspace with its accounts, permissions, health and capabilities.
 * Never includes a token (lib/connection-manager.ts toConnectionRecord).
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    return jsonOk({ connections: await listConnectionRecords(company.id) });
  } catch (error) {
    return handleRouteError(error);
  }
}
