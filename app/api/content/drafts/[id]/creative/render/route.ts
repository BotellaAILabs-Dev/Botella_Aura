import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import { renderCreativeSchema } from '@/lib/validations/media';
import { getDraft } from '@/server/content/content.service';
import {
  buildSpec,
  composeAndStore,
} from '@/server/media/creative/creative.service';

/**
 * POST /api/content/drafts/:id/creative/render — { input, keepText }
 *
 * Re-set a creative's words, layout, format or colours on the photo it
 * already has (or the brand background), in a second or two. No image is
 * generated and no AI is asked: the text is used exactly as given.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError(
        'Your role is read-only and cannot edit creatives.',
        403,
      );
    }
    const burst = rateLimit(`creative-render:${user.id}`, {
      limit: 20,
      windowMs: 60_000,
    });
    if (!burst.allowed) {
      return jsonError(
        `Slow down a little — try again in ${burst.retryAfterSeconds}s.`,
        429,
      );
    }
    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Draft not found', 404);
    const { input, keepText } = renderCreativeSchema.parse(await req.json());
    if (input.photo === 'new') {
      return jsonError(
        'A new photo is made with POST /creative; this only re-sets the design.',
        400,
      );
    }
    const { spec } = await buildSpec({ draft, input, keepText });
    const result = await composeAndStore({ draft, userId: user.id, spec });
    return jsonOk(result, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
