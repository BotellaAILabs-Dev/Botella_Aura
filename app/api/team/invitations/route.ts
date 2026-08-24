import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { inviteMember, getTeam } from '@/server/services/team.service';
import { inviteMemberSchema } from '@/lib/validations/team';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

/** GET /api/team/invitations — pending invites for the active company. */
export async function GET() {
  try {
    const { company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'members:invite')) {
      return jsonError('Forbidden', 403);
    }
    const { invitations } = await getTeam(company.id);
    return jsonOk({ invitations });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/team/invitations — invite someone to the active company. */
export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'members:invite')) {
      return jsonError('You do not have permission to invite members.', 403);
    }
    const { email, role } = inviteMemberSchema.parse(await req.json());

    const result = await inviteMember({
      companyId: company.id,
      companyName: company.name,
      inviterId: user.id,
      inviterName: user.name ?? null,
      inviterRole: membership.role,
      email,
      role,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk(result, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
