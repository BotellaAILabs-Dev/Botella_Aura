import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { contentFormatsSchema } from '@/lib/validations/profile';
import { updateBusinessContext } from '@/server/business-context/business-context-write.service';
import { FORMATS_ALIASES, formatsPatch } from '@/server/business-context/adapters';

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
    const { company, membership, user } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('Only owners and admins can change this.', 403);
    }

    const input = contentFormatsSchema.parse(await req.json());
    await updateBusinessContext({
      companyId: company.id,
      userId: user.id,
      patch: formatsPatch(input),
      origin: 'settings',
      aliases: FORMATS_ALIASES,
      requestMeta: getRequestMeta(req),
    });

    return jsonOk({ formats: input });
  } catch (error) {
    return handleRouteError(error);
  }
}
