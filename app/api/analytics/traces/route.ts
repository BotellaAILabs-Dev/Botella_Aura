import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonOk } from '@/lib/api';
import { traceRows } from '@/server/trace/trace.service';

/**
 * GET /api/analytics/traces?since=ISO&limit=N
 *
 * For analytics and measurement: every approved or published asset with its
 * chain ids, flat — business context revision, signals, opportunity,
 * recommendation, brief, reviewed and approved versions, the approval, the
 * images, where it was published and its performance snapshots. One row per
 * asset; join on assetId or traceId.
 */
export const dynamic = 'force-dynamic';

const query = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function GET(req: Request) {
  try {
    const { company } = await requireActiveCompany();
    const url = new URL(req.url);
    const q = query.parse({
      since: url.searchParams.get('since') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });
    const rows = await traceRows(company.id, {
      ...(q.since ? { since: new Date(q.since) } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    });
    return jsonOk({ rows });
  } catch (error) {
    return handleRouteError(error);
  }
}
