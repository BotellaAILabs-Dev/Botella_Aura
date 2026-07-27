import { z } from 'zod';
import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { createCheckoutSession } from '@/server/billing/checkout.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

const bodySchema = z.object({ plan: z.enum(['STARTER', 'GROWTH', 'AGENCY']) });

/** POST /api/billing/checkout — start a hosted Stripe Checkout for a plan. */
export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:manageBilling')) {
      return jsonError('Only an owner can manage billing.', 403);
    }
    const { plan } = bodySchema.parse(await req.json());
    const url = await createCheckoutSession({
      companyId: company.id,
      userId: user.id,
      plan,
      email: user.email,
    });
    return jsonOk({ url });
  } catch (error) {
    return handleRouteError(error);
  }
}
