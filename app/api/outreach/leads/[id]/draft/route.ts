import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { draftForLead } from '@/server/outreach/drafting.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const maxDuration = 120;

/** POST /api/outreach/leads/:id/draft — AI-draft connection note + follow-up. */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to draft outreach.', 403);
    }
    const result = await draftForLead({
      companyId: company.id,
      userId: user.id,
      leadId: params.id,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk(result, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
