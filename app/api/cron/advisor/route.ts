import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { generateAdvisorReport } from '@/server/advisor/advisor.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * POST /api/cron/advisor — refresh the AI Marketing Advisor's campaign
 * opportunities for every workspace.
 *
 * Competitor moves are time-sensitive: an opportunity worth acting on this week
 * is worth nothing next month, so this runs on a schedule rather than waiting
 * for someone to press a button. Idempotent per company/day.
 *
 *   Vercel Cron example (vercel.json):
 *     { "crons": [{ "path": "/api/cron/advisor", "schedule": "0 6 * * 1" }] }
 */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function POST(req: Request) {
  try {
    if (!isAuthorized(req)) return jsonError('Unauthorized', 401);

    const companies = await db.company.findMany({ select: { id: true } });
    let ok = 0;
    let failed = 0;

    for (const { id } of companies) {
      try {
        await generateAdvisorReport({ companyId: id });
        ok++;
      } catch (err) {
        failed++;
        logger.error('cron/advisor: report failed', {
          companyId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('cron/advisor complete', { ok, failed, total: companies.length });
    return jsonOk({ processed: companies.length, ok, failed });
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
