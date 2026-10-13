import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { resolveTrace } from '@/server/trace/trace.service';

/**
 * GET /api/content/drafts/:id/trace — why this asset exists (lib/trace.ts):
 * the business context, signals, opportunity, recommendation and brief
 * behind it, and which version was reviewed and approved — with every id.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    const trace = await resolveTrace(company.id, params.id);
    if (!trace) return jsonError('Not found.', 404);
    return jsonOk({ trace });
  } catch (error) {
    return handleRouteError(error);
  }
}
