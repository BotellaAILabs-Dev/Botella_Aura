import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { trackCompany } from '@/server/competitors/tracking.service';
import { generateWeeklyReport } from '@/server/competitors/report.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

// Tracks all competitors then generates the report — network-heavy.
export const maxDuration = 300;

/**
 * POST /api/competitors/reports — "Generate now" (for demos).
 * Runs a fresh tracking pass across all competitors, then (re)generates this
 * week's report. OWNER/ADMIN only.
 */
export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('You do not have permission to generate reports.', 403);
    }
    const requestMeta = getRequestMeta(req);

    await trackCompany(company.id, { userId: user.id, requestMeta });
    const report = await generateWeeklyReport({
      companyId: company.id,
      userId: user.id,
      requestMeta,
    });

    return jsonOk({ id: report.id, weekStart: report.weekStart }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
