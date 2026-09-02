import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonOk } from '@/lib/api';
import { listProviders } from '@/server/media/providers';
import { getEffectivePlan } from '@/server/billing/entitlements';
import { assetsThisMonth } from '@/server/media/asset.service';
import { activeStore } from '@/server/media/storage';

/**
 * GET /api/content/graphics/providers
 *
 * What the model selector renders from. Reports every implemented provider with
 * whether THIS deployment can use it, and names the missing environment
 * variable when it cannot — the same honesty the Connectors page applies, so an
 * unconfigured provider reads as "add a key" rather than a dead radio button.
 *
 * Also returns the workspace's remaining monthly allowance, so the studio can
 * show what a generation will spend before the user spends it.
 *
 * Authenticated: the set of configured providers is deployment configuration,
 * not public information.
 */
// Reads the session and the workspace's usage, so it can never be prerendered.
// Without this the build tries to render it statically and logs a dynamic-server
// error — the same reason the trends/outreach config routes declare it.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { company } = await requireActiveCompany();

    const [plan, used] = await Promise.all([
      getEffectivePlan(company.id),
      assetsThisMonth(company.id),
    ]);

    return jsonOk({
      providers: listProviders(),
      usage: {
        used,
        limit: plan.limits.maxImagesPerMonth,
        remaining: Math.max(0, plan.limits.maxImagesPerMonth - used),
        maxPerRequest: plan.limits.maxImagesPerRequest,
        plan: plan.limits.label,
      },
      // Surfaced so an operator can confirm at a glance whether images are
      // going to the database or to a bucket.
      storage: activeStore(),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
