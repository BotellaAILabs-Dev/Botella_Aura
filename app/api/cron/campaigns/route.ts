import { executeDueCampaignTasks } from '@/server/campaigns/executor.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { logger } from '@/lib/logger';

export const maxDuration = 60;

/**
 * POST /api/cron/campaigns — the daily campaign conductor. Finds due PENDING
 * tasks for ACTIVE campaigns and triggers the existing Sprint 3-5 pipelines,
 * landing output in the normal approval queues. Protect with CRON_SECRET.
 * NON-NEGOTIABLE #2: it never publishes/sends — output is always a DRAFT.
 *
 * Vercel Cron: { "path": "/api/cron/campaigns", "schedule": "0 9 * * *" }
 */
function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function POST(req: Request) {
  try {
    if (!isAuthorized(req)) return jsonError('Unauthorized', 401);
    const result = await executeDueCampaignTasks();
    logger.info('cron/campaigns: run complete', result);
    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Vercel Cron invokes schedules with GET, never POST, so a POST-only handler
 * returns 405 and the job silently never runs. Vercel also attaches
 * `Authorization: Bearer $CRON_SECRET` itself when that variable is set, which
 * is exactly what `isAuthorized` already checks — so the same handler serves
 * both without weakening the guard. Manual/curl invocation over POST keeps
 * working unchanged.
 */
export const GET = POST;
