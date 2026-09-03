import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  claimJob,
  completeJob,
  failJob,
  reapStuckJobs,
} from '@/server/jobs/job.service';
import { runJob } from '@/server/jobs/runners';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * POST /api/cron/jobs — the safety net under the generation queue.
 *
 * Two things it fixes, both of which previously looked like a hang to the user:
 * a RUNNING job whose serverless instance was killed mid-flight, and a QUEUED
 * job whose client kick never arrived (tab closed, network dropped). Neither
 * can resolve itself, so this sweeps them: interrupted work is requeued and
 * retried, and anything past its retry budget is failed with a message the UI
 * can actually show.
 *
 *   Vercel Cron example (vercel.json):
 *     { "crons": [{ "path": "/api/cron/jobs", "schedule": "*\/5 * * * *" }] }
 */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/** Keep one sweep inside the function budget; the next tick takes the rest. */
const MAX_PER_SWEEP = 3;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if unconfigured
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function POST(req: Request) {
  try {
    if (!isAuthorized(req)) return jsonError('Unauthorized', 401);

    const { failed, runnable } = await reapStuckJobs();

    let ran = 0;
    for (const jobId of runnable.slice(0, MAX_PER_SWEEP)) {
      const job = await claimJob(jobId);
      if (!job) continue; // someone else got there first
      try {
        const result = await runJob(job);
        await completeJob(job.id, result as Record<string, never>);
        ran++;
      } catch (err) {
        await failJob(job.id, err);
        logger.error('cron/jobs: run failed', {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Old finished rows are noise; the UI only ever reads recent ones.
    const { count: pruned } = await db.generationJob.deleteMany({
      where: {
        status: { in: ['SUCCEEDED', 'FAILED'] },
        finishedAt: { lt: new Date(Date.now() - 7 * 86_400_000) },
      },
    });

    logger.info('cron/jobs complete', { ran, failed, pruned });
    return jsonOk({ ran, failed, queued: runnable.length, pruned });
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
