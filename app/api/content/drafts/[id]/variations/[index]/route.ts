import { z } from 'zod';

import { jsonError, jsonOk } from '@/lib/api';
import { editVersion, setVersionCta } from '@/server/content/version-workspace.service';

import { versionError, versionIndex, versionRequest } from '../_shared';

/**
 * PATCH /api/content/drafts/:id/variations/:index
 *   { body, baseUpdatedAt? }  — save this version's fields (copy, CTA,
 *                              hashtags, details)
 *   { cta, baseUpdatedAt? }   — set only its call to action
 *
 * Changes this version only. The version in use is the draft itself, so
 * saving it follows the draft's edit rules (an approved draft goes back to
 * draft); any other version changes on its own, never the draft.
 */
export const dynamic = 'force-dynamic';

const patchSchema = z.union([
  z.object({ body: z.record(z.unknown()), baseUpdatedAt: z.string().datetime().optional() }),
  z.object({ cta: z.string().trim().max(300), baseUpdatedAt: z.string().datetime().optional() }),
]);

export async function PATCH(req: Request, { params }: { params: { id: string; index: string } }) {
  try {
    const index = versionIndex(params.index);
    if (index === null) return jsonError('That version does not exist.', 404);
    const ctx = await versionRequest(params.id, { limitKey: 'content-version-edit', limit: 60 });
    if (ctx instanceof Response) return ctx;
    const input = patchSchema.parse(await req.json());
    const result =
      'cta' in input
        ? await setVersionCta({ draft: ctx.draft, userId: ctx.userId, index, cta: input.cta, baseUpdatedAt: input.baseUpdatedAt ?? null })
        : await editVersion({ draft: ctx.draft, userId: ctx.userId, index, body: input.body, baseUpdatedAt: input.baseUpdatedAt ?? null });
    return jsonOk({ index: result.index, updatedAt: result.draft.updatedAt.toISOString() });
  } catch (error) {
    return versionError(error);
  }
}
