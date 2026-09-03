import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { runAutopilot } from '@/server/briefing/autopilot.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const maxDuration = 300;

/**
 * POST /api/cron/briefing — the weekly autonomous cycle.
 *
 * This is the job that makes Aura an employee: for every workspace it writes
 * the week's posts, illustrates them, and assembles the Monday briefing.
 *
 * Platform-agnostic (any scheduler), protected by the shared CRON_SECRET, and
 * modelled on app/api/cron/competitors/route.ts — sequential per company,
 * fail-closed auth, and one failing workspace is logged and skipped rather than
 * taking the whole run down.
 *
 * Run it EARLY MONDAY, before people start their week:
 *   Vercel Cron:  { "path": "/api/cron/briefing", "schedule": "0 5 * * 1" }
 *   curl:         curl -X POST .../api/cron/briefing -H "authorization: Bearer $CRON_SECRET"
 *
 * Safe to run more than once: `runAutopilot` is idempotent per company per
 * week, so a retry re-assembles the briefing without writing a second set of
 * posts or spending a second time on graphics.
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
    let ran = 0;
    let skipped = 0;
    let failed = 0;
    let drafts = 0;
    let graphics = 0;

    for (const { id } of companies) {
      try {
        const result = await runAutopilot({ companyId: id, userId: null });
        if (result.ran) ran++;
        else skipped++;
        drafts += result.activity.draftsWritten;
        graphics += result.activity.graphicsGenerated;
      } catch (err) {
        failed++;
        logger.error('cron/briefing: company failed', {
          companyId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return jsonOk({
      processed: companies.length,
      ran,
      skipped,
      failed,
      draftsWritten: drafts,
      graphicsGenerated: graphics,
    });
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
