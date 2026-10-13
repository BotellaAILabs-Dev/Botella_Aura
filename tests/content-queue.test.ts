import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * "Add to queue" must not become a back door around approval.
 *
 * The product's trust backbone is that nothing publishes without a human
 * Approve. The composer's queue action is the newest thing that touches draft
 * status, which makes it the most likely place for that guarantee to be
 * weakened by accident — so what it is allowed to do is pinned here.
 */
const draftRow = {
  id: 'draft_1',
  companyId: 'company_1',
  status: 'DRAFT' as string,
  type: 'LINKEDIN_POST',
  platform: null as string | null,
  scheduledFor: null as Date | null,
  rejectionReason: null as string | null,
  body: { hook: 'A post' } as unknown,
  aiMetadata: {} as unknown,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
};

const state = {
  draft: { ...draftRow },
  updates: [] as Array<Record<string, unknown>>,
};

vi.mock('@/lib/db', () => ({
  db: {
    // The approval fingerprint reads the attached images (lib/approval.ts).
    contentMedia: { findMany: vi.fn(async () => []) },
    contentDraft: {
      findFirst: vi.fn(async () => state.draft),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.updates.push(data);
        return { ...state.draft, ...data };
      }),
    },
  },
}));

const auditCalls: Array<{ action: string }> = [];
vi.mock('@/server/services/audit.service', () => ({
  recordAudit: vi.fn(async (entry: { action: string }) => {
    auditCalls.push(entry);
  }),
}));

import {
  queueDraft,
  isValidTransition,
} from '@/server/content/content.service';

beforeEach(() => {
  state.draft = { ...draftRow };
  state.updates = [];
  auditCalls.length = 0;
});

describe('queueDraft', () => {
  it('moves a DRAFT into review rather than approving it', async () => {
    const result = await queueDraft({
      companyId: 'company_1',
      userId: 'user_1',
      draftId: 'draft_1',
      platform: 'LINKEDIN',
    });

    expect(result.status).toBe('PENDING_APPROVAL');
    // The one thing that must never happen here.
    expect(result.status).not.toBe('APPROVED');
    expect(state.updates[0]!.status).toBe('PENDING_APPROVAL');
  });

  it('records the platform and the scheduled time', async () => {
    const when = new Date(Date.now() + 86_400_000);
    await queueDraft({
      companyId: 'company_1',
      userId: 'user_1',
      draftId: 'draft_1',
      platform: 'INSTAGRAM',
      scheduledFor: when,
    });

    expect(state.updates[0]).toMatchObject({
      platform: 'INSTAGRAM',
      scheduledFor: when,
    });
  });

  it('leaves an APPROVED draft approved when the time is adjusted', async () => {
    // Re-queueing to change the schedule must not force a second approval
    // round — that would punish the user for editing a detail.
    state.draft = { ...draftRow, status: 'APPROVED' };

    const result = await queueDraft({
      companyId: 'company_1',
      userId: 'user_1',
      draftId: 'draft_1',
      scheduledFor: new Date(Date.now() + 3_600_000),
    });

    expect(result.status).toBe('APPROVED');
    expect(state.updates[0]!.status).toBeUndefined();
  });

  it('clears the rejection reason when a REJECTED draft is re-queued', async () => {
    state.draft = {
      ...draftRow,
      status: 'REJECTED',
      rejectionReason: 'Too salesy',
    };

    await queueDraft({
      companyId: 'company_1',
      userId: 'user_1',
      draftId: 'draft_1',
    });

    expect(state.updates[0]).toMatchObject({
      status: 'PENDING_APPROVAL',
      rejectionReason: null,
    });
  });

  it('refuses to re-queue a published post', async () => {
    state.draft = { ...draftRow, status: 'PUBLISHED' };

    await expect(
      queueDraft({
        companyId: 'company_1',
        userId: 'user_1',
        draftId: 'draft_1',
      }),
    ).rejects.toThrow(/already been published/i);
    expect(state.updates).toHaveLength(0);
  });

  it('writes an audit entry for the queueing', async () => {
    await queueDraft({
      companyId: 'company_1',
      userId: 'user_1',
      draftId: 'draft_1',
      platform: 'LINKEDIN',
    });
    expect(auditCalls.map((a) => a.action)).toContain('CONTENT_QUEUED');
  });
});

describe('approval state machine, after the queue change', () => {
  it('still only allows PUBLISHED from APPROVED', () => {
    // Regression guard: adding queueing must not have widened the gate.
    expect(isValidTransition('APPROVED', 'PUBLISHED')).toBe(true);
    expect(isValidTransition('PENDING_APPROVAL', 'PUBLISHED')).toBe(false);
    expect(isValidTransition('DRAFT', 'PUBLISHED')).toBe(false);
  });
});
