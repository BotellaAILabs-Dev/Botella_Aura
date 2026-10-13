import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';
import {
  checkCompliance,
  compliancePolicySchema,
} from '@/lib/compliance-policy';
import { CONTENT_TYPES } from '@/lib/validations/content';
import { SOCIAL_PLATFORMS } from '@/lib/platforms';
import { getBusinessContext } from '@/server/business-context/business-context.service';
import {
  getPolicyContext,
  resetCompliancePolicy,
  saveCompliancePolicy,
} from '@/server/content/compliance.service';

/**
 * The workspace's compliance policy (lib/compliance-policy.ts).
 *
 *   GET   — the rules in force (the defaults until the workspace saves its own)
 *   PUT   — save them (owners and admins); every review made under the old
 *           rules becomes out of date and runs again before approval
 *   POST  — { action: 'reset' } back to the defaults, or
 *           { action: 'test', policy?, type, platform?, text, cta? } — check a
 *           piece of copy against a policy (saved or not) without storing it
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    const ctx = await getPolicyContext(company.id);
    return jsonOk(ctx);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { company, membership, user } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError(
        'Only owners and admins can change the compliance rules.',
        403,
      );
    }
    const input = compliancePolicySchema.parse(await req.json());
    const ctx = await saveCompliancePolicy({
      companyId: company.id,
      userId: user.id,
      input,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk(ctx);
  } catch (error) {
    return handleRouteError(error);
  }
}

const testSchema = z.object({
  action: z.literal('test'),
  policy: compliancePolicySchema.optional(),
  type: z.enum(CONTENT_TYPES),
  platform: z.enum(SOCIAL_PLATFORMS).nullable().optional(),
  text: z.string().max(10_000),
  cta: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  try {
    const { company, membership, user } = await requireActiveCompany();
    const body = (await req.json()) as { action?: string };

    if (body.action === 'reset') {
      if (!can(membership.role, 'company:update')) {
        return jsonError(
          'Only owners and admins can change the compliance rules.',
          403,
        );
      }
      return jsonOk(
        await resetCompliancePolicy({ companyId: company.id, userId: user.id }),
      );
    }

    const input = testSchema.parse(body);
    const [ctx, business] = await Promise.all([
      getPolicyContext(company.id),
      getBusinessContext(company.id, { sections: ['market'] }),
    ]);
    const report = checkCompliance({
      type: input.type,
      platform: input.platform ?? null,
      text: input.text,
      cta: input.cta ?? '',
      policy: input.policy ?? ctx.policy,
      alcohol: ctx.alcohol,
      website: ctx.website,
      competitors: (business?.market.competitors ?? []).map((c) => c.name),
      rules: [],
      claims: null,
    });
    return jsonOk({ report });
  } catch (error) {
    return handleRouteError(error);
  }
}
