import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { recommendationContentSchema } from '@/lib/recommendations';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import {
  createRecommendationFromOpportunity,
  listRecommendations,
} from '@/server/recommendations/recommendation.service';

/**
 * GET  /api/opportunities/:id/recommendations — recommendations made from it.
 * POST /api/opportunities/:id/recommendations { title?, action?, rationale?, … }
 *
 * Create a recommendation from this opportunity. Its content starts as a
 * default draft built from the opportunity; any field sent replaces the
 * draft's. It references the opportunity, carries its evidence forward, and
 * moves the opportunity to RECOMMENDED. 409 if the opportunity cannot be
 * recommended (closed, past its window, no current evidence) or already has a
 * recommendation in play.
 */
export const dynamic = 'force-dynamic';

/**
 * Any part of the recommendation's own content; the rest comes from the
 * default draft built from the opportunity. Confidence, priority, evidence
 * and the link are inherited and cannot be set here.
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
    const recommendation = await createRecommendationFromOpportunity({
      companyId: company.id,
      opportunityId: params.id,
      createdBy: `user:${user.id}`,
      actorId: user.id,
      content: body,
    });
    return jsonOk({ recommendation }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
