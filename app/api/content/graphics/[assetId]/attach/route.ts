import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { attachGraphicSchema, detachGraphicSchema } from '@/lib/validations/media';
import { attachAsset, detachAsset, getAttachedMedia } from '@/server/media/asset.service';
import { getDraft } from '@/server/content/content.service';
import type { ContentTypeKey } from '@/lib/validations/content';

/**
 * Attach / detach a generated graphic to a post.
 *
 * Both handlers re-read the draft afterwards and return its full media list, so
 * the composer renders from one authoritative response instead of guessing what
 * the attachment did to the ordering.
 */

/** POST — attach this graphic to a draft ("Use this image"). */
export async function POST(
  req: Request,
  { params }: { params: { assetId: string } },
) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError('Your role is read-only and cannot edit posts.', 403);
    }

    const input = attachGraphicSchema.parse(await req.json());
    await attachAsset({
      companyId: company.id,
      userId: user.id,
      draftId: input.draftId,
      assetId: params.assetId,
      ...(input.altText ? { altText: input.altText } : {}),
      replace: input.replace,
    });

    return jsonOk({ media: await mediaFor(company.id, input.draftId) });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** DELETE — remove this graphic from a draft (the post itself is untouched). */
export async function DELETE(
  req: Request,
  { params }: { params: { assetId: string } },
) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError('Your role is read-only and cannot edit posts.', 403);
    }

    const input = detachGraphicSchema.parse(await req.json());
    await detachAsset({
      companyId: company.id,
      userId: user.id,
      draftId: input.draftId,
      assetId: params.assetId,
    });

    return jsonOk({ media: await mediaFor(company.id, input.draftId) });
  } catch (error) {
    return handleRouteError(error);
  }
}

async function mediaFor(companyId: string, draftId: string) {
  const draft = await getDraft(companyId, draftId);
  if (!draft) return [];
  return getAttachedMedia({
    companyId,
    draftId,
    type: draft.type as ContentTypeKey,
    platform: draft.platform,
  });
}
