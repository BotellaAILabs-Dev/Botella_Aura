import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { getDraft } from '@/server/content/content.service';
import { undoDraft } from '@/server/content/generator';
import { assessDraft } from '@/server/content/quality.service';

/**
 * POST /api/content/drafts/:id/undo — restore the version before the last
 * rewrite, variation switch or edit. Re-checks its quality.
 */
export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError(
        'Your role is read-only and cannot change content.',
        403,
      );
    }
    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Draft not found', 404);
    if (draft.status === 'PUBLISHED') {
      return jsonError('Published content cannot be changed.', 409);
    }
    const restored = await undoDraft({ draft, userId: user.id });
    const quality = await assessDraft(restored, restored.body);
    await db.contentDraft.update({
      where: { id: restored.id },
      data: {
        aiMetadata: {
          ...((restored.aiMetadata ?? {}) as object),
          quality,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return jsonOk({ id: restored.id, status: restored.status });
  } catch (error) {
    return handleRouteError(error);
  }
}
