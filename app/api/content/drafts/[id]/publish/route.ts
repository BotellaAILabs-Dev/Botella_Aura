import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { publishDraft } from '@/server/content/publish.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * POST /api/content/drafts/:id/publish — publish an APPROVED draft.
 * RBAC: requires the content:publish permission. Returns a structured result:
 * `published` (real official-API post), `manual` (copy-for-manual fallback), or
 * `reconnect`. Never fakes a published state.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:publish')) {
      return jsonError('You are not permitted to publish content.', 403);
    }

    const result = await publishDraft({
      companyId: company.id,
      userId: user.id,
      draftId: params.id,
    });
    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
