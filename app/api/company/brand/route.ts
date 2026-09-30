import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { brandAssetsSchema } from '@/lib/validations/profile';
import { updateBusinessContext } from '@/server/business-context/business-context-write.service';
import { BRAND_ALIASES, brandPatch } from '@/server/business-context/adapters';

/**
 * PATCH /api/company/brand — the workspace's logo and colour palette.
 *
 * Scoped to the caller's ACTIVE company rather than an id in the path, so there
 * is no company id to tamper with; the same reason the connector routes work
 * this way. Editing brand assets is a company settings change, so it takes the
 * same 'company:update' permission as the rest of settings.
 */
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request) {
  try {
    const { company, membership, user } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('Only owners and admins can change brand assets.', 403);
    }

    const raw = (await req.json()) as unknown;
    const input = brandAssetsSchema.parse(raw);
    // A logo id sent here must be one of this workspace's own assets — the
    // service checks, where this route used to store any string it was given.
    await updateBusinessContext({
      companyId: company.id,
      userId: user.id,
      patch: brandPatch(input, raw),
      origin: 'settings',
      aliases: BRAND_ALIASES,
      requestMeta: getRequestMeta(req),
    });

    return jsonOk({ brand: input });
  } catch (error) {
    return handleRouteError(error);
  }
}

