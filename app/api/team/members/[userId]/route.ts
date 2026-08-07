import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { updateMemberRole, removeMember } from '@/server/services/team.service';
import { updateRoleSchema } from '@/lib/validations/team';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/** PATCH /api/team/members/:userId — change a member's role. */
export async function PATCH(
  req: Request,
  { params }: { params: { userId: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'members:remove')) {
      return jsonError('You do not have permission to manage members.', 403);
    }
    const { role } = updateRoleSchema.parse(await req.json());
    await updateMemberRole({
      companyId: company.id,
      actorId: user.id,
      actorRole: membership.role,
      targetUserId: params.userId,
      role,
    });
    return jsonOk({ updated: true });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** DELETE /api/team/members/:userId — remove a member from the company. */
export async function DELETE(
  _req: Request,
  { params }: { params: { userId: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'members:remove')) {
      return jsonError('You do not have permission to remove members.', 403);
    }
    await removeMember({
      companyId: company.id,
      actorId: user.id,
      targetUserId: params.userId,
    });
    return jsonOk({ removed: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
