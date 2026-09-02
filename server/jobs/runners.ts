import type { GenerationJob, GenerationJobKind } from '@prisma/client';

import { planInputsSchema } from '@/lib/validations/planner';
import { imageJobInputsSchema } from '@/lib/validations/media';
import { generateDigestForCompany } from '@/server/trends/digest.service';
import { generateMarketingPlan } from '@/server/planner/plan.service';
import { generateIntelligenceSnapshot } from '@/server/intelligence/intelligence.service';
import { getDraft } from '@/server/content/content.service';
import { generateGraphics } from '@/server/media/generation.service';
import { reportProgress, type JobProgress } from '@/server/jobs/job.service';

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
      style: inputs.style,
      variations: inputs.variations,
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
