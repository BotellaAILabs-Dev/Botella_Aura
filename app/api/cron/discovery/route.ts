import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { runDiscovery } from '@/server/leads/discovery/discovery.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const maxDuration = 300;

/**
 * POST /api/cron/discovery — weekly auto-run of DiscoveryProfiles flagged
 * autoRun. Protect with CRON_SECRET. Idempotent-friendly: the orchestrator
 * dedupes against existing leads, so a repeat run adds no duplicates.
 *
 * Vercel Cron: { "path": "/api/cron/discovery", "schedule": "0 11 * * 1" }
 */
function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function POST(req: Request) {
  try {
    if (!isAuthorized(req)) return jsonError('Unauthorized', 401);
    const profiles = await db.discoveryProfile.findMany({
      where: { isActive: true, autoRun: true },
      select: { id: true, companyId: true },
    });
    let ok = 0;
    let failed = 0;
    for (const p of profiles) {
      try {
        await runDiscovery({ companyId: p.companyId, profileId: p.id });
        ok++;
      } catch (err) {
        failed++;
        logger.error('cron/discovery: profile failed', {
          profileId: p.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return jsonOk({ processed: profiles.length, ok, failed });
  } catch (error) {
    return handleRouteError(error);
  }
}
