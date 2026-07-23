import { runScheduledPublishes } from '@/server/content/publish.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * POST /api/cron/publish — scheduled-publish job. Same protected-endpoint
 * pattern as Sprint 2's digest cron. Idempotent (only publishes due, APPROVED,
 * not-yet-published drafts).
 *
 *   Vercel Cron: run every 15 minutes (cron "0,15,30,45 * * * *").
 *   Local:  curl -X POST localhost:3000/api/cron/publish -H "authorization: Bearer $CRON_SECRET"
 */
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
      return jsonError('Unauthorized', 401);
    }
    const result = await runScheduledPublishes();
    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
