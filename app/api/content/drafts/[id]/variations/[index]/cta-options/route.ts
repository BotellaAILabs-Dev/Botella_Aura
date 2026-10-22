import { jsonError, jsonOk } from '@/lib/api';
import { ctaOptions } from '@/server/content/version-workspace.service';

import { versionError, versionIndex, versionRequest } from '../../_shared';

/**
 * POST /api/content/drafts/:id/variations/:index/cta-options
 *
 * Suggested calls to action for one version — nothing is saved. Suggestions
 * that bring in a link, number, price or date not already known are dropped.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(_req: Request, { params }: { params: { id: string; index: string } }) {
  try {
    const index = versionIndex(params.index);
    if (index === null) return jsonError('That version does not exist.', 404);
    const ctx = await versionRequest(params.id, { limitKey: 'content-cta-options', limit: 20 });
    if (ctx instanceof Response) return ctx;
    return jsonOk({ options: await ctaOptions({ draft: ctx.draft, index }) });
  } catch (error) {
    return versionError(error);
  }
}
