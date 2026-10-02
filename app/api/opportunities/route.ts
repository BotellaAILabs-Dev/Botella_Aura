import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonOk } from '@/lib/api';
import { OPPORTUNITY_STATUSES } from '@/lib/opportunities';
import { listOpportunities } from '@/server/opportunities/opportunity.service';

/**
 * GET /api/opportunities?status=DETECTED,REVIEWED&limit=50
 *
 * The workspace's opportunities with their evidence, open ones first by
 * priority. Ones past their relevance window are expired before listing.
 */
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((v) =>
      v ? v.split(',').map((s) => s.trim().toUpperCase()) : undefined,
    )
    .pipe(z.array(z.enum(OPPORTUNITY_STATUSES)).optional()),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(req: Request) {
  try {
    const { company } = await requireActiveCompany();
    const { status, limit } = querySchema.parse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    const opportunities = await listOpportunities(company.id, {
      status,
      limit,
    });
    return jsonOk({ opportunities });
  } catch (error) {
    return handleRouteError(error);
  }
}
