import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { isAlcoholBusiness } from '@/lib/content-quality';
import {
  compliancePolicySchema,
  defaultPolicy,
  policyHash,
  readPolicy,
  type CompliancePolicy,
  type CompliancePolicyInput,
} from '@/lib/compliance-policy';
import { recordAudit } from '@/server/services/audit.service';

/**
 * The workspace's compliance policy (lib/compliance-policy.ts), stored in
 * Company.preferences.compliancePolicy and edited in Settings → Compliance.
 */

export interface PolicyContext {
  policy: CompliancePolicy;
  /** Alcohol rules apply (decides the alcohol pack when it is on "auto"). */
  alcohol: boolean;
  /** Fingerprint of the rules in force; a review made under others is out of date. */
  hash: string;
  /** The workspace has saved its own policy (otherwise these are the defaults). */
  customised: boolean;
  website: string | null;
}

type Bag = Record<string, unknown>;

function alcoholOf(company: {
  name: string;
  industry: string | null;
  preferences: unknown;
}): boolean {
  const prefs = (company.preferences ?? {}) as Bag;
  const business = (prefs.business ?? {}) as Bag;
  return isAlcoholBusiness([
    company.name,
    company.industry,
    typeof business.description === 'string' ? business.description : null,
    typeof business.offerings === 'string' ? business.offerings : null,
  ]);
}

export async function getPolicyContext(
  companyId: string,
): Promise<PolicyContext> {
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { name: true, industry: true, website: true, preferences: true },
  });
  if (!company) throw new Error('Company not found');
  const alcohol = alcoholOf(company);
  const stored = ((company.preferences ?? {}) as Bag).compliancePolicy;
  const policy = readPolicy(stored, alcohol);
  return {
    policy,
    alcohol,
    hash: policyHash(policy, alcohol),
    customised: Boolean(
      stored && compliancePolicySchema.safeParse(stored).success,
    ),
    website: company.website,
  };
}

/** Save the workspace's policy (replaces it), and audit the change. */
export async function saveCompliancePolicy(args: {
  companyId: string;
  userId: string;
  input: CompliancePolicyInput;
  requestMeta?: { ipAddress?: string | null; userAgent?: string | null };
}): Promise<PolicyContext> {
  const policy = compliancePolicySchema.parse(args.input);
  const company = await db.company.findUnique({
    where: { id: args.companyId },
    select: { preferences: true },
  });
  if (!company) throw new Error('Company not found');
  const bag = (company.preferences ?? {}) as Bag;
  await db.company.update({
    where: { id: args.companyId },
    data: {
      preferences: {
        ...bag,
        compliancePolicy: policy,
      } as Prisma.InputJsonObject,
    },
  });
  await recordAudit({
    action: 'COMPANY_UPDATED',
    userId: args.userId,
    companyId: args.companyId,
    metadata: {
      section: 'compliancePolicy',
      prohibited: policy.prohibited.length,
      disclaimers: policy.disclaimers.length,
      packs: policy.packs,
    },
    ...args.requestMeta,
  });
  return getPolicyContext(args.companyId);
}

/** Back to the defaults. */
export async function resetCompliancePolicy(args: {
  companyId: string;
  userId: string;
}): Promise<PolicyContext> {
  const ctx = await getPolicyContext(args.companyId);
  return saveCompliancePolicy({ ...args, input: defaultPolicy(ctx.alcohol) });
}
