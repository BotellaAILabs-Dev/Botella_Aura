import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import { VARIATION_KINDS } from '@/lib/content-variations';
import { SOCIAL_PLATFORMS } from '@/lib/platforms';
import { CONTENT_TONES } from '@/lib/validations/content';
import { getDraft } from '@/server/content/content.service';
import { aiFailureMessage } from '@/server/ai/claude';
import {
  createVariation,
  imageVariationRequest,
  VariationError,
} from '@/server/content/variations.service';

/**
 * POST /api/content/drafts/:id/variations { kind, tone?, platform? }
 *
 * Make a variation of a draft (lib/content-variations.ts) — shorter, longer,
 * another tone, an alternative CTA or headline, or a version for another
 * channel — added next to the original, never replacing it. Returns the new
 * version's index; switching to it is POST …/variation { index }.
 *
 * `kind: 'image'` returns the request for another image (the latest image's
 * prompt, else one from the visual brief), to post to …/graphics, which
 * applies the plan's allowance.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const bodySchema = z.object({
  kind: z.enum(VARIATION_KINDS),
  tone: z.enum(CONTENT_TONES).optional(),
  platform: z.enum(SOCIAL_PLATFORMS).optional(),
});

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
    const limit = rateLimit(`content-variation:${user.id}`, {
      limit: 20,
      windowMs: 60_000,
    });
    if (!limit.allowed) {
      return jsonError(
        `Slow down a moment — try again in ${limit.retryAfterSeconds}s.`,
        429,
      );
    }
    const input = bodySchema.parse(await req.json());
    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Draft not found', 404);

    if (input.kind === 'image') {
      return jsonOk({ image: await imageVariationRequest(draft) });
    }
    const { index, version } = await createVariation({
      draft,
      userId: user.id,
      kind: input.kind,
      ...(input.tone ? { tone: input.tone } : {}),
      ...(input.platform ? { platform: input.platform } : {}),
    });
    return jsonOk(
      {
        index,
        label: version.angle,
        approvable:
          (version.quality as { approvable?: boolean } | undefined)
            ?.approvable ?? true,
        factsKept: (version.facts?.introduced.length ?? 0) === 0,
      },
      201,
    );
  } catch (error) {
    if (error instanceof VariationError)
      return jsonError(error.message, error.status);
    const ai = aiFailureMessage(error);
    if (ai) return jsonError(ai, 503);
    return handleRouteError(error);
  }
}
