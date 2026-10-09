import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import {
  briefToContentRequest,
  validateContentBrief,
} from '@/lib/content-brief';
import { SOCIAL_PLATFORMS } from '@/lib/platforms';
import { CONTENT_TYPES } from '@/lib/validations/content';
import { getContentBrief } from '@/server/content/content-brief.service';

/**
 * GET /api/recommendations/:id/brief[?type=&platform=] — the Content Brief
 * (lib/content-brief.ts, version 1): the source of truth for what Aura is to
 * create from this recommendation. Every field with its source, what is
 * required, what is missing and what that means, and whether it can go to
 * Content Studio. `validation` is the same check run before generation;
 * `contentRequest` is the Content Studio request for it, ready to post —
 * null until it validates.
 *
 * `type` and `platform` stand for the person's choice of format and network.
 */
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  type: z.enum(CONTENT_TYPES).optional(),
  platform: z.enum(SOCIAL_PLATFORMS).optional(),
});

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    const q = new URL(req.url).searchParams;
    const choice = querySchema.parse({
      type: q.get('type') ?? undefined,
      platform: q.get('platform') ?? undefined,
    });
    const brief = await getContentBrief(company.id, params.id, choice);
    if (!brief) return jsonError('Recommendation not found', 404);
    return jsonOk({
      brief,
      validation: validateContentBrief(brief),
      contentRequest: briefToContentRequest(brief),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
