import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { generateAnalyticsReport } from '@/server/analytics/report.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const maxDuration = 60;

/** POST /api/analytics/report — generate this week's written report. */
export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to generate reports.', 403);
    }
    const report = await generateAnalyticsReport({
      companyId: company.id,
      userId: user.id,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ id: report.id }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
