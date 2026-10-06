import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import {
  SNOOZE_LIMITS,
  snoozeRecommendation,
} from '@/server/recommendations/ranking.service';

/**
 * POST /api/recommendations/:id/snooze { days? } — "Not now".
 *
 * Hides it from the surfaced list for 1–30 days (default 7), after which it
 * comes back. 409 if it would stop being relevant while hidden.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  days: z
    .number()
    .int()
    .min(SNOOZE_LIMITS.minDays)
    .max(SNOOZE_LIMITS.maxDays)
    .optional(),
});

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company, membership, user } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError(
        'Only owners and admins can defer a recommendation.',
        403,
      );
    }
    const { days } = bodySchema.parse(await req.json().catch(() => ({})));
    const recommendation = await snoozeRecommendation({
      companyId: company.id,
      recommendationId: params.id,
      days,
      actorId: user.id,
    });
    return jsonOk({ recommendation });
  } catch (error) {
    return handleRouteError(error);
  }
}
