import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import {
  createRecommendationFromOpportunity,
  listRecommendations,
} from '@/server/recommendations/recommendation.service';

/**
 * GET  /api/opportunities/:id/recommendations — recommendations made from it.
 * POST /api/opportunities/:id/recommendations { title?, summary? }
 *
 * Create a recommendation from this opportunity: it references the
 * opportunity, carries its evidence forward, and moves the opportunity to
 * RECOMMENDED. 409 if the opportunity cannot be recommended (closed, past its
 * window, no current evidence) or already has an open recommendation.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  summary: z.string().trim().min(1).max(4000).optional(),
});

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
      ...body,
    });
    return jsonOk({ recommendation }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
