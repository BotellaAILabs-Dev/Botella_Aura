import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import { getDraft } from '@/server/content/content.service';
import { generateImagePromptSchema } from '@/lib/validations/media';
import { generateImagePrompt } from '@/server/media/image-prompt.service';
import { resolvePlatform } from '@/lib/platforms';
import type { ContentTypeKey } from '@/lib/validations/content';

/**
 * POST /api/content/drafts/:id/graphics/prompt
 *
 * Analyse the draft's content and write an image prompt for it. Split from the
 * generation endpoint on purpose: writing the prompt is cheap and the user
 * should get to read and edit it before anything is paid for.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError('Your role is read-only and cannot create graphics.', 403);
    }

    // Prompt writing is an LLM call per press. Generous, but not unlimited.
    const limit = rateLimit(`graphic-prompt:${user.id}`, {
      limit: 20,
      windowMs: 60_000,
    });
    if (!limit.allowed) {
      return jsonError(
        `Slow down a moment — try again in ${limit.retryAfterSeconds}s.`,
        429,
      );
    }

    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Draft not found', 404);

    const input = generateImagePromptSchema.parse(await req.json().catch(() => ({})));
    const platform = resolvePlatform(
      draft.type as ContentTypeKey,
      input.platform ?? draft.platform,
    );

    const result = await generateImagePrompt({
      draft,
      userId: user.id,
      platform,
      style: input.style,
      ...(input.guidance ? { guidance: input.guidance } : {}),
    });

    return jsonOk({ ...result, platform });
  } catch (error) {
    return handleRouteError(error);
  }
}
