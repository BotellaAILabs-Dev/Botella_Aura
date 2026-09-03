import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { trackCompany } from '@/server/competitors/tracking.service';
import { generateWeeklyReport } from '@/server/competitors/report.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const maxDuration = 300;

/**
 * POST /api/cron/competitors — weekly competitor tracking + report job.
 * Platform-agnostic (any scheduler): protect with the shared CRON_SECRET.
 * Mirrors app/api/cron/trends/route.ts: sequential per-company, fail-closed
 * auth, and a single company failure is logged and skipped, never fatal.
 *
 * Vercel Cron (vercel.json):
 *   { "path": "/api/cron/competitors", "schedule": "0 13 * * 1" }  // Mondays
 */
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

    for (const { id } of companies) {
      try {
        await trackCompany(id);
        await generateWeeklyReport({ companyId: id });
        ok++;
      } catch (err) {
        failed++;
        logger.error('cron/competitors: company failed', {
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
