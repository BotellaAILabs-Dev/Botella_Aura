import { requireActiveCompany } from '@/lib/auth-helpers';
import { claimJob, completeJob, failJob, getJob } from '@/server/jobs/job.service';
import { runJob } from '@/server/jobs/runners';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { can } from '@/lib/rbac';

/**
 * POST /api/jobs/:id/run — execute a queued job.
 *
 * This is the request that actually costs five minutes, and nobody is waiting
 * on its response: the browser fires it and immediately starts polling
 * GET /api/jobs/:id instead. Server-side it keeps running to completion even
 * if the tab closes.
 *
 * Safe to call more than once — claimJob() only succeeds for whoever moves the
 * row out of QUEUED, so a duplicate kick from the cron reaper is a no-op.
 */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError('Your role is read-only and cannot run generation.', 403);
    }
    const existing = await getJob(company.id, params.id);
    if (!existing) return jsonError('Job not found.', 404);

    const job = await claimJob(params.id);
    if (!job) {
      // Already claimed, already finished, or failed past its retry budget.
      return jsonOk({ ran: false, status: existing.status });
    }

    try {
      const result = await runJob(job);
      await completeJob(job.id, result as Record<string, never>);
      return jsonOk({ ran: true, status: 'SUCCEEDED', result });
    } catch (err) {
      /**
       * A failed JOB is not a failed REQUEST.
       *
       * This used to answer 502. Nothing consumed it — the client kicks this
       * endpoint fire-and-forget and reads the outcome by polling
       * /api/jobs/:id — so the status reached no code path. What it did reach
       * was the browser console, where a red 502 on our own origin reads as a
       * gateway or proxy failure and sends whoever is debugging to look for an
       * upstream that does not exist in this stack.
       *
       * The run genuinely happened: it executed, it failed, and failJob has
       * recorded the real error and the right terminal state. So the request
       * succeeded, and the job's own status carries the bad news.
       */
      await failJob(job.id, err);
      const message = err instanceof Error ? err.message : String(err);
      return jsonOk({ ran: true, status: 'FAILED', error: message });
    }
  } catch (error) {
    return handleRouteError(error);
  }
}
