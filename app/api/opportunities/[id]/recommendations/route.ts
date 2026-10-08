import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { recommendationContentSchema } from '@/lib/recommendations';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { generateRecommendation } from '@/server/recommendations/engine.service';
import { opportunityBelongsTo } from '@/server/opportunities/opportunity.service';
import {
  getRecommendation,
  listRecommendations,
} from '@/server/recommendations/recommendation.service';

/**
 * GET  /api/opportunities/:id/recommendations — recommendations made from it.
 * POST /api/opportunities/:id/recommendations { title?, action?, rationale?, … }
 *
 * Generate a recommendation from this opportunity with the recommendation
 * engine (server/recommendations/engine.service.ts): it picks the action that
 * fits the business now, writes it, assesses it and checks it is supported.
 * Any field sent replaces the engine's. Returns the recommendation and the
 * generation report (chosen action, alternatives, flags). 422 with the
 * reasons if the data does not support any recommendation; 409 if one is
 * already in play.
 */
export const dynamic = 'force-dynamic';

/**
 * Any part of the recommendation's own content; the rest is the engine's.
 * Confidence, priority, evidence and the link cannot be set here.
 */
const bodySchema = recommendationContentSchema
  .pick({
    type: true,
    title: true,
    summary: true,
    action: true,
    steps: true,
    rationale: true,
    expectedOutcome: true,
    outcomeMetric: true,
    channel: true,
    contentType: true,
    audience: true,
  })
  .partial()
  .strict();

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    // Another business's opportunity answers like one that does not exist.
    if (!(await opportunityBelongsTo(company.id, params.id))) {
      return jsonError('Opportunity not found', 404);
    }
    const recommendations = await listRecommendations(company.id, {
      opportunityId: params.id,
    });
    return jsonOk({ recommendations });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company, membership, user } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError(
        'Only owners and admins can recommend an opportunity.',
        403,
      );
    }
    const body = bodySchema.parse(await req.json().catch(() => ({})));
    const generation = await generateRecommendation({
      companyId: company.id,
      opportunityId: params.id,
      actorId: user.id,
      overrides: body,
    });
    if (!generation.recommendationId) {
      // Not supported by the data: nothing stored, and the reasons say why.
      return jsonOk(
        {
          error: `No recommendation was made: ${generation.reasons[0] ?? 'not supported by the available data.'}`,
          generation,
        },
        422,
      );
    }
    const recommendation = await getRecommendation(
      company.id,
      generation.recommendationId,
    );
    return jsonOk({ recommendation, generation }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
