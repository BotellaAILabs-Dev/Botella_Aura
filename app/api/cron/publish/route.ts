import { runScheduledPublishes } from '@/server/content/publish.service';
import { advanceProcessing } from '@/server/content/processing.service';
import { runExecutionSweep } from '@/server/execution/execution-actions.service';
import { collectMetaInsights } from '@/server/connectors/meta-insights.service';
import { runDueWebsitePublishing } from '@/server/websites/publish.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { isCronAuthorized } from '@/lib/cron-auth';

/**
 * GET/POST /api/cron/publish — the scheduled-publish job
 * (docs/SCHEDULER.md). Protected by `Authorization: Bearer $CRON_SECRET`.
 *
 * Safe to call as often as every minute, and by more than one scheduler at
 * once (Vercel Cron and an external one):
 *   - only APPROVED posts whose time has come, oldest first
 *   - each publish is claimed first (server/content/publication-store.ts), so
 *     overlapping runs can never post the same thing twice
 *   - a failed or manual attempt waits for a person; only rate-limited ones
 *     are retried automatically, after their backoff
 *   - work stops being started after ~45 s, so the function is never stopped
 *     mid-publish; whatever is left goes on the next run
 *   - blogs scheduled for connected websites, and recurring auto-publish
 *     slots, go out under the same rules (server/websites/publish.service.ts)
 *
 *   Local: curl -X POST localhost:3000/api/cron/publish -H "authorization: Bearer $CRON_SECRET"
 */
export const maxDuration = 60;

/** Leave room under maxDuration for the slowest network call (~10 s) to finish. */
const BUDGET_MS = 45_000;

export async function POST(req: Request) {
  try {
    if (!isCronAuthorized(req)) return jsonError('Unauthorized', 401);
    const started = Date.now();
    const deadline = new Date(started + BUDGET_MS);
    const result = await runScheduledPublishes(new Date(), { deadline });
    const processing = await advanceProcessing();
    // Rate-limited executions whose backoff is over (lib/execution-state.ts).
    const retries = await runExecutionSweep(new Date(), { deadline });
    // Blogs to connected websites (scheduled + recurring auto-publish).
    const websites = await runDueWebsitePublishing(new Date(), { deadline });
    // Organic analytics, only with time to spare (it is never urgent).
    const insights = Date.now() < deadline.getTime() ? await collectMetaInsights().catch(() => null) : null;
    return jsonOk({ ...result, processing, retries, websites, insights, ms: Date.now() - started });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Vercel Cron invokes schedules with GET, never POST, so a POST-only handler
 * returns 405 and the job silently never runs. Vercel also attaches
 * `Authorization: Bearer $CRON_SECRET` itself when that variable is set, which
 * is exactly what `isCronAuthorized` checks — so the same handler serves both
 * without weakening the guard. Manual/curl invocation over POST keeps working.
 */
export const GET = POST;
