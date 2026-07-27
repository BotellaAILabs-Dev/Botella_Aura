import Stripe from 'stripe';
import type { Plan } from '@prisma/client';

/**
 * Stripe client + plan mapping (Sprint 6, Module 3). Lazy singleton so the app
 * boots without billing configured. Prices live in Stripe (referenced by env
 * price IDs) — NOT hardcoded (NON-NEGOTIABLE #5): to change a price you change
 * it in Stripe, no redeploy.
 */
let client: Stripe | null = null;

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function getStripe(): Stripe {
  if (!isStripeConfigured()) {
    throw Object.assign(new Error('Billing is not configured (STRIPE_SECRET_KEY missing).'), {
      status: 503,
    });
  }
  if (!client) client = new Stripe(process.env.STRIPE_SECRET_KEY!);
  return client;
}

/** Paid plan tiers → their Stripe price-id env var. */
const PLAN_PRICE_ENV: Record<Exclude<Plan, 'TRIAL'>, string> = {
  STARTER: 'STRIPE_PRICE_STARTER',
  GROWTH: 'STRIPE_PRICE_GROWTH',
  AGENCY: 'STRIPE_PRICE_AGENCY',
};

/** The Stripe price id configured for a paid plan (or null if unset). */
export function priceIdForPlan(plan: Exclude<Plan, 'TRIAL'>): string | null {
  return process.env[PLAN_PRICE_ENV[plan]] ?? null;
}

/** Reverse map a Stripe price id back to a Plan tier (for webhook handling). */
export function planFromPriceId(priceId: string | null | undefined): Plan {
  if (!priceId) return 'TRIAL';
  for (const [plan, env] of Object.entries(PLAN_PRICE_ENV) as [
    Exclude<Plan, 'TRIAL'>,
    string,
  ][]) {
    if (process.env[env] && process.env[env] === priceId) return plan;
  }
  return 'STARTER';
}

/** Which paid plans are actually purchasable (have a configured price). */
export function availablePlans(): { plan: Exclude<Plan, 'TRIAL'>; priceId: string }[] {
  return (Object.keys(PLAN_PRICE_ENV) as Exclude<Plan, 'TRIAL'>[])
    .map((plan) => ({ plan, priceId: priceIdForPlan(plan) }))
    .filter((p): p is { plan: Exclude<Plan, 'TRIAL'>; priceId: string } => Boolean(p.priceId));
}
