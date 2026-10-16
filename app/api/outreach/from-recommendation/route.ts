import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { db } from '@/lib/db';
import { outreachCreationHandoff } from '@/lib/creation-handoff';
import { executionGate } from '@/lib/execution-gate';
import { draftForLead } from '@/server/outreach/drafting.service';
import {
  getCreation,
  recordCreation,
  startCreation,
} from '@/server/recommendations/creation.service';

export const maxDuration = 60;

/**
 * POST /api/outreach/from-recommendation { recommendationId, leadIds } — the
 * Outreach creation handoff (lib/creation-handoff.ts): draft a connection note
 * and follow-up for each chosen lead, written from the recommendation's
 * context and keeping it.
 *
 *   - Same permission as drafting outreach (content:approve); saying yes to a
 *     still-open suggestion on the way is a decision (owners/admins), exactly
 *     as for Content Studio and Campaigns.
 *   - Only an eligible suggestion (aimed at people) — anything else is refused
 *     with the reason and where it is carried out instead.
 *   - Drafts land as DRAFT, in the normal review and approval flow. Sending
 *     waits for execution (lib/execution-gate.ts): approved messages from a
 *     suggestion never enter the send queue yet.
 */

/** Drafting is an AI call per lead; a handful keeps it inside one request. */
const MAX_LEADS = 5;

const bodySchema = z.object({
  recommendationId: z.string().min(1).max(64),
  leadIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_LEADS),
});

export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to draft outreach.', 403);
    }
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(`Choose between 1 and ${MAX_LEADS} leads.`, 400);
    }
    const { recommendationId } = parsed.data;
    const leadIds = [...new Set(parsed.data.leadIds)];

    const creation = await getCreation(company.id, recommendationId, 'outreach');
    if (!creation) return jsonError('Suggestion not found.', 404);
    if (!creation.plan.canCreate) {
      return jsonOk(
        {
          error: creation.plan.message ?? 'There is no outreach to draft from this suggestion.',
          fix: creation.plan.fix,
        },
        409,
      );
    }
    // Every lead must be this workspace's — checked before anything is said yes to.
    const leads = await db.lead.findMany({
      where: { companyId: company.id, id: { in: leadIds } },
      select: { id: true, name: true, companyName: true },
    });
    if (leads.length !== leadIds.length) return jsonError('One of those leads was not found.', 404);

    let ready = creation;
    if (creation.plan.acceptsOnCreate) {
      if (!can(membership.role, 'company:update')) {
        return jsonError(
          'Only owners and admins can say yes to a suggestion. Ask one to accept it — then draft from it.',
          403,
        );
      }
      ready = await startCreation({
        companyId: company.id,
        recommendationId,
        actorId: user.id,
        module: 'outreach',
      });
    }
    const { context } = outreachCreationHandoff(ready.handoff);

    const drafted: { leadId: string; who: string; connectionNoteId: string; followupId: string }[] = [];
    const failed: { leadId: string; who: string; error: string }[] = [];
    for (const lead of leads) {
      const who = lead.name ? `${lead.name} (${lead.companyName})` : lead.companyName;
      try {
        const r = await draftForLead({
          companyId: company.id,
          userId: user.id,
          leadId: lead.id,
          requestMeta: getRequestMeta(req),
          creation: { context },
        });
        drafted.push({ leadId: lead.id, who, connectionNoteId: r.connectionNoteId, followupId: r.followupId });
      } catch (err) {
        failed.push({ leadId: lead.id, who, error: err instanceof Error ? err.message.slice(0, 200) : 'Could not draft.' });
      }
    }
    if (drafted.length) {
      await recordCreation({
        companyId: company.id,
        recommendationId,
        module: 'outreach',
        created: {
          type: 'outreach-drafts',
          id: drafted[0]!.connectionNoteId,
          label: `Outreach drafts for ${drafted.length} lead${drafted.length === 1 ? '' : 's'}`,
        },
        actorId: user.id,
      });
    }
    const gate = executionGate('outreach', true);
    return jsonOk(
      {
        drafted,
        failed,
        execution: gate.blocked ? { blocked: true, message: gate.message } : { blocked: false },
      },
      drafted.length ? 201 : 502,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
