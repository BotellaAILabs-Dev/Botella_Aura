import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import { generateCreativeSchema } from '@/lib/validations/media';
import { brandPalette } from '@/lib/creative/spec';
import { getDraft } from '@/server/content/content.service';
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
import {
  getEffectivePlan,
  requireEntitlement,
} from '@/server/billing/entitlements';
import { isAnyProviderConfigured } from '@/server/media/providers';
import {
  creativesForDraft,
  loadBrand,
  specOf,
} from '@/server/media/creative/creative.service';

/**
 * Marketing creatives for one draft (server/media/creative).
 *
 *   GET  — the draft's creatives (newest first, with their design), the
 *          photos that can be reused, the brand defaults, and any run in flight
 *   POST — { input, keepText? } queue a creative: copy + a new photograph +
 *          the layout. Returns a job to poll (POST /api/jobs/:id/run, GET
 *          /api/jobs/:id), like plain graphic generation.
 *
 * Nothing here publishes: a creative is an image the person attaches, and the
 * post still needs approval.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Draft not found', 404);
    const [assets, attached, brand, activeJob, creatives] = await Promise.all([
      listAssets(company.id, { draftId: draft.id }),
      attachedAssetIds(company.id, draft.id),
      loadBrand(company.id),
      findActiveImageJob(company.id, draft.id),
      creativesForDraft(company.id, draft.id),
    ]);
    const views = assets.map((a) => toAssetView(a, attached));
    const specs = new Map(creatives.map((c) => [c.id, specOf(c.metadata)]));
    return jsonOk({
      creatives: views
        .filter((v) => v.creative)
        .map((v) => ({ asset: v, spec: specs.get(v.id) ?? null })),
      // Photographs (not creatives) a creative can be set on.
      photos: views.filter((v) => !v.creative && /png|jpeg/.test(v.mimeType)),
      brand: {
        name: brand.name,
        colors: brandPalette(brand.colors),
        hasLogo: Boolean(brand.logoAssetId || brand.logoUrl),
        website: brand.website,
      },
      providerConfigured: isAnyProviderConfigured(),
      activeJob:
        activeJob &&
        (activeJob.inputs as { creative?: unknown } | null)?.creative
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

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError(
        'Your role is read-only and cannot make creatives.',
        403,
      );
    }
    const burst = rateLimit(`creative-generate:${user.id}`, {
      limit: 6,
      windowMs: 60_000,
    });
    if (!burst.allowed) {
      return jsonError(
        `That's a lot of generating. Try again in ${burst.retryAfterSeconds}s.`,
        429,
      );
    }
    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Draft not found', 404);
    const { input, keepText } = generateCreativeSchema.parse(await req.json());

    // A new photograph spends a generation from the plan, like any graphic.
    if (input.photo === 'new' && isAnyProviderConfigured()) {
      await requireEntitlement(company.id, 'imageGeneration');
      const plan = await getEffectivePlan(company.id);
      if (
        (await assetsThisMonth(company.id)) >= plan.limits.maxImagesPerMonth
      ) {
        return jsonError(
          `Your ${plan.limits.label} plan's generated images for this month are used up. Pick one of your photos, or the brand background, and the creative is still made.`,
          402,
        );
      }
    }

    const { job, reused, inputsDiffer } = await enqueueJob({
      companyId: company.id,
      userId: user.id,
      kind: 'IMAGE_GENERATION',
      inputs: {
        draftId: draft.id,
        prompt: 'Marketing creative: photograph, copy and layout.',
        style: 'photo',
        variations: 1,
        creative: { input, keepText: keepText ?? null },
      },
      dedupeOn: { draftId: draft.id },
    });
    if (reused && inputsDiffer) {
      return jsonError(
        'Something is already being made for this post. Wait for it to finish, then try again.',
        409,
      );
    }
    return jsonOk(
      {
        jobId: job.id,
        status: job.status,
        progress: readProgress(job),
        reused,
      },
      reused ? 200 : 202,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
