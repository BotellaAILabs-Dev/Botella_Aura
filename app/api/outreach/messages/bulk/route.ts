import { z } from 'zod';

import { db } from '@/lib/db';
import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { transitionMessage } from '@/server/outreach/outreach.service';
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
 * GET /api/outreach/messages/bulk?status=PENDING_APPROVAL — the ids eligible
 * for a bulk action, so the UI can offer "approve all N" without the client
 * having to know the rules.
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
      select: { id: true, createdAt: true },
    });
    return jsonOk({ ids: messages.map((m) => m.id), count: messages.length });
  } catch (error) {
    return handleRouteError(error);
  }
}
