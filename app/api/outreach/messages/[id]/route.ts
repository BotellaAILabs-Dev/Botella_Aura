import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { updateOutreachMessageSchema } from '@/lib/validations/outreach';
import { updateMessageText } from '@/server/outreach/outreach.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

/** PATCH /api/outreach/messages/:id — edit draft text (returns it to DRAFT). */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to edit messages.', 403);
    }
    const { draftText } = updateOutreachMessageSchema.parse(await req.json());
    const msg = await updateMessageText({
      companyId: company.id,
      userId: user.id,
      messageId: params.id,
      draftText,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ id: msg.id, status: msg.status });
  } catch (error) {
    return handleRouteError(error);
  }
}
