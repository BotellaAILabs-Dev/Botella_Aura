import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Billing tests (Sprint 6, Module 3): the Stripe webhook HANDLER logic with
 * mocked events, and entitlement gating — both with Prisma mocked. (Signature
 * verification is exercised at the route level; here we test the handler that
 * runs AFTER a verified event.)
 */
const { subs, state } = vi.hoisted(() => ({
  subs: [] as any[],
  state: { campaignCount: 0, discoveryCount: 0 },
}));

function matchWhere(s: any, where: any): boolean {
  if (where.OR) return where.OR.some((w: any) => matchWhere(s, w));
  return Object.entries(where).every(([k, v]) => s[k] === v);
}

vi.mock('@/lib/db', () => ({
  db: {
    subscription: {
      findUnique: async ({ where }: any) => subs.find((s) => s.companyId === where.companyId) ?? null,
      findFirst: async ({ where }: any) => subs.find((s) => matchWhere(s, where)) ?? null,
      create: async ({ data }: any) => {
        const r = { id: `sub_${subs.length + 1}`, stripeCustomerId: null, stripeSubscriptionId: null, ...data };
        subs.push(r);
        return r;
      },
      update: async ({ where, data }: any) => {
        const r = subs.find((s) => s.id === where.id);
        Object.assign(r, data);
        return r;
      },
      upsert: async ({ where, create, update }: any) => {
        const ex = subs.find((s) => s.companyId === where.companyId);
        if (ex) {
          Object.assign(ex, update);
          return ex;
        }
        const r = { id: `sub_${subs.length + 1}`, stripeCustomerId: null, stripeSubscriptionId: null, ...create };
        subs.push(r);
        return r;
      },
    },
    company: { findUnique: async () => ({ createdAt: new Date() }) },
    campaign: { count: async () => state.campaignCount },
    discoveryRun: { count: async () => state.discoveryCount },
    linkedInConnection: { count: async () => 0 },
    auditLog: { create: async () => ({}) },
  },
}));

import { handleStripeEvent } from '@/server/billing/subscription.service';
import {
  getEffectivePlan,
  requireEntitlement,
  EntitlementError,
} from '@/server/billing/entitlements';

beforeEach(() => {
  subs.length = 0;
  state.campaignCount = 0;
  state.discoveryCount = 0;
});

const evt = (type: string, object: any) => ({ type, data: { object } }) as never;

describe('stripe webhook handler', () => {
  it('activates a subscription on checkout.session.completed', async () => {
    await handleStripeEvent(
      evt('checkout.session.completed', {
        metadata: { companyId: 'c1', plan: 'GROWTH' },
        customer: 'cus_1',
        subscription: 'sub_stripe_1',
      }),
    );
    const s = subs.find((x) => x.companyId === 'c1');
    expect(s.status).toBe('ACTIVE');
    expect(s.plan).toBe('GROWTH');
    expect(s.stripeCustomerId).toBe('cus_1');
  });

  it('ignores checkout with no companyId metadata (no write)', async () => {
    const r = await handleStripeEvent(evt('checkout.session.completed', { metadata: {} }));
    expect(r.handled).toMatch(/ignored/);
    expect(subs).toHaveLength(0);
  });

  it('marks PAST_DUE on invoice.payment_failed', async () => {
    subs.push({ id: 'sub_x', companyId: 'c1', stripeCustomerId: 'cus_1', status: 'ACTIVE', plan: 'GROWTH' });
    await handleStripeEvent(evt('invoice.payment_failed', { customer: 'cus_1' }));
    expect(subs[0]!.status).toBe('PAST_DUE');
  });

  it('cancels + downgrades on customer.subscription.deleted', async () => {
    subs.push({ id: 'sub_x', companyId: 'c1', stripeSubscriptionId: 'ss_1', status: 'ACTIVE', plan: 'AGENCY' });
    await handleStripeEvent(evt('customer.subscription.deleted', { id: 'ss_1' }));
    expect(subs[0]!.status).toBe('CANCELED');
    expect(subs[0]!.plan).toBe('TRIAL');
  });

  it('ignores unknown event types', async () => {
    const r = await handleStripeEvent(evt('charge.refunded', {}));
    expect(r.handled).toMatch(/ignored/);
  });
});

describe('entitlements', () => {
  it('treats a company with no subscription as an active trial', async () => {
    const eff = await getEffectivePlan('c1');
    expect(eff.plan).toBe('TRIAL');
    expect(eff.active).toBe(true);
  });

  it('marks an expired trial as inactive', async () => {
    subs.push({ companyId: 'c1', plan: 'TRIAL', status: 'TRIALING', trialEndsAt: new Date(Date.now() - 1000) });
    const eff = await getEffectivePlan('c1');
    expect(eff.active).toBe(false);
  });

  it('blocks creation when the trial/subscription has ended', async () => {
    subs.push({ companyId: 'c1', plan: 'TRIAL', status: 'TRIALING', trialEndsAt: new Date(Date.now() - 1000) });
    await expect(requireEntitlement('c1', 'campaigns')).rejects.toBeInstanceOf(EntitlementError);
  });

  it('enforces the active-campaign limit for the plan', async () => {
    subs.push({ companyId: 'c1', plan: 'STARTER', status: 'ACTIVE', trialEndsAt: null }); // limit 2
    state.campaignCount = 2;
    await expect(requireEntitlement('c1', 'campaigns')).rejects.toBeInstanceOf(EntitlementError);
    state.campaignCount = 1;
    await expect(requireEntitlement('c1', 'campaigns')).resolves.toBeUndefined();
  });

  it('enforces the monthly discovery-run limit', async () => {
    subs.push({ companyId: 'c1', plan: 'STARTER', status: 'ACTIVE', trialEndsAt: null }); // 25/mo
    state.discoveryCount = 25;
    await expect(requireEntitlement('c1', 'discovery')).rejects.toBeInstanceOf(EntitlementError);
  });
});
