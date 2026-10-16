import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { updateDraftSchema } from '@/lib/validations/content';
import {
  getDraft,
  setDraftPlatform,
  updateDraftBody,
} from '@/server/content/content.service';
import { SOCIAL_PLATFORMS } from '@/lib/platforms';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { can } from '@/lib/rbac';

/** GET — a single draft (scoped to the active company). */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const { company } = await requireActiveCompany();
    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Draft not found', 404);
    return jsonOk(draft);
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Retargeting is its own payload shape.
 *
 * Changing where a post is aimed is not an edit to its content, and must not go
 * through the body path — that would send an APPROVED draft back to DRAFT for
 * re-approval just because someone switched the platform selector to preview a
 * different image format.
 */
const retargetSchema = z
  .object({ platform: z.enum(SOCIAL_PLATFORMS) })
  // Strict, so a payload carrying BOTH a body and a platform falls through to
  // the body path rather than silently applying only half of it.
  .strict();

/** PATCH — save manual edits to the draft body, or retarget its platform. */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    // Editing a post, or where it is aimed, is creating content: VIEWERs cannot.
    if (!can(membership.role, 'content:create')) {
      return jsonError('Your role is read-only and cannot edit posts.', 403);
    }
    const payload = await req.json();

    const retarget = retargetSchema.safeParse(payload);
    if (retarget.success) {
      const draft = await setDraftPlatform({
        companyId: company.id,
        userId: user.id,
        draftId: params.id,
        platform: retarget.data.platform,
      });
      return jsonOk({ id: draft.id, platform: draft.platform, status: draft.status });
    }

    const input = updateDraftSchema.parse(payload);
    const draft = await updateDraftBody({
      companyId: company.id,
      userId: user.id,
      draftId: params.id,
      title: input.title,
      body: input.body,
      baseUpdatedAt: input.baseUpdatedAt ?? null,
    });
    return jsonOk({ id: draft.id, status: draft.status });
  } catch (error) {
    return handleRouteError(error);
  }
}
