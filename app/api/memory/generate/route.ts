import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { generateMemories } from '@/server/memory/extraction.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const maxDuration = 60;

/**
 * POST /api/memory/generate — run pattern extraction now ("Analyze" button).
 * Honestly returns { status: 'insufficient' } for low-sample companies.
 */
export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to run analysis.', 403);
    }
    const result = await generateMemories({
      companyId: company.id,
      userId: user.id,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
