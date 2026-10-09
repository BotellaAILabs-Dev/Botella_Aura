import { requireActiveCompany } from '@/lib/auth-helpers';
import { getJob, readProgress } from '@/server/jobs/job.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** GET /api/jobs/:id — poll target. Cheap by design; called every ~1.5s. */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    const job = await getJob(company.id, params.id);
    if (!job) return jsonError('Job not found.', 404);

    return jsonOk({
      id: job.id,
      kind: job.kind,
      status: job.status,
      progress: readProgress(job),
      result: job.result,
      error: job.error,
      attempts: job.attempts,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
