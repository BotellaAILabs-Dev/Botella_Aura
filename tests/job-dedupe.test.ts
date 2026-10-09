import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Job reuse has to distinguish "the same request twice" from "a different
 * request while one is running".
 *
 * The first is a double-click and reuse is exactly right. The second is a user
 * who edited their prompt and asked again — reusing there hands them the
 * PREVIOUS prompt's images with nothing to indicate anything was ignored, which
 * is the failure this pins.
 */
const state = {
  active: null as Record<string, unknown> | null,
  created: [] as Array<Record<string, unknown>>,
  calls: [] as string[],
};

vi.mock('@/lib/db', () => {
  const tx = {
    // The advisory lock taken before the check (see enqueueJob).
    $queryRaw: vi.fn(async () => {
      state.calls.push('lock');
      return [];
    }),
    generationJob: {
      findFirst: vi.fn(async () => {
        state.calls.push('find');
        return state.active;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.created.push(data);
        return { id: 'job_new', status: 'QUEUED', progress: {}, ...data };
      }),
    },
  };
  return {
    db: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
  };
});

import { enqueueJob } from '@/server/jobs/job.service';

const INPUTS = {
  draftId: 'draft_1',
  prompt: 'A calm operations room at dawn',
  style: 'professional',
  variations: 2,
};

function activeJobWith(inputs: Record<string, unknown>) {
  return {
    id: 'job_running',
    status: 'RUNNING',
    inputs,
    progress: {},
    createdAt: new Date(),
  };
}

beforeEach(() => {
  state.active = null;
  state.created = [];
  state.calls = [];
});

describe('enqueueJob reuse', () => {
  it('creates a new job when nothing is running', async () => {
    const { job, reused, inputsDiffer } = await enqueueJob({
      companyId: 'c1',
      kind: 'IMAGE_GENERATION',
      inputs: INPUTS,
      dedupeOn: { draftId: 'draft_1' },
    });
    expect(reused).toBe(false);
    expect(inputsDiffer).toBe(false);
    expect(job.id).toBe('job_new');
  });

  it('takes the lock before looking, so simultaneous requests cannot both create', async () => {
    await enqueueJob({ companyId: 'c1', kind: 'MARKETING_PLAN', inputs: {} });
    expect(state.calls).toEqual(['lock', 'find']);
  });

  it('replaces a run past its fuse instead of reattaching to it', async () => {
    state.active = {
      ...activeJobWith({}),
      createdAt: new Date(Date.now() - 3 * 60 * 1000), // plan fuse is 2 minutes
    };
    const { job, reused } = await enqueueJob({
      companyId: 'c1',
      kind: 'MARKETING_PLAN',
      inputs: {},
    });
    expect(reused).toBe(false);
    expect(job.id).toBe('job_new');
  });

  it('reuses the running job for an IDENTICAL request (the double-click case)', async () => {
    state.active = activeJobWith({ ...INPUTS });

    const { job, reused, inputsDiffer } = await enqueueJob({
      companyId: 'c1',
      kind: 'IMAGE_GENERATION',
      inputs: { ...INPUTS },
      dedupeOn: { draftId: 'draft_1' },
    });

    expect(reused).toBe(true);
    expect(inputsDiffer).toBe(false);
    expect(job.id).toBe('job_running');
    // Crucially: no second job, so no second charge.
    expect(state.created).toHaveLength(0);
  });

  it('flags a reused job when the PROMPT changed', async () => {
    state.active = activeJobWith({ ...INPUTS, prompt: 'Something else entirely' });

    const { reused, inputsDiffer } = await enqueueJob({
      companyId: 'c1',
      kind: 'IMAGE_GENERATION',
      inputs: INPUTS,
      dedupeOn: { draftId: 'draft_1' },
    });

    expect(reused).toBe(true);
    // The route turns this into a 409 rather than silently returning the
    // other prompt's images.
    expect(inputsDiffer).toBe(true);
  });

  it('flags a change of model, format or variation count too', async () => {
    for (const changed of [
      { provider: 'STABILITY' },
      { aspectRatio: '9:16' },
      { variations: 4 },
      { style: 'cinematic' },
    ]) {
      state.active = activeJobWith({ ...INPUTS });
      const { inputsDiffer } = await enqueueJob({
        companyId: 'c1',
        kind: 'IMAGE_GENERATION',
        inputs: { ...INPUTS, ...changed },
        dedupeOn: { draftId: 'draft_1' },
      });
      expect(inputsDiffer).toBe(true);
    }
  });

  it('treats key order as insignificant', async () => {
    // jsonb does not preserve insertion order, so a round-tripped job must not
    // look "different" purely because Postgres reordered its keys.
    state.active = activeJobWith({
      variations: 2,
      style: 'professional',
      prompt: 'A calm operations room at dawn',
      draftId: 'draft_1',
    });

    const { inputsDiffer } = await enqueueJob({
      companyId: 'c1',
      kind: 'IMAGE_GENERATION',
      inputs: INPUTS,
      dedupeOn: { draftId: 'draft_1' },
    });
    expect(inputsDiffer).toBe(false);
  });
});
