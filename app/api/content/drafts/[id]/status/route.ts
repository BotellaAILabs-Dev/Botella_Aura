import { z } from 'zod';
import type { ContentStatus } from '@prisma/client';
import { requireActiveCompany } from '@/lib/auth-helpers';
import { transition } from '@/server/content/content.service';
import { getRequestMeta, handleRouteError, jsonOk } from '@/lib/api';

/**
 * POST /api/content/drafts/:id/status — approve / reject / submit / request
 * changes. Maps a UI action to a validated state-machine transition; the
 * service enforces legality + audits every change (the approval backbone).
 */
const ACTION_TO_STATUS: Record<string, ContentStatus> = {
  submit: 'PENDING_APPROVAL',
  approve: 'APPROVED',
  reject: 'REJECTED',
  request_changes: 'DRAFT',
};

const bodySchema = z.object({
  action: z.enum(['submit', 'approve', 'reject', 'request_changes']),
  reason: z.string().trim().max(500).optional(),
  /** The approver checked the claims the fact check could not verify. */
  factsReviewed: z.boolean().optional(),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const { company, user } = await requireActiveCompany();
    const { action, reason, factsReviewed } = bodySchema.parse(await req.json());

    const draft = await transition({
      companyId: company.id,
      userId: user.id,
      draftId: params.id,
      to: ACTION_TO_STATUS[action]!,
      reason,
      requestMeta: getRequestMeta(req),
      factsReviewed: factsReviewed ?? false,
    });

    return jsonOk({ id: draft.id, status: draft.status });
  } catch (error) {
    return handleRouteError(error);
  }
}
