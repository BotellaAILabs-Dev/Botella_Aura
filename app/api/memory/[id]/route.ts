import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { updateMemoryInsight, dismissMemory } from '@/server/memory/memory.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

const patchSchema = z.object({
  insight: z.string().trim().min(3, 'Insight is too short.').max(600),
});

/**
 * PATCH /api/memory/[id] — correct the wording of a learned insight.
 * DELETE /api/memory/[id] — dismiss an insight (soft-delete; stops feeding drafts).
 * Both require content:approve and are scoped to the active company.
 */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to edit insights.', 403);
    }
    const body = (await req.json().catch(() => ({}))) as unknown;
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? 'Invalid insight.', 400);
    }
    const updated = await updateMemoryInsight(
      company.id,
      params.id,
      parsed.data.insight,
    );
    return jsonOk({ id: updated.id, insight: updated.insight });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:approve')) {
      return jsonError('You do not have permission to dismiss insights.', 403);
    }
    await dismissMemory(company.id, params.id);
    return jsonOk({ dismissed: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
