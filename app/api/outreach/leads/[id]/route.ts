import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { updateLeadSchema } from '@/lib/validations/outreach';
import { removeLead, updateLead } from '@/server/outreach/lead.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

/** PATCH /api/outreach/leads/:id — edit a lead (add person, status, etc.). */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to edit leads.', 403);
    }
    const input = updateLeadSchema.parse(await req.json());
    const lead = await updateLead({
      companyId: company.id,
      userId: user.id,
      leadId: params.id,
      input,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ id: lead.id, status: lead.status });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** DELETE /api/outreach/leads/:id — remove a lead. */
export async function DELETE(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to remove leads.', 403);
    }
    await removeLead({
      companyId: company.id,
      userId: user.id,
      leadId: params.id,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
