import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { contentFormatsSchema } from '@/lib/validations/profile';
import { saveContentFormats } from '@/server/company/profile.service';

/**
 * PATCH /api/company/formats — which content formats this workspace uses.
 *
 * Narrowing here is a presentation choice, not a permission: it decides what
 * Content Studio offers, and the generate route enforces the same list so a
 * disabled format cannot be reached by posting to the API directly. Same
 * active-company scoping and permission as the audience and brand routes.
 */
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request) {
  try {
    const { company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('Only owners and admins can change this.', 403);
    }

    const input = contentFormatsSchema.parse(await req.json());
    await saveContentFormats(company.id, input);

    return jsonOk({ formats: input });
  } catch (error) {
    return handleRouteError(error);
  }
}
