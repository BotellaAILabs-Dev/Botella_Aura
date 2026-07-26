import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { removeTarget } from '@/server/engagement/target.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

/** DELETE /api/engagement/targets/:id — stop monitoring a profile. */
export async function DELETE(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('You do not have permission to manage targets.', 403);
    }
    await removeTarget({
      companyId: company.id,
      userId: user.id,
      targetId: params.id,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
