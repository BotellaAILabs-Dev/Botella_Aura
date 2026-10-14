import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { can } from '@/lib/rbac';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { getDraft } from '@/server/content/content.service';
import { MULTI_PLATFORMS, previewPublishing, publishToPlatforms } from '@/server/content/multi-publish.service';
import { listPublications } from '@/server/content/publication-store';
import { advanceProcessing } from '@/server/content/processing.service';

/**
 * GET  /api/content/drafts/:id/publications — what each network would receive,
 *      whether it can go, and the publishing history.
 * POST /api/content/drafts/:id/publications { platforms, acknowledged? } —
 *      "Approve & Publish to Selected Platforms" (server/content/multi-publish.service.ts).
 *
 * PATCH /api/content/drafts/:id/publications — check this piece's posts a
 *      network is still processing (an Instagram Reel) and finish any that
 *      are ready. Only completes what an approver already published.
 *
 * 409 with `code` facts_need_review / review_needs_human: the approver must
 * vouch for what Aura flagged — resend with acknowledged: true.
 */
export const dynamic = 'force-dynamic';
// Each network is its own request; Instagram waits for its media container.
export const maxDuration = 60;

const bodySchema = z.object({
  platforms: z.array(z.enum(MULTI_PLATFORMS)).min(1).max(MULTI_PLATFORMS.length),
  acknowledged: z.boolean().optional(),
});

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const { company, membership } = await requireActiveCompany();
    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Not found.', 404);
    const [preview, history] = await Promise.all([previewPublishing(company.id, draft), listPublications(company.id, draft.id)]);
    return jsonOk({
      status: draft.status,
      canPublish: can(membership.role, 'content:publish'),
      canApprove: can(membership.role, 'content:approve'),
      preview,
      history: history.map((p) => ({
        platform: p.platform,
        status: p.status,
        url: p.url,
        message: p.message,
        attempts: p.attempts,
        publishedAt: p.publishedAt?.toISOString() ?? null,
        updatedAt: p.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, user, membership } = await requireActiveCompany();
    const input = bodySchema.parse(await req.json());
    const r = await publishToPlatforms({
      companyId: company.id,
      userId: user.id,
      role: membership.role,
      draftId: params.id,
      platforms: input.platforms,
      acknowledged: input.acknowledged,
    });
    return jsonOk(r);
  } catch (error) {
    const e = error as { status?: number; code?: string; message?: string };
    // The approval's own refusals carry a code the page acts on.
    if (e?.status === 409 && e.code) return jsonOk({ error: e.message, code: e.code }, 409);
    return handleRouteError(error);
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:publish')) return jsonError('Only people who can publish can do this.', 403);
    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Not found.', 404);
    return jsonOk(await advanceProcessing({ companyId: company.id, draftId: draft.id, limit: 3 }));
  } catch (error) {
    return handleRouteError(error);
  }
}
