import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { enqueueJob, latestJob, readProgress } from '@/server/jobs/job.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';

const KINDS = ['TREND_DIGEST', 'MARKETING_PLAN', 'INTELLIGENCE'] as const;

const createSchema = z.object({
  kind: z.enum(KINDS),
  inputs: z.record(z.unknown()).optional(),
});

/**
 * POST /api/jobs — queue a long generation and return immediately.
 *
 * The response is the job, not the result. The client then kicks
 * POST /api/jobs/:id/run (without awaiting it) and polls GET /api/jobs/:id.
 * That split is what keeps a five-minute digest off the request the user is
 * waiting on.
 */
export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError('You do not have permission to run this.', 403);
    }
    const { kind, inputs } = createSchema.parse(await req.json());

    const { job, reused } = await enqueueJob({
      companyId: company.id,
      userId: user.id,
      kind,
      inputs: (inputs ?? {}) as Record<string, never>,
    });

    return jsonOk(
      {
        id: job.id,
        kind: job.kind,
        status: job.status,
        progress: readProgress(job),
        createdAt: job.createdAt,
        // Tells the client to attach to a run already in flight rather than
        // reporting a second one it did not start.
        reused,
      },
      reused ? 200 : 201,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

/** GET /api/jobs?kind=… — the most recent job of a kind, for reattaching. */
export async function GET(req: Request) {
  try {
    const { company } = await requireActiveCompany();
    const kind = new URL(req.url).searchParams.get('kind');
    const parsed = z.enum(KINDS).safeParse(kind);
    if (!parsed.success) return jsonError('Unknown job kind.', 400);

    const job = await latestJob(company.id, parsed.data);
    if (!job) return jsonOk({ job: null });
    return jsonOk({
      job: {
        id: job.id,
        kind: job.kind,
        status: job.status,
        progress: readProgress(job),
        result: job.result,
        error: job.error,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
