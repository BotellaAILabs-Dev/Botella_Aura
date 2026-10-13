import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import { getDraft } from '@/server/content/content.service';
import { generateGraphicSchema } from '@/lib/validations/media';
import {
  assetsThisMonth,
  attachedAssetIds,
  listAssets,
  toAssetView,
} from '@/server/media/asset.service';
import {
  enqueueJob,
  findActiveImageJob,
  readProgress,
} from '@/server/jobs/job.service';
import { requireEntitlement, getEffectivePlan } from '@/server/billing/entitlements';
import { isAnyProviderConfigured } from '@/server/media/providers';
import { NoImageProviderError } from '@/server/media/types';

/**
 * Graphics for one draft.
 *
 * POST does NOT generate inline. Four variations on a provider that returns one
 * image per call is four sequential round-trips, which outlives a serverless
 * function budget — the exact failure GenerationJob exists to solve. So this
 * queues a job and returns immediately; the client kicks
 * POST /api/jobs/:id/run and polls GET /api/jobs/:id, the same pattern the
 * trend digest and the monthly planner already use.
 *
 * Everything that must fail FAST still happens here, before a job exists: the
 * role check, the rate limit, the plan allowance, and whether any provider is
 * configured at all. A queued job that was always going to be rejected is a
 * worse experience than an immediate, specific error.
 */
export const dynamic = 'force-dynamic';

/** GET — graphic history. `?scope=company` widens it past this draft. */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const { company } = await requireActiveCompany();
    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Draft not found', 404);

    const scope = new URL(req.url).searchParams.get('scope');
    const [assets, attached, activeJob] = await Promise.all([
      listAssets(company.id, scope === 'company' ? {} : { draftId: params.id }),
      attachedAssetIds(company.id, params.id),
      // A run already in flight FOR THIS DRAFT, so a reload reattaches to it
      // instead of showing an idle panel while images are still being made.
      findActiveImageJob(company.id, params.id),
    ]);

    // A creative run belongs to the creative studio, not this panel.
    const isCreative = Boolean((activeJob?.inputs as { creative?: unknown } | null)?.creative);
    return jsonOk({
      assets: assets.map((a) => toAssetView(a, attached)),
      activeJob: activeJob && !isCreative
        ? {
            jobId: activeJob.id,
            status: activeJob.status,
            progress: readProgress(activeJob),
          }
        : null,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST — queue a generation. Returns a job to poll, not the images. */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError('Your role is read-only and cannot generate graphics.', 403);
    }
    if (!isAnyProviderConfigured()) {
      throw new NoImageProviderError();
    }

    // Two windows: a short one so a burst of clicks cannot become a burst of
    // charges, and the monthly plan allowance checked just below.
    const burst = rateLimit(`graphic-generate:${user.id}`, {
      limit: 6,
      windowMs: 60_000,
    });
    if (!burst.allowed) {
      return jsonError(
        `That's a lot of generating. Try again in ${burst.retryAfterSeconds}s.`,
        429,
      );
    }
    await requireEntitlement(company.id, 'imageGeneration');

    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Draft not found', 404);

    const input = generateGraphicSchema.parse(await req.json());

    /**
     * Clamp to what is actually left, not just "is there any left".
     *
     * `requireEntitlement` above answers the second question. On its own that
     * lets a workspace with one image remaining ask for four and get four —
     * the allowance is a budget, so the request has to be sized against the
     * remaining balance as well as the per-request cap.
     */
    const plan = await getEffectivePlan(company.id);
    const used = await assetsThisMonth(company.id);
    const remainingThisMonth = Math.max(0, plan.limits.maxImagesPerMonth - used);
    const variations = Math.min(
      input.variations,
      plan.limits.maxImagesPerRequest,
      remainingThisMonth,
    );

    if (variations < 1) {
      return jsonError(
        `Your ${plan.limits.label} plan includes ${plan.limits.maxImagesPerMonth} generated graphics per month, and you have used them all. Upgrade for more — your existing graphics stay available.`,
        402,
      );
    }

    const { job, reused, inputsDiffer } = await enqueueJob({
      companyId: company.id,
      userId: user.id,
      kind: 'IMAGE_GENERATION',
      inputs: {
        draftId: draft.id,
        prompt: input.prompt,
        ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
        ...(input.originalPrompt ? { originalPrompt: input.originalPrompt } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
        ...(input.customWidth ? { customWidth: input.customWidth } : {}),
        ...(input.customHeight ? { customHeight: input.customHeight } : {}),
        style: input.style,
        variations,
      },
      // Scoped to this draft: two people generating for two different posts are
      // doing different work, and the second must not attach to the first's run.
      dedupeOn: { draftId: draft.id },
    });

    /**
     * A run is already going for this post, but for something else.
     *
     * Reuse is right for a double-click — the same request twice. It is wrong
     * here: the caller edited the prompt (or the model, or the format) and
     * would silently be handed the PREVIOUS request's images with no sign that
     * anything was ignored. Saying so is the only honest option, because the
     * in-flight run cannot be replaced without discarding work already paid for.
     */
    if (reused && inputsDiffer) {
      return jsonError(
        'A different generation is already running for this post. Wait for it to finish (or reload to watch it), then generate again.',
        409,
      );
    }

    return jsonOk(
      {
        jobId: job.id,
        status: job.status,
        progress: readProgress(job),
        // True when the SAME run for this draft was already in flight — the
        // client attaches to it instead of reporting one it did not start.
        reused,
        ...(variations < input.variations
          ? {
              planNote:
                variations === remainingThisMonth
                  ? `Only ${remainingThisMonth} graphic${remainingThisMonth === 1 ? '' : 's'} left in your ${plan.limits.label} plan this month, so ${variations} will be generated.`
                  : `Your ${plan.limits.label} plan generates up to ${plan.limits.maxImagesPerRequest} variations at a time.`,
            }
          : {}),
      },
      reused ? 200 : 202,
    );
  } catch (error) {
    if (error instanceof NoImageProviderError) {
      return jsonError(error.message, error.status);
    }
    return handleRouteError(error);
  }
}
