import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { brandAssetsSchema } from '@/lib/validations/profile';
import { saveBrandAssets } from '@/server/company/profile.service';

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
    const { company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('Only owners and admins can change brand assets.', 403);
    }

    const input = brandAssetsSchema.parse(await req.json());
    await saveBrandAssets(company.id, input);

    return jsonOk({ brand: input });
  } catch (error) {
    return handleRouteError(error);
  }
}

