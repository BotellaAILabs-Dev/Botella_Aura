import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { generateAnalyticsReport } from '@/server/analytics/report.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const maxDuration = 300;

/**
 * POST /api/cron/analytics — weekly written report per company. Protect with
 * CRON_SECRET. Honest: empty weeks produce a plain "not enough activity" note.
 *
 * Vercel Cron: { "path": "/api/cron/analytics", "schedule": "0 8 * * 1" }
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
        await generateAnalyticsReport({ companyId: id });
        ok++;
      } catch (err) {
        failed++;
        logger.error('cron/analytics: company failed', {
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
