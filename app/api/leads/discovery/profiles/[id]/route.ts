import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { updateDiscoveryProfileSchema } from '@/lib/validations/discovery';
import { deleteProfile, updateProfile } from '@/server/leads/profile.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

/** PATCH /api/leads/discovery/profiles/:id — edit a profile. */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to manage discovery.', 403);
    }
    const input = updateDiscoveryProfileSchema.parse(await req.json());
    const profile = await updateProfile({
      companyId: company.id,
      userId: user.id,
      profileId: params.id,
      input,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ id: profile.id });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** DELETE /api/leads/discovery/profiles/:id — remove a profile. */
export async function DELETE(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to manage discovery.', 403);
    }
    await deleteProfile({
      companyId: company.id,
      userId: user.id,
      profileId: params.id,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
