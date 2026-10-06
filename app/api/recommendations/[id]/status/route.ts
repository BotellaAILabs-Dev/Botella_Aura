import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import {
  RECOMMENDATION_STATUSES,
  USER_SETTABLE_STATUSES,
} from '@/lib/recommendations';
import { transitionRecommendation } from '@/server/recommendations/recommendation.service';

/**
 * POST /api/recommendations/:id/status { status, note?, expectedStatus? }
 *
 * Move a recommendation through its lifecycle: accept, skip, reject,
 * withdraw, start, complete. Only allowed moves succeed (409 otherwise, or if
 * someone else changed it first). Repeating the move it is already in is a
 * no-op (`changed: false`) — never a second history entry. `expectedStatus`
 * (the status the person was looking at) refuses an action taken on a stale
 * screen. Presented, edited and expired are set by Aura or by an edit
 * (POST …/presented, PATCH …/:id), not here.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  status: z
    .enum(RECOMMENDATION_STATUSES)
    .refine((s) => (USER_SETTABLE_STATUSES as readonly string[]).includes(s), {
      message: 'That status is set by Aura or by an edit, not by hand.',
    }),
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
        'Only owners and admins can change a recommendation’s status.',
        403,
      );
    }
    const { status, note, expectedStatus } = bodySchema.parse(await req.json());
    const { changed, ...recommendation } = await transitionRecommendation({
      companyId: company.id,
      recommendationId: params.id,
      to: status,
      actorId: user.id,
      note,
      expectedStatus,
      metadata: { via: 'status' },
    });
    return jsonOk({ recommendation, changed });
  } catch (error) {
    return handleRouteError(error);
  }
}
