import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { getExecutionDetail } from '@/server/execution/execution-actions.service';

/**
 * GET /api/executions/:id — one execution: its state, every state change,
 * and the chain Business Context → Opportunity → Recommendation → Content →
 * Approval → Execution. 404 for another workspace's.
 */
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const { company } = await requireActiveCompany();
    const detail = await getExecutionDetail(company.id, params.id);
    if (!detail) return jsonError('Not found.', 404);
    return jsonOk(detail);
  } catch (error) {
    return handleRouteError(error);
  }
}
