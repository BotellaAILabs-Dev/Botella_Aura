import { z } from 'zod';

import { db } from '@/lib/db';
import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { recordAudit } from '@/server/services/audit.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * POST /api/analytics/manual — record measured results by hand.
 *
 * Analytics showing all zeros is not a rendering problem: nothing has ever
 * reported a number, because that needs a connector that may be weeks from
 * approval. Blocking the entire measurement loop on an OAuth review would also
 * block Marketing Memory, which cannot learn from results it never receives.
 *
 * A manual snapshot is a first-class PerformanceSnapshot with source MANUAL —
 * the same shape a connector writes, so every downstream consumer (analytics
 * rollups, memory extraction, content intelligence) treats it identically and
 * nothing needs a special case.
 */
const metricsSchema = z
  .object({
    impressions: z.number().int().min(0).max(100_000_000).optional(),
    likes: z.number().int().min(0).max(10_000_000).optional(),
    comments: z.number().int().min(0).max(10_000_000).optional(),
    shares: z.number().int().min(0).max(10_000_000).optional(),
    clicks: z.number().int().min(0).max(10_000_000).optional(),
    followers: z.number().int().min(0).max(1_000_000_000).optional(),
  })
  .refine((m) => Object.values(m).some((v) => typeof v === 'number'), {
    message: 'Enter at least one number.',
  });

const bodySchema = z.object({
  /** Which published draft these numbers belong to. Omit for account-level. */
  contentDraftId: z.string().min(1).optional(),
  /** When the numbers were read. Defaults to now. */
  capturedAt: z.string().datetime().optional(),
  metrics: metricsSchema,
});

export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to log results.', 403);
    }
    const input = bodySchema.parse(await req.json());

    // Scope check: never let one workspace attach numbers to another's draft.
    if (input.contentDraftId) {
      const draft = await db.contentDraft.findFirst({
        where: { id: input.contentDraftId, companyId: company.id },
        select: { id: true },
      });
      if (!draft) return jsonError('That content draft was not found.', 404);
    }

    const snapshot = await db.performanceSnapshot.create({
      data: {
        companyId: company.id,
        contentDraftId: input.contentDraftId ?? null,
        source: 'MANUAL',
        metrics: input.metrics,
        capturedAt: input.capturedAt ? new Date(input.capturedAt) : new Date(),
      },
    });

    await recordAudit({
      action: 'PERFORMANCE_LOGGED_MANUALLY',
      userId: user.id,
      companyId: company.id,
      metadata: {
        snapshotId: snapshot.id,
        contentDraftId: input.contentDraftId ?? null,
        metrics: Object.keys(input.metrics),
      },
      ...getRequestMeta(req),
    });

    return jsonOk({ id: snapshot.id }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
