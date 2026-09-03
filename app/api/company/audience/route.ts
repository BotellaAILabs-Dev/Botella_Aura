import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { marketingProfileSchema } from '@/lib/validations/profile';
import { saveMarketingProfile } from '@/server/company/profile.service';

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
    const { company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('Only owners and admins can change this.', 403);
    }

    const input = marketingProfileSchema.parse(await req.json());
    await saveMarketingProfile(company.id, input);

    return jsonOk({ profile: input });
  } catch (error) {
    return handleRouteError(error);
  }
}

