import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A job that cannot possibly succeed must not be retried.
 *
 * Retryability used to be decided by attempt count alone, which meant a
 * generation that failed because the API key has no image quota went back to
 * QUEUED announcing "Hit a snag — retrying…", was picked up by the reaper,
 * failed identically, and repeated until the attempt budget ran out. The
 * client polls for a terminal status that never arrives and eventually reports
 * "this is taking longer than expected" — so the user sees a generation that
 * loops and then times out, never the one-line reason it could never work.
 *
 * The providers already know the difference and say so on the error. These
 * pin that the job layer listens.
 */
const state = {
  job: { id: 'job_1', attempts: 1 } as { id: string; attempts: number },
  updated: null as Record<string, unknown> | null,
};

vi.mock('@/lib/db', () => ({
  db: {
    generationJob: {
      findUnique: vi.fn(async () => state.job),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.updated = data;
        return { id: 'job_1', ...data };
      }),
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { failJob } from '@/server/jobs/job.service';
import { ImageProviderError, NoImageProviderError } from '@/server/media/types';

beforeEach(() => {
  state.job = { id: 'job_1', attempts: 1 };
  state.updated = null;
});

describe('failJob — permanent vs transient', () => {
  it('fails immediately on a non-retryable provider error, well under the attempt budget', async () => {
    await failJob(
      'job_1',
      new ImageProviderError(
        'GOOGLE',
        'This Google API key has no image-generation quota left.',
        429,
        false,
      ),
    );

    expect(state.updated?.status).toBe('FAILED');
    expect(state.updated?.finishedAt).toBeInstanceOf(Date);
    // The reason survives to the UI rather than being replaced by "retrying".
    expect(state.updated?.error).toContain('no image-generation quota');
    expect((state.updated?.progress as { step: string }).step).toBe('failed');
  });

  it('treats a missing provider key as permanent', async () => {
    await failJob('job_1', new NoImageProviderError());
    expect(state.updated?.status).toBe('FAILED');
  });

  it('still retries a transient failure that says nothing about retryability', async () => {
    await failJob('job_1', new Error('socket hang up'));

    expect(state.updated?.status).toBe('QUEUED');
    expect(state.updated?.finishedAt).toBeNull();
    expect((state.updated?.progress as { step: string }).step).toBe('retrying');
  });

  it('still retries a provider error that is explicitly retryable', async () => {
    await failJob(
      'job_1',
      new ImageProviderError('GOOGLE', 'Rate limited, try again', 429, true),
    );
    expect(state.updated?.status).toBe('QUEUED');
  });

  it('stops retrying a transient failure once the attempt budget is spent', async () => {
    state.job = { id: 'job_1', attempts: 3 };
    await failJob('job_1', new Error('socket hang up'));
    expect(state.updated?.status).toBe('FAILED');
  });
});
