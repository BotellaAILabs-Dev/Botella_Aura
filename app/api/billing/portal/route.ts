import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { createPortalSession } from '@/server/billing/checkout.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/** POST /api/billing/portal — open the hosted Stripe Customer Portal. */
export async function POST() {
  try {
    const { company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:manageBilling')) {
      return jsonError('Only an owner can manage billing.', 403);
    }
    const url = await createPortalSession(company.id);
    return jsonOk({ url });
  } catch (error) {
    return handleRouteError(error);
  }
}
