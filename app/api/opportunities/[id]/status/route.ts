import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { OPPORTUNITY_STATUSES } from '@/lib/opportunities';
import { transitionOpportunity } from '@/server/opportunities/opportunity.service';

/**
 * POST /api/opportunities/:id/status { status, note? }
 *
 * Move an opportunity through its lifecycle. Only allowed transitions succeed
 * (409 otherwise, or if someone else changed it first); every change is kept
 * in its history with who made it and why.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  status: z.enum(OPPORTUNITY_STATUSES),
  note: z.string().trim().max(2000).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company, membership, user } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError(
        'Only owners and admins can change an opportunity’s status.',
        403,
      );
    }
    const { status, note } = bodySchema.parse(await req.json());
    const opportunity = await transitionOpportunity({
      companyId: company.id,
      opportunityId: params.id,
      to: status,
      actorId: user.id,
      note,
    });
    return jsonOk({ opportunity });
  } catch (error) {
    return handleRouteError(error);
  }
}
