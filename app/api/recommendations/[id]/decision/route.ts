import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { decideRecommendation } from '@/server/recommendations/recommendation.service';

/**
 * POST /api/recommendations/:id/decision { decision, note? }
 *
 * Accept, reject or withdraw an open recommendation. Accepting or rejecting
 * records the same decision on its opportunity; withdrawing leaves the
 * opportunity open. 409 if it was already decided.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  decision: z.enum(['ACCEPTED', 'REJECTED', 'WITHDRAWN']),
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
        'Only owners and admins can decide on a recommendation.',
        403,
      );
    }
    const { decision, note } = bodySchema.parse(await req.json());
    const recommendation = await decideRecommendation({
      companyId: company.id,
      recommendationId: params.id,
      decision,
      actorId: user.id,
      note,
    });
    return jsonOk({ recommendation });
  } catch (error) {
    return handleRouteError(error);
  }
}
