import { requireUser } from '@/lib/auth-helpers';
import { acceptInvitation } from '@/server/services/team.service';
import { acceptInviteSchema } from '@/lib/validations/team';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/** POST /api/invitations/accept — the logged-in user accepts an invite token. */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    if (!user.email) return jsonError('Your account has no email.', 400);
    const { token } = acceptInviteSchema.parse(await req.json());

    const result = await acceptInvitation(token, user.id, user.email);
    return jsonOk({ companyId: result.companyId });
  } catch (error) {
    return handleRouteError(error);
  }
}
