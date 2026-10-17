import { runConnectionSweep } from '@/server/connections/health.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * POST /api/cron/connections — token & connection health sweep: refreshes
 * tokens that expire within a day (where the provider allows), re-checks
 * connections not checked for six hours, and asks for reauthorization when
 * a connection expired, was revoked or lost a permission.
 *
 *   Vercel Cron: hourly ("0 * * * *").
 *   Local: curl -X POST localhost:3000/api/cron/connections -H "authorization: Bearer $CRON_SECRET"
 */
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
      return jsonError('Unauthorized', 401);
    }
    return jsonOk(await runConnectionSweep());
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Vercel Cron calls with GET (see app/api/cron/publish/route.ts). */
export const GET = POST;
