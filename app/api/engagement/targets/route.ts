import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { createTargetSchema } from '@/lib/validations/engagement';
import { addTarget, listTargets } from '@/server/engagement/target.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

/** GET /api/engagement/targets — monitored public profiles/pages. */
export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    const targets = await listTargets(company.id);
    return jsonOk({ targets });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/engagement/targets — add a monitored profile (OWNER/ADMIN). */
export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('You do not have permission to manage targets.', 403);
    }
    const input = createTargetSchema.parse(await req.json());
    const target = await addTarget({
      companyId: company.id,
      userId: user.id,
      input,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ id: target.id }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
