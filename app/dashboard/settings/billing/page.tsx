import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { ensureSubscription, getSubscription } from '@/server/billing/subscription.service';
import { getEffectivePlan, PLAN_LIMITS } from '@/server/billing/entitlements';
import { isStripeConfigured, priceIdForPlan } from '@/lib/stripe';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import {
  BillingPanel,
  type PlanCard,
} from '@/components/dashboard/billing/billing-panel';

export const metadata: Metadata = { title: 'Billing' };

export default async function BillingPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const membership = await getMembership(user.id, active.id);
  const canManage = membership ? can(membership.role, 'company:manageBilling') : false;

  // Lazily ensure a trial exists, then read effective state.
  await ensureSubscription(active.id);
  const [sub, eff] = await Promise.all([
    getSubscription(active.id),
    getEffectivePlan(active.id),
  ]);

  const trialDaysLeft =
    eff.trialEndsAt != null
      ? Math.max(0, Math.ceil((eff.trialEndsAt.getTime() - Date.now()) / 86_400_000))
      : null;

  const plans: PlanCard[] = (['STARTER', 'GROWTH', 'AGENCY'] as const).map((plan) => {
    const l = PLAN_LIMITS[plan];
    return {
      plan,
      label: l.label,
      purchasable: Boolean(priceIdForPlan(plan)),
      features: [
        `${l.maxActiveCampaigns} active campaign${l.maxActiveCampaigns === 1 ? '' : 's'}`,
        `${l.maxDiscoveryRunsPerMonth} discovery runs / month`,
        `${l.maxLinkedInAccounts} connected account${l.maxLinkedInAccounts === 1 ? '' : 's'}`,
        `${l.maxImagesPerMonth} generated graphics / month`,
        'All AI features + Chrome extension',
      ],
    };
  });

  return (
    <div>
      <PageHeader
        title="Billing"
        description="Manage your plan and payment."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/settings">
              <ArrowLeft className="h-4 w-4" /> Settings
            </Link>
          </Button>
        }
      />
      <BillingPanel
        currentPlan={eff.plan}
        status={eff.status}
        active={eff.active}
        trialDaysLeft={trialDaysLeft}
        hasCustomer={Boolean(sub?.stripeCustomerId)}
        stripeConfigured={isStripeConfigured()}
        canManage={canManage}
        plans={plans}
      />
    </div>
  );
}
