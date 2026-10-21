import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonOk } from '@/lib/api';
import { EXECUTION_STATES, type ExecutionState } from '@/lib/execution-state';
import { listExecutions } from '@/server/execution/execution-actions.service';

/**
 * GET /api/executions?status=SCHEDULED,FAILED&draftId= — the workspace's
 * executions, newest activity first. Any member (no secrets in them).
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { company } = await requireActiveCompany();
    const url = new URL(req.url);
    const status = (url.searchParams.get('status') ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s): s is ExecutionState => (EXECUTION_STATES as readonly string[]).includes(s));
    const executions = await listExecutions({
      companyId: company.id,
      status,
      draftId: url.searchParams.get('draftId') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 100) || 100,
    });
    return jsonOk({ executions });
  } catch (error) {
    return handleRouteError(error);
  }
}
