import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { getDraft } from '@/server/content/content.service';
import { switchVariation } from '@/server/content/generator';

/**
 * POST /api/content/drafts/:id/variation { index } — switch the draft to
 * another of the versions it was generated with. Undoable.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ index: z.number().int().min(0).max(2) });

export async function POST(
  req: Request,
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
    const { index } = bodySchema.parse(await req.json());
    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Draft not found', 404);
    if (draft.status === 'PUBLISHED') {
      return jsonError('Published content cannot be changed.', 409);
    }
    const updated = await switchVariation({ draft, userId: user.id, index });
    return jsonOk({ id: updated.id, status: updated.status });
  } catch (error) {
    return handleRouteError(error);
  }
}
