import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { contactFactsSchema } from '@/lib/validations/profile';
import { getBusinessFacts, saveContactFacts } from '@/server/company/profile.service';
import { recordAudit } from '@/server/services/audit.service';

/**
 * The business's contact facts (address, phone, contact email), offered to
 * posts as pre-approved details (lib/post-details.ts).
 *
 * GET   — the facts a post may use, including the website.
 * PATCH — { address?, phone?, contactEmail? } (owners and admins); an empty
 *         value removes it.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    return jsonOk({ facts: await getBusinessFacts(company.id) });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(req: Request) {
  try {
    const { company, membership, user } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('Only owners and admins can change business information.', 403);
    }
    const parsed = contactFactsSchema.safeParse(await req.json());
    if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Check the details.', 422);
    await saveContactFacts(company.id, parsed.data);
    await recordAudit({
      action: 'COMPANY_UPDATED',
      userId: user.id,
      companyId: company.id,
      metadata: { contactFacts: Object.keys(parsed.data).filter((k) => parsed.data[k as keyof typeof parsed.data]) },
    });
    return jsonOk({ facts: await getBusinessFacts(company.id) });
  } catch (error) {
    return handleRouteError(error);
  }
}
