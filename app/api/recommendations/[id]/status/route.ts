import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { RECOMMENDATION_STATUSES } from '@/lib/recommendations';
import { transitionRecommendation } from '@/server/recommendations/recommendation.service';

/**
 * POST /api/recommendations/:id/status { status, note? }
 *
 * Move a recommendation through its lifecycle: accept, reject, withdraw,
 * start, complete. Only allowed moves succeed (409 otherwise, or if someone
 * else changed it first). Accepting or rejecting is the same decision on its
 * opportunity. Expiry is automatic and cannot be set by hand.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  status: z
    .enum(RECOMMENDATION_STATUSES)
    .refine((s) => s !== 'EXPIRED' && s !== 'PROPOSED', {
      message: 'That status is set by Aura, not by hand.',
    }),
  note: z.string().trim().max(2000).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company, membership, user } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError(
        'Only owners and admins can change a recommendation’s status.',
        403,
      );
    }
    const { status, note } = bodySchema.parse(await req.json());
    const recommendation = await transitionRecommendation({
      companyId: company.id,
      recommendationId: params.id,
      to: status,
      actorId: user.id,
      note,
    });
    return jsonOk({ recommendation });
  } catch (error) {
    return handleRouteError(error);
  }
}
