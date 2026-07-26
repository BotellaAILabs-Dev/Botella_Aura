import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { createDiscoveryProfileSchema } from '@/lib/validations/discovery';
import { createProfile, listProfiles } from '@/server/leads/profile.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

/** GET /api/leads/discovery/profiles — saved discovery profiles. */
export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    const profiles = await listProfiles(company.id);
    return jsonOk({ profiles });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/leads/discovery/profiles — create a profile (OWNER/ADMIN). */
export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to manage discovery.', 403);
    }
    const input = createDiscoveryProfileSchema.parse(await req.json());
    const profile = await createProfile({
      companyId: company.id,
      userId: user.id,
      input,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ id: profile.id, name: profile.name }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
