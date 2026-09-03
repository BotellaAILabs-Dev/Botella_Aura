import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { generateMemories } from '@/server/memory/extraction.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const maxDuration = 60;

/**
 * POST /api/cron/memory — weekly per-company pattern extraction. Protect with
 * CRON_SECRET. Honest by construction: low-sample companies get a "not enough
 * data" note, never fabricated insights.
 *
 * Vercel Cron: { "path": "/api/cron/memory", "schedule": "0 10 * * 1" }
 */
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
        await generateMemories({ companyId: id });
        ok++;
      } catch (err) {
        failed++;
        logger.error('cron/memory: company failed', {
          companyId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
