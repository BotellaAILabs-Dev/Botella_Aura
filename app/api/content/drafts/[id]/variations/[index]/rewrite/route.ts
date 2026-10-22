import { z } from 'zod';

import { jsonError, jsonOk } from '@/lib/api';
import { rewriteVersion } from '@/server/content/version-workspace.service';

import { versionError, versionIndex, versionRequest } from '../../_shared';

/**
 * POST /api/content/drafts/:id/variations/:index/rewrite { instruction? }
 *
 * Regenerate ONE version (no instruction: a fresh take on the same angle) or
 * refine it with the person's own instruction. The other versions are not
 * touched; this version's previous text is kept so it can be reverted.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const bodySchema = z.object({ instruction: z.string().trim().max(1000).optional() });

export async function POST(req: Request, { params }: { params: { id: string; index: string } }) {
  try {
    const index = versionIndex(params.index);
    if (index === null) return jsonError('That version does not exist.', 404);
    const ctx = await versionRequest(params.id, { limitKey: 'content-variation', limit: 20 });
    if (ctx instanceof Response) return ctx;
    const input = bodySchema.parse(await req.json().catch(() => ({})));
    const result = await rewriteVersion({
      draft: ctx.draft,
      userId: ctx.userId,
      index,
      ...(input.instruction ? { instruction: input.instruction } : {}),
    });
    return jsonOk({ index: result.index, factsKept: result.factsKept, updatedAt: result.draft.updatedAt.toISOString() });
  } catch (error) {
    return versionError(error);
  }
}
