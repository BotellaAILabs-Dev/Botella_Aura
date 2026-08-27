import { requireActiveCompany } from '@/lib/auth-helpers';
import { claimJob, completeJob, failJob, getJob } from '@/server/jobs/job.service';
import { runJob } from '@/server/jobs/runners';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

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
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
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
      await failJob(job.id, err);
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(message, 502);
    }
  } catch (error) {
    return handleRouteError(error);
  }
}
