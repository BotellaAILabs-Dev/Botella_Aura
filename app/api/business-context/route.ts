import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { getBusinessContext } from '@/server/business-context/business-context.service';

/**
 * GET — the resolved Business Context for the active workspace: every field,
 * where each value came from, which values conflicted, and what is missing.
 *
 * Read-only. No knowledge retrieval (that needs a query and belongs to the
 * workflow asking), so passages are always empty here.
 */
export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    const context = await getBusinessContext(company.id);
    if (!context) return jsonError('Company not found', 404);
    return jsonOk({ context });
  } catch (error) {
    return handleRouteError(error);
  }
}
