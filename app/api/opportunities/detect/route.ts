import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { runDetection } from '@/server/opportunities/detection.service';

/**
 * POST /api/opportunities/detect — refresh signals and run the rule-based
 * detection now. Returns what each rule found, what it recorded, and what was
 * suppressed and why (lib/opportunity-detection.ts).
 */
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const { company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError(
        'Only owners and admins can run opportunity detection.',
        403,
      );
    }
    const run = await runDetection(company.id, { collect: true });
    if (!run) return jsonError('Company not found', 404);
    return jsonOk(run);
  } catch (error) {
    return handleRouteError(error);
  }
}
