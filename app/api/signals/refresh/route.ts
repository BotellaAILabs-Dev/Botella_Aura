import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { collectSignals } from '@/server/signals/signal.service';

/**
 * POST /api/signals/refresh — gather signals from every source now.
 * Idempotent: running it twice stores nothing new.
 */
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const { company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('Only owners and admins can refresh signals.', 403);
    }
    const result = await collectSignals(company.id);
    if (!result) return jsonError('Company not found', 404);
    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
