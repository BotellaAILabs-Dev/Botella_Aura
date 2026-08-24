import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { planInputsSchema } from '@/lib/validations/planner';
import { generateMarketingPlan } from '@/server/planner/plan.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

// A month of calendar items is a large, high-effort generation.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * POST /api/planner — generate the monthly content calendar from an explicit
 * brief (business goals, campaign objectives, topics, brand guidelines).
 * Idempotent per company/month: regenerating replaces that month's plan.
 */
export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError('You do not have permission to build a plan.', 403);
    }
    const inputs = planInputsSchema.parse(await req.json());
    const plan = await generateMarketingPlan({
      companyId: company.id,
      userId: user.id,
      inputs,
    });
    return jsonOk({
      month: plan.month,
      items: plan.items.length,
      model: plan.model,
    }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
