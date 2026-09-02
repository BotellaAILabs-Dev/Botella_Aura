import type { Plan } from '@prisma/client';
import { db } from '@/lib/db';

/**
 * Plan-based entitlements (Sprint 6, Module 3). The SINGLE source of truth for
 * "what can this company do on its plan". Limits live here (config, not
 * scattered literals — NON-NEGOTIABLE #5); Stripe price IDs map to a Plan tier
 * via env in the webhook. Reads gracefully default to an active TRIAL when no
 * Subscription row exists yet, and degrade to a restricted (read-only-ish) state
 * when a trial/subscription has ended — never a data-losing lockout.
 */
export type Feature =
  | 'campaigns'
  | 'discovery'
  | 'linkedinAccounts'
  | 'imageGeneration';

export interface PlanLimits {
  maxActiveCampaigns: number;
  maxDiscoveryRunsPerMonth: number;
  maxLinkedInAccounts: number;
  /**
   * Graphics a workspace may generate per calendar month.
   *
   * Unlike the other limits this one is a real spend control, not a packaging
   * decision: every image is a paid provider call, and an unbounded "Generate"
   * button is how a trial account produces a four-figure invoice. The trial
   * number is deliberately enough to evaluate the feature and not enough to
   * matter if abused.
   */
  maxImagesPerMonth: number;
  /** Variations a single click may request, on top of the hard cap of 4. */
  maxImagesPerRequest: number;
  label: string;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  TRIAL: {
    maxActiveCampaigns: 1,
    maxDiscoveryRunsPerMonth: 10,
    maxLinkedInAccounts: 1,
    maxImagesPerMonth: 20,
    maxImagesPerRequest: 2,
    label: 'Trial',
  },
  STARTER: {
    maxActiveCampaigns: 2,
    maxDiscoveryRunsPerMonth: 25,
    maxLinkedInAccounts: 1,
    maxImagesPerMonth: 100,
    maxImagesPerRequest: 2,
    label: 'Starter',
  },
  GROWTH: {
    maxActiveCampaigns: 10,
    maxDiscoveryRunsPerMonth: 150,
    maxLinkedInAccounts: 3,
    maxImagesPerMonth: 500,
    maxImagesPerRequest: 4,
    label: 'Growth',
  },
  AGENCY: {
    maxActiveCampaigns: 100,
    maxDiscoveryRunsPerMonth: 2000,
    maxLinkedInAccounts: 25,
    maxImagesPerMonth: 4000,
    maxImagesPerRequest: 4,
    label: 'Agency',
  },
};

export class EntitlementError extends Error {
  readonly status = 402; // Payment Required
  readonly upgrade = true;
  constructor(message: string) {
    super(message);
    this.name = 'EntitlementError';
  }
}

export interface EffectivePlan {
  plan: Plan;
  active: boolean; // false = trial/subscription ended → restricted
  limits: PlanLimits;
  trialEndsAt: Date | null;
  status: string;
}

/** Resolve a company's effective plan + whether it's currently active. */
export async function getEffectivePlan(companyId: string): Promise<EffectivePlan> {
  const sub = await db.subscription.findUnique({ where: { companyId } });
  const now = new Date();

  // No subscription row yet → implicit active trial (new companies aren't blocked).
  if (!sub) {
    return { plan: 'TRIAL', active: true, limits: PLAN_LIMITS.TRIAL, trialEndsAt: null, status: 'TRIALING' };
  }

  const trialExpired = sub.status === 'TRIALING' && sub.trialEndsAt != null && sub.trialEndsAt < now;
  const active =
    (sub.status === 'ACTIVE' || sub.status === 'TRIALING') && !trialExpired;

  return {
    plan: sub.plan,
    active,
    limits: PLAN_LIMITS[sub.plan],
    trialEndsAt: sub.trialEndsAt,
    status: sub.status,
  };
}

/**
 * Throw EntitlementError (402) if the company can't use `feature` right now —
 * either because access has lapsed, or a plan limit is reached. Call this in the
 * routes that CREATE things; reads are never gated (no data lockout).
 */
export async function requireEntitlement(companyId: string, feature: Feature): Promise<void> {
  const eff = await getEffectivePlan(companyId);

  if (!eff.active) {
    throw new EntitlementError(
      'Your trial or subscription has ended. Upgrade to keep creating — your data is safe and stays read-only until then.',
    );
  }

  if (feature === 'campaigns') {
    const active = await db.campaign.count({
      where: { companyId, status: { in: ['ACTIVE', 'PAUSED', 'DRAFT'] } },
    });
    if (active >= eff.limits.maxActiveCampaigns) {
      throw new EntitlementError(
        `Your ${eff.limits.label} plan allows ${eff.limits.maxActiveCampaigns} active campaign(s). Upgrade to run more.`,
      );
    }
  }

  if (feature === 'discovery') {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const runs = await db.discoveryRun.count({
      where: { companyId, startedAt: { gte: monthStart } },
    });
    if (runs >= eff.limits.maxDiscoveryRunsPerMonth) {
      throw new EntitlementError(
        `Your ${eff.limits.label} plan allows ${eff.limits.maxDiscoveryRunsPerMonth} discovery runs/month. Upgrade for more.`,
      );
    }
  }

  if (feature === 'imageGeneration') {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const generated = await db.generatedAsset.count({
      where: { companyId, createdAt: { gte: monthStart } },
    });
    if (generated >= eff.limits.maxImagesPerMonth) {
      throw new EntitlementError(
        `Your ${eff.limits.label} plan includes ${eff.limits.maxImagesPerMonth} generated graphics per month, and you have used them all. Upgrade for more — your existing graphics stay available.`,
      );
    }
  }

  if (feature === 'linkedinAccounts') {
    const connected = await db.linkedInConnection.count({
      where: { companyId, status: 'ACTIVE' },
    });
    if (connected >= eff.limits.maxLinkedInAccounts) {
      throw new EntitlementError(
        `Your ${eff.limits.label} plan allows ${eff.limits.maxLinkedInAccounts} connected account(s).`,
      );
    }
  }
}
