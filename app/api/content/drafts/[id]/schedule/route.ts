import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { scheduleDraftSchema } from '@/lib/validations/content';
import { scheduleDraft } from '@/server/content/content.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/** POST /api/content/drafts/:id/schedule — schedule an APPROVED draft. */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:publish')) {
      return jsonError('You are not permitted to schedule publishing.', 403);
    }
    const { scheduledFor } = scheduleDraftSchema.parse(await req.json());
    const draft = await scheduleDraft({
      companyId: company.id,
      userId: user.id,
      draftId: params.id,
      scheduledFor: new Date(scheduledFor),
    });
    return jsonOk({ id: draft.id, scheduledFor: draft.scheduledFor });
  } catch (error) {
    return handleRouteError(error);
  }
}
