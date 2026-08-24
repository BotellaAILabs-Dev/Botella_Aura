import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import {
  generateAdvisorReport,
  getLatestAdvisorReport,
} from '@/server/advisor/advisor.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

// Reads competitor + trend history, then makes one high-effort model call.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/** GET /api/advisor — the latest advisor report (no generation). */
export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    return jsonOk({ report: await getLatestAdvisorReport(company.id) });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/advisor — (re)generate today's opportunities. */
export async function POST() {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError('You do not have permission to generate advice.', 403);
    }
    const report = await generateAdvisorReport({
      companyId: company.id,
      userId: user.id,
    });
    return jsonOk({
      opportunities: report.opportunities.length,
      model: report.model,
      coverage: report.coverage,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
