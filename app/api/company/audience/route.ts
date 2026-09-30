import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { marketingProfileSchema } from '@/lib/validations/profile';
import { updateBusinessContext } from '@/server/business-context/business-context-write.service';
import { AUDIENCE_ALIASES, audiencePatch } from '@/server/business-context/adapters';

/**
 * PATCH /api/company/audience — who this workspace markets to, and what it is
 * trying to achieve.
 *
 * This is the single most valuable thing a user can tell Aura: the content
 * generator reads it on every draft (server/content/audience.ts), and the
 * planner uses it to pre-fill the brief. Same active-company scoping and same
 * permission as the brand route.
 */
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request) {
  try {
    const { company, membership, user } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('Only owners and admins can change this.', 403);
    }

    const raw = (await req.json()) as unknown;
    const input = marketingProfileSchema.parse(raw);
    // Through the Business Context service: same rules as every other screen,
    // errors come back under this form's field names.
    await updateBusinessContext({
      companyId: company.id,
      userId: user.id,
      patch: audiencePatch(input, raw),
      origin: 'settings',
      aliases: AUDIENCE_ALIASES,
      requestMeta: getRequestMeta(req),
    });

    return jsonOk({ profile: input });
  } catch (error) {
    return handleRouteError(error);
  }
}

