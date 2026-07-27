import type { Plan } from '@prisma/client';
import { getStripe, priceIdForPlan } from '@/lib/stripe';
import { db } from '@/lib/db';
import { ensureSubscription } from '@/server/billing/subscription.service';
import { recordAudit } from '@/server/services/audit.service';

/**
 * Stripe Checkout + Customer Portal sessions (Sprint 6, Module 3). Hosted flows
 * only — we never build custom card forms. Checkout carries companyId + plan in
 * metadata so the signed webhook can attribute the resulting subscription.
 */
export class BillingConfigError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = 'BillingConfigError';
  }
}

const APP_URL = () => process.env.NEXTAUTH_URL ?? 'http://localhost:3000';

export async function createCheckoutSession(args: {
  companyId: string;
  userId: string;
  plan: Exclude<Plan, 'TRIAL'>;
  email?: string | null;
}): Promise<string> {
  const { companyId, userId, plan, email } = args;
  const price = priceIdForPlan(plan);
  if (!price) throw new BillingConfigError(`No Stripe price configured for the ${plan} plan.`);

  const stripe = getStripe();
  const sub = await ensureSubscription(companyId);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    success_url: `${APP_URL()}/dashboard/settings/billing?checkout=success`,
    cancel_url: `${APP_URL()}/dashboard/settings/billing?checkout=cancelled`,
    ...(sub.stripeCustomerId
      ? { customer: sub.stripeCustomerId }
      : email
        ? { customer_email: email }
        : {}),
    client_reference_id: companyId,
    metadata: { companyId, plan },
    subscription_data: { metadata: { companyId } },
    allow_promotion_codes: true,
  });

  await recordAudit({
    action: 'CHECKOUT_STARTED',
    userId,
    companyId,
    metadata: { plan, sessionId: session.id },
  });

  if (!session.url) throw new BillingConfigError('Stripe did not return a checkout URL.');
  return session.url;
}

export async function createPortalSession(companyId: string): Promise<string> {
  const sub = await db.subscription.findUnique({ where: { companyId } });
  if (!sub?.stripeCustomerId) {
    throw new BillingConfigError('No Stripe customer yet — start a plan first.');
  }
  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: `${APP_URL()}/dashboard/settings/billing`,
  });
  return session.url;
}
