import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { detectForCompany } from '@/server/outreach/detect.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const maxDuration = 120;

/** POST /api/outreach/detect — run lead-signal detection now (OWNER/ADMIN). */
export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to run detection.', 403);
    }
    const result = await detectForCompany({
      companyId: company.id,
      userId: user.id,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
