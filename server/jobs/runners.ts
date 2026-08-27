import type { GenerationJob, GenerationJobKind } from '@prisma/client';

import { planInputsSchema } from '@/lib/validations/planner';
import { generateDigestForCompany } from '@/server/trends/digest.service';
import { generateMarketingPlan } from '@/server/planner/plan.service';
import { generateIntelligenceSnapshot } from '@/server/intelligence/intelligence.service';
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
