import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { ExecutionActionError, retryExecution } from '@/server/execution/execution-actions.service';
import { InvalidTransitionError } from '@/lib/execution-state';

/**
 * POST /api/executions/:id/retry — run a Failed / Action-required execution
 * again now (re-routed first; a completed one never runs again). OWNER/ADMIN.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, user, membership } = await requireActiveCompany();
    return jsonOk(await retryExecution({ companyId: company.id, userId: user.id, role: membership.role, id: params.id }));
  } catch (error) {
    if (error instanceof ExecutionActionError) return jsonError(error.message, error.status, error.code ? { code: [error.code] } : undefined);
    if (error instanceof InvalidTransitionError) return jsonError(error.message, 409, { code: [error.code] });
    return handleRouteError(error);
  }
}
