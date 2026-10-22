import type { GenerationJob, GenerationJobKind } from '@prisma/client';

import { planInputsSchema } from '@/lib/validations/planner';
import { imageJobInputsSchema } from '@/lib/validations/media';
import { generateDigestForCompany } from '@/server/trends/digest.service';
import { generateMarketingPlan } from '@/server/planner/plan.service';
import { generateIntelligenceSnapshot } from '@/server/intelligence/intelligence.service';
import { getDraft } from '@/server/content/content.service';
import { generateGraphics } from '@/server/media/generation.service';
import { generateCreative } from '@/server/media/creative/creative.service';
import { reportProgress, type JobProgress } from '@/server/jobs/job.service';
import {
  getCreation,
  recordCreation,
} from '@/server/recommendations/creation.service';

/**
 * The actual work behind each job kind.
 *
 * Every runner takes the job's persisted `inputs` and reports progress as it
 * goes. Nothing here knows how it was invoked — the client's kick, the cron
 * reaper, and a manual retry all land in the same function, which is what makes
 * an interrupted run safe to resume.
 */
export type JobResult = Record<string, unknown>;

type Runner = (
  job: GenerationJob,
  report: (message: string, percent: number) => Promise<void>,
) => Promise<JobResult>;

const RUNNERS: Record<GenerationJobKind, Runner> = {
  TREND_DIGEST: async (job, report) => {
    const digest = await generateDigestForCompany({
      companyId: job.companyId,
      userId: job.userId,
      trigger: 'manual',
      onProgress: report,
    });
    const payload = (digest.payload ?? {}) as {
      items?: unknown[];
      model?: string;
      skippedSources?: string[];
    };
    return {
      digestId: digest.id,
      itemCount: payload.items?.length ?? 0,
      model: payload.model ?? 'unknown',
      skippedSources: payload.skippedSources ?? [],
    };
  },

  MARKETING_PLAN: async (job, report) => {
    // Re-validate rather than trust the stored blob: the job may have been
    // queued by an older build whose schema differed.
    const inputs = planInputsSchema.parse(job.inputs ?? {});
    const plan = await generateMarketingPlan({
      companyId: job.companyId,
      userId: job.userId,
      inputs,
      onProgress: report,
    });
    // Planned for an Aura recommendation: its history leads to this plan, and
    // it moves to in progress (only when it can be planned from at all).
    if (inputs.recommendationId) {
      const creation = await getCreation(
        job.companyId,
        inputs.recommendationId,
        'content-plan',
      );
      if (creation?.plan.canCreate && !creation.plan.acceptsOnCreate) {
        await recordCreation({
          companyId: job.companyId,
          recommendationId: inputs.recommendationId,
          module: 'content-plan',
          created: {
            type: 'content-plan',
            id: plan.month,
            label: `Content plan for ${plan.month}`,
          },
          actorId: job.userId,
        });
      }
    }
    return {
      month: plan.month,
      items: plan.items.length,
      model: plan.model,
    };
  },

  INTELLIGENCE: async (job, report) => {
    await report('Scoring your content, leads and brand…', 25);
    const payload = await generateIntelligenceSnapshot({
      companyId: job.companyId,
      userId: job.userId,
    });
    await report('Writing recommendations…', 85);
    return {
      overallScore: payload.overallScore,
      suggestions: payload.suggestions.length,
      model: payload.model,
    };
  },

  /**
   * Graphic generation.
   *
   * Here rather than inline for the reason this queue exists: four variations
   * on a provider that generates one image per call is four sequential HTTP
   * round-trips, which comfortably outlives a serverless function budget. Run
   * as a job it survives that, and the studio's staged progress readout gets
   * real progress instead of an animation.
   */
  IMAGE_GENERATION: async (job, report) => {
    const inputs = imageJobInputsSchema.parse(job.inputs ?? {});

    await report('Loading your post…', 10);
    const draft = await getDraft(job.companyId, inputs.draftId);
    if (!draft) {
      throw new Error('That draft no longer exists, so there is nothing to illustrate.');
    }

    // One existing image: refine, regenerate, or make room for a logo — the
    // result is that variant's next version (server/media/variant.service.ts).
    if (inputs.variant) {
      const { refineVariant, regenerateVariant } = await import('@/server/media/variant.service');
      const v = inputs.variant;
      await report(v.action === 'regenerate' ? 'Regenerating this image…' : 'Refining your image…', 35);
      const asset =
        v.action === 'regenerate'
          ? await regenerateVariant({ draft, userId: job.userId, assetId: v.assetId, jobId: job.id })
          : await refineVariant({
              draft,
              userId: job.userId,
              assetId: v.assetId,
              instruction: v.instruction ?? '',
              ...(v.action === 'make_space' ? { makeSpace: v.position ?? 'bottom-right' } : {}),
              jobId: job.id,
            });
      await report('Preparing the preview…', 95);
      return { variant: { asset, from: v.assetId, action: v.action } } as unknown as JobResult;
    }

    // A marketing creative: copy, photograph and layout in one run.
    if (inputs.creative) {
      const result = await generateCreative({
        draft,
        userId: job.userId,
        input: inputs.creative.input,
        keepText: inputs.creative.keepText ?? null,
        jobId: job.id,
        report,
      });
      await report('Preparing the preview…', 95);
      return { creative: result } as unknown as JobResult;
    }

    await report(
      inputs.variations > 1
        ? `Generating ${inputs.variations} images…`
        : 'Generating your image…',
      35,
    );
    const result = await generateGraphics({
      draft,
      userId: job.userId,
      // Makes the run resumable: a retry after a timeout generates only the
      // images the interrupted attempt did not finish, rather than all of them
      // again at full cost.
      jobId: job.id,
      prompt: inputs.prompt,
      ...(inputs.negativePrompt ? { negativePrompt: inputs.negativePrompt } : {}),
      ...(inputs.originalPrompt ? { originalPrompt: inputs.originalPrompt } : {}),
      ...(inputs.provider ? { provider: inputs.provider } : {}),
      ...(inputs.aspectRatio ? { aspectRatio: inputs.aspectRatio } : {}),
      ...(inputs.customWidth && inputs.customHeight
        ? { custom: { width: inputs.customWidth, height: inputs.customHeight } }
        : {}),
      style: inputs.style,
      variations: inputs.variations,
      ...(inputs.logo ? { logo: inputs.logo } : {}),
    });

    await report('Preparing previews…', 90);
    // Serializable as-is: AssetView carries URLs and an ISO date, never bytes.
    return { ...result };
  },

  // Kept out of the queue on purpose: the onboarding preview is short and the
  // user is watching it. It has an entry so the enum stays exhaustive.
  BRAND_VOICE_PREVIEW: async () => ({}),
};

export async function runJob(job: GenerationJob): Promise<JobResult> {
  const report = async (message: string, percent: number) => {
    const progress: JobProgress = {
      step: 'running',
      message,
      percent: Math.max(0, Math.min(99, Math.round(percent))),
    };
    await reportProgress(job.id, progress);
  };
  return RUNNERS[job.kind](job, report);
}
