import { z } from 'zod';

import { db } from '@/lib/db';
import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { recordAudit } from '@/server/services/audit.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * POST /api/leads/:id/irrelevant — "not relevant, because…".
 *
 * Dismissing a bad lead silently throws away the most useful signal the system
 * gets: a human saying, in their own words, why the criteria produced a wrong
 * match. Stored on the lead and surfaced back in the discovery profile, so the
 * next run can be told what to stop returning instead of repeating the mistake.
 */
const bodySchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Say briefly why this lead is not relevant.')
    .max(500),
});

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to update leads.', 403);
    }
    const { reason } = bodySchema.parse(await req.json());

    const lead = await db.lead.findFirst({
      where: { id: params.id, companyId: company.id },
      select: { id: true, companyName: true, discoveryProfileId: true },
    });
    if (!lead) return jsonError('Lead not found.', 404);

    await db.lead.update({
      where: { id: lead.id },
      data: {
        status: 'ARCHIVED',
        irrelevantReason: reason,
        irrelevantAt: new Date(),
      },
    });

    await recordAudit({
      action: 'LEAD_MARKED_IRRELEVANT',
      userId: user.id,
      companyId: company.id,
      metadata: {
        leadId: lead.id,
        companyName: lead.companyName,
        discoveryProfileId: lead.discoveryProfileId,
        reason,
      },
      ...getRequestMeta(req),
    });

    return jsonOk({ archived: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
