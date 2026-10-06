import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { RECOMMENDATION_STATUSES } from '@/lib/recommendations';
import { decideRecommendation } from '@/server/recommendations/recommendation.service';

/**
 * POST /api/recommendations/:id/decision { decision, note?, expectedStatus? }
 *
 * Accept, skip, reject or withdraw a recommendation. Accepting or rejecting
 * records the same decision on its opportunity; skipping or withdrawing
 * leaves the opportunity open. Making the same decision twice is a no-op
 * (`changed: false`); a different one after a decision is 409.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  decision: z.enum(['ACCEPTED', 'SKIPPED', 'REJECTED', 'WITHDRAWN']),
  note: z.string().trim().max(2000).optional(),
  expectedStatus: z.enum(RECOMMENDATION_STATUSES).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company, membership, user } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError(
        'Only owners and admins can decide on a recommendation.',
        403,
      );
    }
    const { decision, note, expectedStatus } = bodySchema.parse(
      await req.json(),
    );
    const { changed, ...recommendation } = await decideRecommendation({
      companyId: company.id,
      recommendationId: params.id,
      decision,
      actorId: user.id,
      note,
      expectedStatus,
    });
    return jsonOk({ recommendation, changed });
  } catch (error) {
    return handleRouteError(error);
  }
}
