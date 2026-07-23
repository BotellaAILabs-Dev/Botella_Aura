import { updateCompanySchema } from '@/lib/validations/company';
import { updateCompany } from '@/server/services/company.service';
import { requireCompanyRole } from '@/lib/auth-helpers';
import { getRequestMeta, handleRouteError, jsonOk } from '@/lib/api';

/**
 * PATCH /api/companies/:id — update a company profile (settings page).
 * RBAC: only OWNER/ADMIN may edit company settings (see lib/rbac.ts). The
 * requireCompanyRole guard throws ForbiddenError -> 403 for MEMBERs.
 */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user } = await requireCompanyRole(params.id, ['OWNER', 'ADMIN']);
    const input = updateCompanySchema.parse(await req.json());

    const company = await updateCompany({
      userId: user.id,
      companyId: params.id,
      input,
      requestMeta: getRequestMeta(req),
    });

    return jsonOk({
      id: company.id,
      name: company.name,
      website: company.website,
      industry: company.industry,
      brandVoiceNotes: company.brandVoiceNotes,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
