import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { detectForCompany } from '@/server/outreach/detect.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const maxDuration = 300;

/**
 * POST /api/cron/outreach — scheduled lead-signal detection across companies.
 * Protect with CRON_SECRET. Detection only DRAFTS/surfaces leads; nothing is
 * ever sent without human approval + a human click in the extension.
 *
 * Vercel Cron: { "path": "/api/cron/outreach", "schedule": "0 12 * * *" }
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
        await detectForCompany({ companyId: id });
        ok++;
      } catch (err) {
        failed++;
        logger.error('cron/outreach: company failed', {
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
