import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { sendToOutreachSchema } from '@/lib/validations/outreach';
import { sendLeadsToOutreach } from '@/server/outreach/lead.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * POST /api/outreach/leads/send-to-outreach — explicit hand-off of selected
 * leads into the outreach workflow (Lead requirement → Fetch leads → Leads →
 * Outreach). Qualifies them and reports which requirement buckets they came
 * from, so the UI can deep-link straight to the filtered Outreach board.
 */
export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to move leads to outreach.', 403);
    }
    const { leadIds } = sendToOutreachSchema.parse(await req.json());

    const result = await sendLeadsToOutreach({
      companyId: company.id,
      userId: user.id,
      leadIds,
      requestMeta: getRequestMeta(req),
    });

    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
