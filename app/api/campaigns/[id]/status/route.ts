import { z } from 'zod';
import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { setCampaignStatus } from '@/server/campaigns/campaign.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

const bodySchema = z.object({ action: z.enum(['pause', 'resume']) });

/** POST /api/campaigns/:id/status — pause/resume future task execution. */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to manage campaigns.', 403);
    }
    const { action } = bodySchema.parse(await req.json());
    const campaign = await setCampaignStatus({
      companyId: company.id,
      userId: user.id,
      campaignId: params.id,
      action,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ id: campaign.id, status: campaign.status });
  } catch (error) {
    return handleRouteError(error);
  }
}
