import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonOk } from '@/lib/api';
import { RECOMMENDATION_STATUSES } from '@/lib/recommendations';
import { listRecommendations } from '@/server/recommendations/recommendation.service';

/**
 * GET /api/recommendations?status=PROPOSED,ACCEPTED&opportunityId=…&limit=50
 *
 * The workspace's recommendations, newest first, each with its evidence and
 * originating opportunity. Undecided ones past their relevance window are
 * expired before listing.
 */
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((v) =>
      v ? v.split(',').map((s) => s.trim().toUpperCase()) : undefined,
    )
    .pipe(z.array(z.enum(RECOMMENDATION_STATUSES)).optional()),
  opportunityId: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(req: Request) {
  try {
    const { company } = await requireActiveCompany();
    const query = querySchema.parse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    const recommendations = await listRecommendations(company.id, query);
    return jsonOk({ recommendations });
  } catch (error) {
    return handleRouteError(error);
  }
}
