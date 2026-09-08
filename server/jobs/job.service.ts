import type { GenerationJob, GenerationJobKind, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

/**
 * Lifecycle for background generation jobs.
 *
 * The contract the UI relies on: creating a job never blocks, a job always
 * ends in SUCCEEDED or FAILED (never silently hangs), and its `inputs` survive
 * failure so retrying costs the user nothing.
 *
 * Running a job is deliberately NOT tied to the request that created it. The
 * client kicks the runner and polls; if it walks away, the runner still
 * finishes, and `reapStuckJobs()` closes out anything a killed instance left
 * behind. That is what makes a long generation survive a serverless timeout.
 */

/** A RUNNING job older than this was almost certainly killed mid-flight. */
const STUCK_AFTER_MS = 10 * 60 * 1000;
/** How long a QUEUED job may wait before the cron picks it up itself. */
const ORPHAN_AFTER_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;

export interface JobProgress {
  step: string;
  message: string;
  percent: number;
}

export function readProgress(job: GenerationJob): JobProgress {
  const p = (job.progress ?? {}) as Partial<JobProgress>;
  return {
    step: typeof p.step === 'string' ? p.step : 'queued',
    message:
      typeof p.message === 'string' && p.message
        ? p.message
        : 'Waiting to start…',
    percent: typeof p.percent === 'number' ? p.percent : 0,
  };
}

/**
 * Create a job — or hand back the one already doing this exact work.
 *
 * Double-clicking "Generate" must not start two digests. Reusing the in-flight
 * job of the same kind also means a reload reattaches to the run in progress
 * instead of starting a second one.
 */
export async function enqueueJob(args: {
  companyId: string;
  userId?: string | null;
  kind: GenerationJobKind;
  inputs?: Prisma.InputJsonValue;
  /**
   * Narrow the "already running?" check to jobs whose `inputs` match these
   * values.
   *
   * The default — one job of a kind per company — is right for the digest and
   * the monthly plan, where a second run genuinely is the same work. It is
   * wrong for image generation: two people making graphics for two different
   * posts are doing different work, and the second must not silently attach to
   * the first one's run. Passing `{ draftId }` keeps the double-click
   * protection while scoping it to the thing being generated.
   */
  dedupeOn?: Record<string, string>;
}): Promise<{
  job: GenerationJob;
  reused: boolean;
  /**
   * True when a job was reused but the caller asked for something DIFFERENT.
   *
   * Reuse is the right answer for a double-click, where the request is
   * identical. It is the wrong answer when the user edited the prompt and asked
   * again: they would silently receive the previous prompt's output. Callers
   * that care (graphic generation does) check this and say so instead.
   */
  inputsDiffer: boolean;
}> {
  const { companyId, userId, kind, inputs, dedupeOn } = args;

  const active = await db.generationJob.findFirst({
    where: {
      companyId,
      kind,
      status: { in: ['QUEUED', 'RUNNING'] },
      ...(dedupeOn
        ? {
            AND: Object.entries(dedupeOn).map(([key, value]) => ({
              inputs: { path: [key], equals: value },
            })),
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
  if (active && Date.now() - active.createdAt.getTime() < STUCK_AFTER_MS) {
    return {
      job: active,
      reused: true,
      inputsDiffer: !sameInputs(active.inputs, inputs),
    };
  }

  const job = await db.generationJob.create({
    data: {
      companyId,
      userId: userId ?? null,
      kind,
      inputs: inputs ?? {},
      progress: { step: 'queued', message: 'Queued…', percent: 0 },
    },
  });
  return { job, reused: false, inputsDiffer: false };
}

/**
 * Structural comparison of two job input bags.
 *
 * Key order is not meaningful in JSON, and Postgres does not preserve it in a
 * jsonb column anyway, so keys are sorted before comparing. Undefined values
 * are dropped so an omitted optional field and an explicitly-undefined one
 * compare equal — which is how the route builds these objects.
 */
function sameInputs(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Atomically move a job QUEUED -> RUNNING.
 *
 * Returns null when someone else already claimed it. The conditional update is
 * the whole point: the client kicks the runner AND the cron may retry the same
 * job, so exactly one of them must win.
 */
export async function claimJob(jobId: string): Promise<GenerationJob | null> {
  const { count } = await db.generationJob.updateMany({
    where: { id: jobId, status: 'QUEUED' },
    data: {
      status: 'RUNNING',
      startedAt: new Date(),
      attempts: { increment: 1 },
      progress: { step: 'starting', message: 'Starting…', percent: 5 },
    },
  });
  if (count === 0) return null;
  return db.generationJob.findUnique({ where: { id: jobId } });
}

export async function reportProgress(
  jobId: string,
  progress: JobProgress,
): Promise<void> {
  await db.generationJob.updateMany({
    where: { id: jobId, status: 'RUNNING' },
    data: { progress: { ...progress } },
  });
}

export async function completeJob(
  jobId: string,
  result: Prisma.InputJsonValue,
): Promise<void> {
  await db.generationJob.update({
    where: { id: jobId },
    data: {
      status: 'SUCCEEDED',
      result,
      error: null,
      finishedAt: new Date(),
      progress: { step: 'done', message: 'Done.', percent: 100 },
    },
  });
}

/**
 * Some failures cannot possibly succeed on a retry, and the providers already
 * say so — `ImageProviderError` carries `retryable`, set false for a rejected
 * API key, a model the key cannot reach, and an exhausted plan quota.
 *
 * Duck-typed rather than imported so this stays a job-layer concern: any error
 * that declares `retryable === false` is taken at its word, and anything that
 * says nothing keeps the old attempt-count behaviour.
 */
function isPermanent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'retryable' in error &&
    (error as { retryable?: unknown }).retryable === false
  );
}

/**
 * Fail a job. Under MAX_ATTEMPTS it returns to QUEUED so the reaper can try
 * again; the error is kept either way so the UI can say what went wrong even
 * while a retry is pending.
 *
 * A permanent failure skips that entirely. It used to not: retryability was
 * decided by attempt count alone, so a job that failed because the API key has
 * no quota went back to QUEUED announcing "Hit a snag — retrying…", was picked
 * up by the reaper, failed identically, and repeated until the attempt budget
 * ran out. The client meanwhile polls for a terminal status that does not
 * arrive and eventually gives up with "this is taking longer than expected".
 *
 * That is the generation-loops-forever report: three identical doomed attempts
 * plus a timeout, in place of one honest error the user could act on.
 */
export async function failJob(jobId: string, error: unknown): Promise<void> {
  const message =
    error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const job = await db.generationJob.findUnique({ where: { id: jobId } });
  const retryable =
    !isPermanent(error) && (job?.attempts ?? MAX_ATTEMPTS) < MAX_ATTEMPTS;

  await db.generationJob.update({
    where: { id: jobId },
    data: {
      status: retryable ? 'QUEUED' : 'FAILED',
      error: message.slice(0, 2000),
      finishedAt: retryable ? null : new Date(),
      progress: retryable
        ? { step: 'retrying', message: 'Hit a snag — retrying…', percent: 10 }
        : { step: 'failed', message: message.slice(0, 200), percent: 100 },
    },
  });
  logger.error('job: run failed', { jobId, retryable, error: message });
}

export async function getJob(
  companyId: string,
  jobId: string,
): Promise<GenerationJob | null> {
  return db.generationJob.findFirst({ where: { id: jobId, companyId } });
}

/**
 * An image-generation run still in flight for one draft, if there is one.
 *
 * Powers reattachment: reloading the page mid-generation should pick the run
 * back up rather than showing an idle panel while images are still being made.
 * Scoped by the draft id inside `inputs` for the same reason `dedupeOn` is —
 * a run for a different post is not this page's business.
 */
export async function findActiveImageJob(
  companyId: string,
  draftId: string,
): Promise<GenerationJob | null> {
  return db.generationJob.findFirst({
    where: {
      companyId,
      kind: 'IMAGE_GENERATION',
      status: { in: ['QUEUED', 'RUNNING'] },
      inputs: { path: ['draftId'], equals: draftId },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/** Latest job of a kind — how a page reattaches to a run already in flight. */
export async function latestJob(
  companyId: string,
  kind: GenerationJobKind,
): Promise<GenerationJob | null> {
  return db.generationJob.findFirst({
    where: { companyId, kind },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Close out jobs no live runner is attending to: RUNNING past the timeout
 * (its instance died), and QUEUED long enough that the client's kick clearly
 * never landed. Returns the ids worth running now.
 */
export async function reapStuckJobs(): Promise<{
  failed: number;
  runnable: string[];
}> {
  const now = Date.now();

  const stuck = await db.generationJob.findMany({
    where: {
      status: 'RUNNING',
      startedAt: { lt: new Date(now - STUCK_AFTER_MS) },
    },
    select: { id: true, attempts: true },
  });
  for (const job of stuck) {
    await db.generationJob.update({
      where: { id: job.id },
      data:
        job.attempts < MAX_ATTEMPTS
          ? {
              status: 'QUEUED',
              progress: { step: 'retrying', message: 'Restarting…', percent: 5 },
            }
          : {
              status: 'FAILED',
              error:
                'This run was interrupted and did not recover. Start it again.',
              finishedAt: new Date(),
              progress: { step: 'failed', message: 'Interrupted.', percent: 100 },
            },
    });
  }

  const orphans = await db.generationJob.findMany({
    where: {
      status: 'QUEUED',
      createdAt: { lt: new Date(now - ORPHAN_AFTER_MS) },
    },
    orderBy: { createdAt: 'asc' },
    take: 10,
    select: { id: true },
  });

  return {
    failed: stuck.filter((s) => s.attempts >= MAX_ATTEMPTS).length,
    runnable: orphans.map((o) => o.id),
  };
}
