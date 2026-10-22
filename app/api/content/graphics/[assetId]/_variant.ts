import type { ContentDraft } from '@prisma/client';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import type { LogoPosition } from '@/lib/image-variants';
import { getEffectivePlan, requireEntitlement } from '@/server/billing/entitlements';
import { getDraft } from '@/server/content/content.service';
import { enqueueJob, readProgress } from '@/server/jobs/job.service';
import { AssetNotFoundError, assetsThisMonth } from '@/server/media/asset.service';
import { VariantError } from '@/server/media/variant.service';

/**
 * Shared by the per-image routes (…/graphics/:assetId/refine, /regenerate,
 * /logo): who may change images, and queuing one image of work under the same
 * plan allowance and burst limit as generation.
 */
export async function variantRequest(
  draftId: string,
): Promise<{ draft: ContentDraft; userId: string; companyId: string } | Response> {
  const { company, user, membership } = await requireActiveCompany();
  if (!can(membership.role, 'content:create')) {
    return jsonError('Your role is read-only and cannot change images.', 403);
  }
  const draft = await getDraft(company.id, draftId);
  if (!draft) return jsonError('Draft not found', 404);
  if (draft.status === 'PUBLISHED') return jsonError('This post is already published — its images cannot change.', 409);
  return { draft, userId: user.id, companyId: company.id };
}

/** Queue one image of AI work on an existing image (counts as one generated image). */
export async function queueVariantJob(
  ctx: { draft: ContentDraft; userId: string; companyId: string },
  variant: { action: 'refine' | 'regenerate' | 'make_space'; assetId: string; instruction?: string; position?: LogoPosition },
): Promise<Response> {
  const burst = rateLimit(`graphic-generate:${ctx.userId}`, { limit: 6, windowMs: 60_000 });
  if (!burst.allowed) return jsonError(`That's a lot of generating. Try again in ${burst.retryAfterSeconds}s.`, 429);
  await requireEntitlement(ctx.companyId, 'imageGeneration');
  const plan = await getEffectivePlan(ctx.companyId);
  if ((await assetsThisMonth(ctx.companyId)) >= plan.limits.maxImagesPerMonth) {
    return jsonError(
      `Your ${plan.limits.label} plan includes ${plan.limits.maxImagesPerMonth} generated graphics per month, and you have used them all. Your existing images stay available.`,
      402,
    );
  }
  const { job, reused, inputsDiffer } = await enqueueJob({
    companyId: ctx.companyId,
    userId: ctx.userId,
    kind: 'IMAGE_GENERATION',
    inputs: {
      draftId: ctx.draft.id,
      prompt: 'Work on one existing image (refine, regenerate or make room for a logo).',
      style: 'professional',
      variations: 1,
      variant,
    },
    dedupeOn: { draftId: ctx.draft.id },
  });
  if (reused && inputsDiffer) {
    return jsonError('Another image is being made for this post. Wait for it to finish, then try again.', 409);
  }
  return jsonOk({ jobId: job.id, status: job.status, progress: readProgress(job), reused }, reused ? 200 : 202);
}

export function variantError(error: unknown): Response {
  if (error instanceof VariantError) return jsonError(error.message, error.status);
  if (error instanceof AssetNotFoundError) return jsonError('Image not found', 404);
  return handleRouteError(error);
}
