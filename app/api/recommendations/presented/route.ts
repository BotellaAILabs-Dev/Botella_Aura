import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonOk } from '@/lib/api';
import { presentRecommendations } from '@/server/recommendations/recommendation.service';

/**
 * POST /api/recommendations/presented { ids, surface?, positions? }
 *
 * The client shows recommendations to a person and reports which. Each one
 * never shown before moves GENERATED → PRESENTED, with where and at what rank
 * in its history; one already shown (or decided) is left alone. Idempotent —
 * reporting the same view twice records it once. Ids from another business
 * are ignored. Viewers are read-only: what they see is not recorded (a
 * recommendation is "presented" to the people who can act on it).
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(100),
  surface: z.string().trim().min(1).max(60).optional(),
  positions: z
    .record(
      z.string(),
      z.object({
        rank: z.number().int().min(1).max(1000).optional(),
        score: z.number().min(-1000).max(1000).optional(),
        band: z.string().max(20).optional(),
      }),
    )
    .optional(),
});

export async function POST(req: Request) {
  try {
    const { company, membership, user } = await requireActiveCompany();
    const { ids, surface, positions } = bodySchema.parse(await req.json());
    if (!can(membership.role, 'content:create')) {
      return jsonOk({ presented: [], alreadyPresented: [], recorded: false });
    }
    const result = await presentRecommendations({
      companyId: company.id,
      recommendationIds: ids,
      actorId: user.id,
      surface,
      positions,
    });
    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
