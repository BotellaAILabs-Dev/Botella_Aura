import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { createCampaignSchema } from '@/lib/validations/campaign';
import { createCampaign } from '@/server/campaigns/campaign.service';
import { requireEntitlement } from '@/server/billing/entitlements';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';
import {
  getCreation,
  recordCreation,
  startCreation,
} from '@/server/recommendations/creation.service';
import { campaignCreationHandoff } from '@/lib/creation-handoff';
import { executionGate } from '@/lib/execution-gate';

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
    // Planned for an Aura recommendation (lib/recommendation-creation.ts):
    // one that cannot be planned from is refused with the reason; an open one
    // is said yes to by planning it — a decision, so owners and admins only.
    const creation = input.recommendationId
      ? await getCreation(company.id, input.recommendationId, 'campaigns')
      : null;
    if (creation && !creation.plan.canCreate) {
      return jsonOk(
        {
          error:
            creation.plan.message ?? 'There is nothing to plan from this suggestion.',
          fix: creation.plan.fix,
        },
        409,
      );
    }
    let ready = creation;
    if (creation?.plan.acceptsOnCreate) {
      if (!can(membership.role, 'company:update')) {
        return jsonError(
          'Only owners and admins can say yes to a suggestion. Ask one to accept it — then plan from it.',
          403,
        );
      }
      ready = await startCreation({
        companyId: company.id,
        recommendationId: creation.plan.recommendationId,
        actorId: user.id,
        module: 'campaigns',
      });
    }
    const recommendation = ready
      ? { id: ready.plan.recommendationId }
      : null;
    // The Campaign creation handoff: the recommendation's context, kept on the
    // campaign and given to the planner (lib/creation-handoff.ts).
    const context = ready
      ? campaignCreationHandoff(ready.handoff, { related: ready.related }).context
      : null;
    const campaign = await createCampaign({
      companyId: company.id,
      userId: user.id,
      input,
      requestMeta: getRequestMeta(req),
      creation: recommendation && context ? { recommendationId: recommendation.id, context } : null,
    });
    // Planned for an Aura recommendation: its history leads to the campaign.
    if (recommendation) {
      await recordCreation({
        companyId: company.id,
        recommendationId: recommendation.id,
        module: 'campaigns',
        created: { type: 'campaign', id: campaign.id, label: campaign.name },
        actorId: user.id,
      });
    }
    const gate = executionGate('campaign', Boolean(context));
    return jsonOk(
      {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        execution: gate.blocked ? { blocked: true, message: gate.message } : { blocked: false },
      },
      201,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
