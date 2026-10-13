import { z } from 'zod';

import { db } from '@/lib/db';
import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { transitionMessage } from '@/server/outreach/outreach.service';
import {
  BULK_APPROVE_THRESHOLD,
  isBulkApprovable,
  scoreConfidence,
} from '@/server/outreach/confidence';
import { logger } from '@/lib/logger';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/outreach/messages/bulk — approve or reject many messages at once.
 *
 * Approving one message at a time is a real tax on a small team, and the
 * backlog it creates is why the outreach funnel stalls before anything reaches
 * Analytics. This is still an explicit human approval — the same transition,
 * the same audit entry per message, just not one click each.
 *
 * Every id is re-checked against the caller's company inside the transition, so
 * a crafted list cannot reach another workspace's messages.
 */
const bodySchema = z.object({
  messageIds: z.array(z.string().min(1)).min(1).max(100),
  action: z.enum(['approve', 'reject', 'submit']),
  reason: z.string().trim().max(500).optional(),
});

export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    const { messageIds, action, reason } = bodySchema.parse(await req.json());

    if (
      (action === 'approve' || action === 'reject') &&
      !can(membership.role, 'content:approve')
    ) {
      return jsonError('Only owners/admins can approve or reject outreach.', 403);
    }

    const requestMeta = getRequestMeta(req);
    let succeeded = 0;
    const failed: { id: string; reason: string }[] = [];

    // Sequential and individually guarded: one message in an unexpected state
    // must not abort the rest of the batch.
    for (const messageId of messageIds) {
      try {
        await transitionMessage({
          companyId: company.id,
          userId: user.id,
      role: membership.role,
          messageId,
          action,
          reason,
          requestMeta,
        });
        succeeded++;
      } catch (err) {
        failed.push({
          id: messageId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (failed.length > 0) {
      logger.warn('outreach/bulk: some transitions failed', {
        action,
        succeeded,
        failed: failed.length,
      });
    }

    return jsonOk({ succeeded, failed });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * GET /api/outreach/messages/bulk?status=PENDING_APPROVAL — which messages are
 * eligible for a bulk action, split by confidence.
 *
 * The split is the point. Approving everything unread is not review, so only
 * drafts we can justify — grounded in a real signal, in the brand voice, aimed
 * at a well-scored named contact, free of placeholders — are offered as a
 * batch. Everything else is returned separately and stays for a human to read.
 */
export async function GET(req: Request) {
  try {
    const { company } = await requireActiveCompany();
    const status = new URL(req.url).searchParams.get('status') ?? 'PENDING_APPROVAL';
    const parsed = z
      .enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED'])
      .safeParse(status);
    if (!parsed.success) return jsonError('Unknown status.', 400);

    const messages = await db.outreachMessage.findMany({
      where: { companyId: company.id, status: parsed.data },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        type: true,
        draftText: true,
        aiMetadata: true,
        lead: {
          select: { name: true, linkedInProfileUrl: true, fitScore: true },
        },
      },
    });

    const confident: string[] = [];
    const needsReview: { id: string; score: number; concerns: string[] }[] = [];

    for (const m of messages) {
      const meta = (m.aiMetadata ?? {}) as {
        model?: string;
        signalId?: string | null;
        brandVoiceApplied?: boolean;
      };
      const result = scoreConfidence({
        model: meta.model,
        brandVoiceApplied: meta.brandVoiceApplied,
        hasSignal: Boolean(meta.signalId),
        fitScore: m.lead.fitScore,
        hasContactName: Boolean(m.lead.name),
        hasLinkedInUrl: Boolean(m.lead.linkedInProfileUrl),
        draftText: m.draftText,
        type: m.type,
      });
      if (isBulkApprovable(result)) confident.push(m.id);
      else
        needsReview.push({
          id: m.id,
          score: result.score,
          concerns: result.concerns,
        });
    }

    return jsonOk({
      // Every id, for a deliberate "approve all anyway".
      ids: messages.map((m) => m.id),
      count: messages.length,
      threshold: BULK_APPROVE_THRESHOLD,
      confidentIds: confident,
      confidentCount: confident.length,
      needsReview,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
