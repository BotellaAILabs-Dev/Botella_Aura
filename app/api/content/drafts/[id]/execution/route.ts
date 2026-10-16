import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { HANDOFF_STATUS_LABEL } from '@/lib/execution-handoff';
import { getDraft } from '@/server/content/content.service';
import { getExecutionHandoff } from '@/server/execution/execution-handoff.service';

/**
 * GET /api/content/drafts/:id/execution — the Approval → Execution handoff
 * (lib/execution-handoff.ts) as it stands now: the structured package the
 * Execution Engine consumes, re-validated on every read so a connection that
 * expired since approval shows up here, with what to fix. 404 for another
 * workspace's draft; `handoff: null` while it has never been approved.
 */
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const { company } = await requireActiveCompany();
    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Not found.', 404);
    const handoff = await getExecutionHandoff(company.id, draft.id);
    return jsonOk({
      handoff,
      status: handoff?.readiness.status ?? null,
      label: handoff ? HANDOFF_STATUS_LABEL[handoff.readiness.status] : 'Not approved yet',
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
