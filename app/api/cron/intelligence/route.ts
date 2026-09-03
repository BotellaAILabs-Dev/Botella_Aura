import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { generateIntelligenceSnapshot } from '@/server/intelligence/intelligence.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * POST /api/cron/intelligence — daily recomputation of the AI Marketing
 * Intelligence snapshot for every workspace.
 *
 * Running it on a schedule is what makes the dashboard's movement indicator
 * meaningful: a score is only comparable to yesterday's if yesterday's exists.
 * Idempotent per company/day (upsert on companyId+date), so a double-fire is safe.
 *
 *   Vercel Cron example (vercel.json):
 *     { "crons": [{ "path": "/api/cron/intelligence", "schedule": "0 5 * * *" }] }
 */
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if unconfigured
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function POST(req: Request) {
  try {
    if (!isAuthorized(req)) return jsonError('Unauthorized', 401);

    const companies = await db.company.findMany({ select: { id: true } });
    let ok = 0;
    let failed = 0;

    // Sequential: each pass makes a model call, and one tenant's failure must
    // never stop the rest.
    for (const { id } of companies) {
      try {
        await generateIntelligenceSnapshot({ companyId: id });
        ok++;
      } catch (err) {
        failed++;
        logger.error('cron/intelligence: snapshot failed', {
          companyId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('cron/intelligence complete', { ok, failed, total: companies.length });
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
