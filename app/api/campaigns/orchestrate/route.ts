import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { createCampaignSchema } from '@/lib/validations/campaign';
import { createCampaign } from '@/server/campaigns/campaign.service';
import { requireEntitlement } from '@/server/billing/entitlements';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';
import {
  linkRecommendation,
  ownRecommendation,
} from '@/server/recommendations/context.service';

export const maxDuration = 60;

/**
 * POST /api/campaigns/orchestrate — create an orchestrated campaign: generate
 * the AI day-by-day plan and materialize its task schedule. Gated by the
 * `campaigns` entitlement (plan limits) and content:approve RBAC.
 */
export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to create campaigns.', 403);
    }
    await requireEntitlement(company.id, 'campaigns');

    const input = createCampaignSchema.parse(await req.json());
    const recommendation = await ownRecommendation(
      company.id,
      input.recommendationId,
    );
    const campaign = await createCampaign({
      companyId: company.id,
      userId: user.id,
      input,
      requestMeta: getRequestMeta(req),
    });
    // Planned for an Aura recommendation: its history leads to the campaign.
    if (recommendation) {
      await linkRecommendation({
        companyId: company.id,
        recommendationId: recommendation.id,
        module: 'campaigns',
        created: { type: 'campaign', id: campaign.id, label: campaign.name },
        actorId: user.id,
      });
    }
    return jsonOk({ id: campaign.id, name: campaign.name }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
