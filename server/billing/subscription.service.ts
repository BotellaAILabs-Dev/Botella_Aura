import type Stripe from 'stripe';
import type { SubscriptionStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import { planFromPriceId } from '@/lib/stripe';

/**
 * Subscription state (Sprint 6, Module 3). Stripe is the source of truth; we
 * mirror it here via SIGNATURE-VERIFIED webhooks (NON-NEGOTIABLE #4). This file
 * holds the handler LOGIC (given an already-verified event), so it's unit-
 * testable with mocked events independent of signature checks.
 */
const TRIAL_DAYS = 14;

/** Lazily create a 14-day TRIAL subscription (trial dated from signup). */
export async function ensureSubscription(companyId: string) {
  const existing = await db.subscription.findUnique({ where: { companyId } });
  if (existing) return existing;

  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { createdAt: true },
  });
  const base = company?.createdAt ?? new Date();
  const trialEndsAt = new Date(base.getTime() + TRIAL_DAYS * 86_400_000);

  const sub = await db.subscription.create({
    data: { companyId, plan: 'TRIAL', status: 'TRIALING', trialEndsAt },
  });
  await recordAudit({
    action: 'TRIAL_STARTED',
    companyId,
    metadata: { trialEndsAt: trialEndsAt.toISOString() },
  });
  return sub;
}

export async function getSubscription(companyId: string) {
  return db.subscription.findUnique({ where: { companyId } });
}

function mapStripeStatus(s: Stripe.Subscription.Status | string): SubscriptionStatus {
  switch (s) {
    case 'trialing':
      return 'TRIALING';
    case 'active':
      return 'ACTIVE';
    case 'past_due':
    case 'unpaid':
      return 'PAST_DUE';
    case 'canceled':
    case 'incomplete_expired':
      return 'CANCELED';
    default:
      return 'INCOMPLETE';
  }
}

function periodEnd(sub: Stripe.Subscription): Date | null {
  return sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
}

/**
 * Apply an already-verified Stripe event to our Subscription mirror. Returns a
 * short outcome for logging/tests. Unknown event types are ignored.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<{ handled: string }> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const companyId = session.metadata?.companyId;
      if (!companyId) return { handled: 'ignored: no companyId metadata' };
      const plan = session.metadata?.plan
        ? planFromPriceId(process.env[`STRIPE_PRICE_${session.metadata.plan}`] ?? null)
        : 'STARTER';
      await db.subscription.upsert({
        where: { companyId },
        create: {
          companyId,
          plan: session.metadata?.plan ? (session.metadata.plan as never) : 'STARTER',
          status: 'ACTIVE',
          stripeCustomerId: (session.customer as string) ?? null,
          stripeSubscriptionId: (session.subscription as string) ?? null,
        },
        update: {
          plan: session.metadata?.plan ? (session.metadata.plan as never) : plan,
          status: 'ACTIVE',
          stripeCustomerId: (session.customer as string) ?? undefined,
          stripeSubscriptionId: (session.subscription as string) ?? undefined,
        },
      });
      await recordAudit({
        action: 'SUBSCRIPTION_CREATED',
        companyId,
        metadata: { stripeSubscriptionId: (session.subscription as string) ?? null },
      });
      return { handled: 'checkout.session.completed' };
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const priceId = sub.items?.data?.[0]?.price?.id;
      const target = await db.subscription.findFirst({
        where: {
          OR: [{ stripeSubscriptionId: sub.id }, { stripeCustomerId: sub.customer as string }],
        },
      });
      if (!target) return { handled: 'ignored: unknown subscription' };
      await db.subscription.update({
        where: { id: target.id },
        data: {
          plan: planFromPriceId(priceId),
          status: mapStripeStatus(sub.status),
          currentPeriodEnd: periodEnd(sub),
          stripeSubscriptionId: sub.id,
        },
      });
      await recordAudit({
        action: 'SUBSCRIPTION_UPDATED',
        companyId: target.companyId,
        metadata: { status: sub.status },
      });
      return { handled: 'customer.subscription.updated' };
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const target = await db.subscription.findFirst({
        where: { stripeSubscriptionId: sub.id },
      });
      if (!target) return { handled: 'ignored: unknown subscription' };
      await db.subscription.update({
        where: { id: target.id },
        data: { status: 'CANCELED', plan: 'TRIAL' },
      });
      await recordAudit({ action: 'SUBSCRIPTION_CANCELED', companyId: target.companyId, metadata: {} });
      return { handled: 'customer.subscription.deleted' };
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const target = await db.subscription.findFirst({
        where: { stripeCustomerId: invoice.customer as string },
      });
      if (!target) return { handled: 'ignored: unknown customer' };
      await db.subscription.update({ where: { id: target.id }, data: { status: 'PAST_DUE' } });
      await recordAudit({ action: 'PAYMENT_FAILED', companyId: target.companyId, metadata: {} });
      return { handled: 'invoice.payment_failed' };
    }

    default:
      logger.info('stripe webhook: unhandled event type', { type: event.type });
      return { handled: `ignored: ${event.type}` };
  }
}
