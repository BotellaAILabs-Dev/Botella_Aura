import { executeDueCampaignTasks } from '@/server/campaigns/executor.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { logger } from '@/lib/logger';

export const maxDuration = 300;

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
