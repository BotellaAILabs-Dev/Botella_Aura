import { describe, it, expect } from 'vitest';

import {
  approvalId,
  briefId,
  reviewId,
  traceOf,
  TRACE_LINKS,
} from '@/lib/trace';
import { addVersion, markApproved, newLog } from '@/lib/versions';
import { bodyHash } from '@/lib/content-review';
import {
  traceFor,
  withApprovalTrace,
  withReviewTrace,
} from '@/server/trace/trace.service';

/**
 * Recommendation → content traceability: the chain's ids are kept on the
 * asset and move on through review and approval.
 */

const v1 = { caption: 'New rye.' };
const v2 = { caption: 'New small-batch rye.' };

const draft = (
  meta: Record<string, unknown>,
  over: Record<string, unknown> = {},
) =>
  ({
    id: 'draft_1',
    status: 'PENDING_APPROVAL',
    body: v2,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    aiMetadata: meta,
    ...over,
  }) as never;

describe('ids', () => {
  it('a brief has a stable id; approvals and reviews get unique ones', () => {
    expect(briefId({ keyMessage: 'x', audience: 'y' })).toBe(
      briefId({ audience: 'y', keyMessage: 'x' }),
    );
    expect(briefId({ keyMessage: 'x' })).not.toBe(briefId({ keyMessage: 'z' }));
    expect(briefId(null)).toBeNull();
    expect(approvalId('d', 2, '2026-10-13T10:00:00Z')).toMatch(/^apv_/);
    expect(approvalId('d', 2, 'a')).not.toBe(approvalId('d', 3, 'a'));
    expect(reviewId('abc', 't')).toMatch(/^rvw_/);
  });

  it('the chain runs from the business context to the approved version', () => {
    expect([...TRACE_LINKS]).toEqual([
      'business_context',
      'signal',
      'opportunity',
      'recommendation',
      'brief',
      'generated',
      'reviewed',
      'approved',
    ]);
  });
});

describe('on the asset', () => {
  it('an asset made before traces is traced from its provenance and brief', () => {
    const t = traceFor(
      draft({
        recommendation: { recommendationId: 'rec_1', opportunityId: 'opp_1' },
        brief: { keyMessage: { value: 'k' } },
        contextRevision: 'r7',
      }),
    );
    expect(t).toMatchObject({
      recommendationId: 'rec_1',
      opportunityId: 'opp_1',
      traceId: 'trc_draft_1',
      businessContext: { revision: 'r7' },
    });
    expect(t.briefId).toMatch(/^brf_/);
  });

  it('a review records which version it was of', () => {
    const versions = addVersion(newLog(v1, 'x'), {
      body: v2,
      source: 'edited',
      by: 'u',
    });
    const review = {
      bodyHash: bodyHash(v2),
      reviewedAt: '2026-10-13T10:00:00Z',
      status: 'pass',
    } as never;
    const meta = withReviewTrace(draft({ versions }), { versions }, review);
    expect(traceOf(meta)).toMatchObject({ reviewedVersion: 2 });
    expect(traceOf(meta)!.reviewId).toMatch(/^rvw_/);
  });

  it('an approval gets an id, and the trace points at the approved version, the approval and the images', () => {
    const versions = markApproved(
      addVersion(newLog(v1, 'x'), { body: v2, source: 'edited', by: 'u' }),
      'owner_1',
    );
    const approval = {
      model: 1,
      version: 2,
      hash: 'h',
      approved: {
        by: 'owner_1',
        via: 'person',
        at: '2026-10-13T11:00:00Z',
        version: 2,
        hash: 'h',
        snapshot: {},
      },
      rejected: null,
      events: [],
    };
    const meta = withApprovalTrace(
      draft({ versions, approval }),
      {
        versions,
        approval,
        trace: { ...traceFor(draft({})), recommendationId: 'rec_1' },
      },
      ['asset_a'],
    ) as Record<string, unknown>;
    const t = traceOf(meta)!;
    expect(t).toMatchObject({
      approvedVersion: 2,
      mediaAssetIds: ['asset_a'],
      recommendationId: 'rec_1',
    });
    expect(t.approvalId).toMatch(/^apv_/);
    expect((meta.approval as { approved: { id: string } }).approved.id).toBe(
      t.approvalId,
    );
  });
});
