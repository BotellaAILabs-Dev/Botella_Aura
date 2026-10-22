import { z } from 'zod';

import { jsonError, jsonOk } from '@/lib/api';
import { revertVersion } from '@/server/content/version-workspace.service';

import { versionError, versionIndex, versionRequest } from '../../_shared';

/**
 * POST /api/content/drafts/:id/variations/:index/revert { baseUpdatedAt? }
 *
 * Bring back this version's previous text (after an edit or rewrite). Only
 * this version changes.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ baseUpdatedAt: z.string().datetime().optional() });

export async function POST(req: Request, { params }: { params: { id: string; index: string } }) {
  try {
    const index = versionIndex(params.index);
    if (index === null) return jsonError('That version does not exist.', 404);
    const ctx = await versionRequest(params.id, { limitKey: 'content-version-edit', limit: 60 });
    if (ctx instanceof Response) return ctx;
    const input = bodySchema.parse(await req.json().catch(() => ({})));
    const result = await revertVersion({ draft: ctx.draft, userId: ctx.userId, index, baseUpdatedAt: input.baseUpdatedAt ?? null });
    return jsonOk({ index: result.index, updatedAt: result.draft.updatedAt.toISOString() });
  } catch (error) {
    return versionError(error);
  }
}
