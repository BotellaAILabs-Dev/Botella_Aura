import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { outreachConfigSchema } from '@/lib/validations/outreach';
import {
  ensureOutreachConfig,
  updateOutreachConfig,
} from '@/server/outreach/config.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

/** GET /api/outreach/config — current targeting config. */
export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    const config = await ensureOutreachConfig(company.id);
    return jsonOk({ config });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** PUT /api/outreach/config — update targeting (OWNER/ADMIN). */
export async function PUT(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('You do not have permission to change outreach settings.', 403);
    }
    const input = outreachConfigSchema.parse(await req.json());
    const config = await updateOutreachConfig({
      companyId: company.id,
      userId: user.id,
      input,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ config });
  } catch (error) {
    return handleRouteError(error);
  }
}
