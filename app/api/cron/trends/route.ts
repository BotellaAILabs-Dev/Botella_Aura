import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { generateDigestForCompany } from '@/server/trends/digest.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * POST /api/cron/trends — the scheduled daily digest job.
 *
 * SCHEDULING (chosen approach): a plain protected HTTP endpoint triggered by a
 * cron scheduler. Justification: it's platform-agnostic and the leanest option
 * for Sprint 1's single-app deploy — Vercel Cron, GitHub Actions, or any
 * `curl` on a crontab can hit it, with no queue/worker infrastructure to run.
 * If volume grows, the same endpoint can enqueue per-company jobs instead of
 * looping inline — no caller changes.
 *
 *   Vercel Cron example (vercel.json):
 *     { "crons": [{ "path": "/api/cron/trends", "schedule": "0 13 * * *" }] }
 *   Local test:
 *     curl -X POST localhost:3000/api/cron/trends -H "authorization: Bearer $CRON_SECRET"
 *
 * Idempotent per company/day (upsert on companyId+date), so a double-fire is safe.
 */
// 60s is the ceiling on every Vercel plan including Hobby. Companies are
// processed one at a time and each is committed as it finishes, so a timeout
// part-way through loses no completed work — the next run picks up the rest.
export const maxDuration = 60;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if unconfigured
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${secret}`;
}

export async function POST(req: Request) {
  try {
    if (!isAuthorized(req)) {
      return jsonError('Unauthorized', 401);
    }

    const companies = await db.company.findMany({ select: { id: true } });
    let ok = 0;
    let failed = 0;

    // Sequential to be gentle on third-party rate limits shared across tenants.
    for (const { id } of companies) {
      try {
        await generateDigestForCompany({ companyId: id, trigger: 'scheduled' });
        ok++;
      } catch (err) {
        failed++;
        logger.error('cron/trends: company digest failed', {
          companyId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('cron/trends complete', { ok, failed, total: companies.length });
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
