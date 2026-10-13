import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { outreachStatusActionSchema } from '@/lib/validations/outreach';
import { transitionMessage } from '@/server/outreach/outreach.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * POST /api/outreach/messages/:id/status — approve/reject/submit an outreach
 * message. Approving requires content:approve (OWNER/ADMIN). Approved messages
 * flow to the extension queue; only a human click there marks them SENT.
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    const { action, reason } = outreachStatusActionSchema.parse(await req.json());

    // Approving/rejecting is the human gate — restrict to approvers.
    if (
      (action === 'approve' || action === 'reject') &&
      !can(membership.role, 'content:approve')
    ) {
      return jsonError('Only owners/admins can approve or reject outreach.', 403);
    }

    const msg = await transitionMessage({
      companyId: company.id,
      userId: user.id,
      role: membership.role,
      messageId: params.id,
      action,
      reason,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ id: msg.id, status: msg.status });
  } catch (error) {
    return handleRouteError(error);
  }
}
