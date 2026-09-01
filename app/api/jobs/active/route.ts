import { db } from '@/lib/db';
import { requireActiveCompany } from '@/lib/auth-helpers';
import { readProgress } from '@/server/jobs/job.service';
import { handleRouteError, jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * GET /api/jobs/active — every generation in flight for this workspace, plus
 * anything that finished in the last few minutes.
 *
 * This is what lets a background job actually be a background job. Polling from
 * the page that started it only works while the user stays there; the app-wide
 * indicator reads from here instead, so a digest started on Trends still
 * reports its progress — and its completion — from anywhere in the product.
 */
const RECENTLY_FINISHED_MS = 5 * 60 * 1000;

export async function GET() {
  try {
    const { company } = await requireActiveCompany();

    const jobs = await db.generationJob.findMany({
      where: {
        companyId: company.id,
        OR: [
          { status: { in: ['QUEUED', 'RUNNING'] } },
          { finishedAt: { gte: new Date(Date.now() - RECENTLY_FINISHED_MS) } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    return jsonOk({
      jobs: jobs.map((job) => ({
        id: job.id,
        kind: job.kind,
        status: job.status,
        progress: readProgress(job),
        error: job.error,
        finishedAt: job.finishedAt?.toISOString() ?? null,
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
