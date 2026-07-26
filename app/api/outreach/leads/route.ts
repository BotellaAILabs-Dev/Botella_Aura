import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { createLeadSchema } from '@/lib/validations/outreach';
import { createLead, listLeads } from '@/server/outreach/lead.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

/** GET /api/outreach/leads — leads with signals + messages (any member). */
export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    const leads = await listLeads(company.id);
    return jsonOk({ leads });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/outreach/leads — manually add a lead (OWNER/ADMIN). */
export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to add leads.', 403);
    }
    const input = createLeadSchema.parse(await req.json());
    const lead = await createLead({
      companyId: company.id,
      userId: user.id,
      input,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ id: lead.id }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
