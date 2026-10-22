import { z } from 'zod';

import { jsonOk } from '@/lib/api';
import { addRecommendations, MAX_MORE } from '@/server/content/version-workspace.service';

import { versionError, versionRequest } from '../_shared';

/**
 * POST /api/content/drafts/:id/variations/more { count }
 *
 * Write more recommendations (1–3) from angles not used yet, added next to
 * the existing versions — none of them is changed or removed, except that a
 * draft keeps at most 8 versions (the oldest unused go first, never the one
 * in use).
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const bodySchema = z.object({ count: z.number().int().min(1).max(MAX_MORE).default(2) });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const ctx = await versionRequest(params.id, { limitKey: 'content-variation', limit: 20 });
    if (ctx instanceof Response) return ctx;
    const input = bodySchema.parse(await req.json().catch(() => ({})));
    const result = await addRecommendations({ draft: ctx.draft, userId: ctx.userId, count: input.count });
    return jsonOk({ added: result.added, updatedAt: result.draft.updatedAt.toISOString() }, 201);
  } catch (error) {
    return versionError(error);
  }
}
