import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { revokeInvitation } from '@/server/services/team.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/** DELETE /api/team/invitations/:id — revoke a pending invite. */
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'members:invite')) {
      return jsonError('Forbidden', 403);
    }
    await revokeInvitation(company.id, params.id, user.id);
    return jsonOk({ revoked: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
