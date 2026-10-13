import { describe, it, expect } from 'vitest';

import {
  APPROVAL_STATES,
  approvalIntact,
  campaignTaskState,
  canMove,
  contentFingerprint,
  contentState,
  emptyRecord,
  MAX_EVENTS,
  outreachState,
  summarize,
  textFingerprint,
  withEvent,
  type ApprovalRecord,
} from '@/lib/approval';
import {
  contentMetaAfter,
  contentRecord,
  outreachMetaAfter,
} from '@/server/approval/approval.service';

/**
 * The unified approval model: one set of states for content, campaigns and
 * outreach; approvals that record who, when and exactly what; and approved
 * work that cannot change without being reopened.
 */

const NOW = new Date('2026-10-13T12:00:00Z');
const body = {
  caption: 'New rye on the shelf.',
  cta: 'Visit us',
  hashtags: [],
  altText: '',
};
const fp = (
  b: unknown = body,
  platform: string | null = 'INSTAGRAM',
  media: { assetId: string; altText?: string | null }[] = [],
) => contentFingerprint({ body: b, platform, media });

describe('one set of states for every module', () => {
  it('content: draft or generated, review required, approved, scheduled, ready, rejected, executed', () => {
    const generated = withEvent(emptyRecord('h'), {
      at: '',
      by: null,
      action: 'generated',
      from: 'draft',
      to: 'generated',
      version: 1,
      hash: 'h',
    });
    const edited = withEvent(generated, {
      at: '',
      by: 'u',
      action: 'edited',
      from: 'generated',
      to: 'draft',
      version: 2,
      hash: 'h2',
    });
    expect(
      contentState({ status: 'DRAFT', scheduledFor: null }, generated),
    ).toBe('generated');
    expect(contentState({ status: 'DRAFT', scheduledFor: null }, edited)).toBe(
      'draft',
    );
    expect(
      contentState({ status: 'PENDING_APPROVAL', scheduledFor: null }, null),
    ).toBe('review_required');
    expect(contentState({ status: 'APPROVED', scheduledFor: null }, null)).toBe(
      'approved',
    );
    expect(
      contentState(
        { status: 'APPROVED', scheduledFor: new Date('2026-10-20') },
        null,
        NOW,
      ),
    ).toBe('scheduled');
    expect(
      contentState(
        { status: 'APPROVED', scheduledFor: new Date('2026-10-10') },
        null,
        NOW,
      ),
    ).toBe('ready_for_execution');
    expect(contentState({ status: 'REJECTED', scheduledFor: null }, null)).toBe(
      'rejected',
    );
    expect(
      contentState({ status: 'PUBLISHED', scheduledFor: null }, null),
    ).toBe('executed');
  });

  it('outreach: approved messages are ready to send; sent is executed', () => {
    expect(outreachState({ status: 'PENDING_APPROVAL' }, null)).toBe(
      'review_required',
    );
    expect(outreachState({ status: 'APPROVED' }, null)).toBe(
      'ready_for_execution',
    );
    expect(outreachState({ status: 'SENT' }, null)).toBe('executed');
  });

  it('campaign tasks follow their content; before it exists they are planned', () => {
    expect(campaignTaskState({ status: 'GENERATED' }, 'approved')).toBe(
      'approved',
    );
    expect(campaignTaskState({ status: 'PENDING' }, null)).toBe('draft');
    expect(campaignTaskState({ status: 'SKIPPED' }, null)).toBe('rejected');
  });

  it('transitions: nothing is approved twice, executed is final, approved work only leaves by a visible reopen', () => {
    expect(canMove('approved', 'approved')).toBe(false);
    expect(canMove('review_required', 'approved')).toBe(true);
    expect(canMove('approved', 'draft')).toBe(true);
    expect(canMove('executed', 'draft')).toBe(false);
    expect(canMove('rejected', 'approved')).toBe(false);
    for (const s of APPROVAL_STATES)
      expect(
        canMove(s, 'generated') ? ['draft', 'generated', 'rejected'] : [],
      ).not.toContain('approved');
  });
});

describe('what an approval covers', () => {
  it('the text, the network and the images, in order — key order does not matter', () => {
    expect(
      fp({
        cta: 'Visit us',
        caption: 'New rye on the shelf.',
        altText: '',
        hashtags: [],
      }),
    ).toBe(fp());
    expect(fp({ ...body, caption: 'Changed.' })).not.toBe(fp());
    expect(fp(body, 'FACEBOOK')).not.toBe(fp());
    expect(fp(body, 'INSTAGRAM', [{ assetId: 'a' }])).not.toBe(fp());
    expect(
      fp(body, 'INSTAGRAM', [{ assetId: 'a' }, { assetId: 'b' }]),
    ).not.toBe(fp(body, 'INSTAGRAM', [{ assetId: 'b' }, { assetId: 'a' }]));
    expect(textFingerprint('Hi Priya')).not.toBe(textFingerprint('Hi Priya!'));
  });

  it('history is capped, and older events drop their content snapshots first', () => {
    let r: ApprovalRecord = emptyRecord('h');
    for (let i = 0; i < MAX_EVENTS + 10; i++) {
      r = withEvent(r, {
        at: String(i),
        by: 'u',
        action: 'edited',
        from: 'draft',
        to: 'draft',
        version: i,
        hash: 'h',
        previous: { n: i },
      });
    }
    expect(r.events).toHaveLength(MAX_EVENTS);
    expect(r.events[0]!.previous).toEqual({ n: MAX_EVENTS + 9 });
    expect(r.events[MAX_EVENTS - 1]!.previous).toBeUndefined();
  });
});

describe('approval records', () => {
  const draft = (over: Record<string, unknown> = {}) =>
    ({
      id: 'd1',
      status: 'PENDING_APPROVAL',
      body,
      platform: 'INSTAGRAM',
      scheduledFor: null,
      updatedAt: new Date('2026-10-01T00:00:00Z'),
      aiMetadata: {},
      ...over,
    }) as never;

  it('an approval stores the approver, the time, the version and exactly what was approved', () => {
    const meta = contentMetaAfter(draft(), fp(), {
      action: 'approved',
      by: 'user_1',
      nextStatus: 'APPROVED',
      nextHash: fp(),
      approve: { via: 'person', snapshot: { body } },
    }) as unknown as { approval: ApprovalRecord };
    const r = meta.approval;
    expect(r.approved).toMatchObject({
      by: 'user_1',
      via: 'person',
      version: 1,
      hash: fp(),
      snapshot: { body },
    });
    expect(new Date(r.approved!.at).getTime()).toBeGreaterThan(0);
    expect(r.events[0]).toMatchObject({
      action: 'approved',
      from: 'review_required',
      to: 'approved',
      by: 'user_1',
    });
    expect(approvalIntact(r, fp())).toBe(true);
  });

  it('an edit after approval moves the version on, keeps the previous text, and leaves the approval visibly broken', () => {
    const approved = contentMetaAfter(draft(), fp(), {
      action: 'approved',
      by: 'u1',
      nextStatus: 'APPROVED',
      nextHash: fp(),
      approve: { via: 'person', snapshot: { body } },
    });
    const next = { ...body, caption: 'Edited.' };
    const edited = contentMetaAfter(
      draft({ status: 'APPROVED', aiMetadata: approved }),
      fp(),
      {
        action: 'edited',
        by: 'u2',
        nextStatus: 'DRAFT',
        nextHash: fp(next),
        previous: body,
      },
    ) as unknown as { approval: ApprovalRecord };
    const r = edited.approval;
    expect(r.version).toBe(2);
    expect(r.events[0]).toMatchObject({
      action: 'edited',
      from: 'approved',
      to: 'draft',
      previous: body,
      version: 2,
    });
    expect(r.approved!.snapshot).toEqual({ body }); // what WAS approved is kept
    expect(approvalIntact(r, fp(next))).toBe(false);
    expect(summarize('draft', r, fp(next))).toMatchObject({
      edits: 1,
      approvedBy: 'u1',
      intact: null,
    });
  });

  it('a rejection keeps who, why and when — and the history stays', () => {
    const r = (
      contentMetaAfter(draft(), fp(), {
        action: 'rejected',
        by: 'u1',
        nextStatus: 'REJECTED',
        nextHash: fp(),
        reason: 'Off brand',
      }) as unknown as { approval: ApprovalRecord }
    ).approval;
    expect(r.rejected).toMatchObject({
      by: 'u1',
      reason: 'Off brand',
      version: 1,
    });
    const again = (
      contentMetaAfter(
        draft({ status: 'REJECTED', aiMetadata: { approval: r } }),
        fp(),
        {
          action: 'regenerated',
          by: 'u2',
          nextStatus: 'DRAFT',
          nextHash: fp({ ...body, caption: 'New take.' }),
          previous: body,
        },
      ) as unknown as { approval: ApprovalRecord }
    ).approval;
    expect(again.events.map((e) => e.action)).toEqual([
      'regenerated',
      'rejected',
    ]);
    expect(again.rejected!.reason).toBe('Off brand');
  });

  it('Autopilot approvals are recorded as the machine’s, not a person’s', () => {
    const r = (
      contentMetaAfter(draft({ status: 'DRAFT' }), fp(), {
        action: 'approved',
        by: null,
        nextStatus: 'APPROVED',
        nextHash: fp(),
        approve: { via: 'autopilot', snapshot: { body } },
      }) as unknown as { approval: ApprovalRecord }
    ).approval;
    expect(r.approved).toMatchObject({ by: null, via: 'autopilot' });
  });

  it('an item approved before records existed is recorded as approved as it stands', () => {
    const r = contentRecord(draft({ status: 'APPROVED' }), fp());
    expect(r.approved).toMatchObject({ by: null, hash: fp(), version: 1 });
    expect(contentRecord(draft({ status: 'DRAFT' }), fp()).approved).toBeNull();
  });

  it('outreach: approve, then an edit keeps the old message', () => {
    const m = {
      status: 'PENDING_APPROVAL',
      draftText: 'Hi Priya',
      updatedAt: new Date(),
      aiMetadata: {},
    } as never;
    const a = outreachMetaAfter(m, {
      action: 'approved',
      by: 'u1',
      nextStatus: 'APPROVED',
      approve: true,
    }) as unknown as { approval: ApprovalRecord };
    expect(a.approval.approved).toMatchObject({
      by: 'u1',
      snapshot: 'Hi Priya',
    });
    const e = outreachMetaAfter(
      { ...(m as object), status: 'APPROVED', aiMetadata: a } as never,
      {
        action: 'edited',
        by: 'u2',
        nextStatus: 'DRAFT',
        nextText: 'Hi Priya!',
      },
    ) as unknown as { approval: ApprovalRecord };
    expect(e.approval.events[0]).toMatchObject({
      action: 'edited',
      from: 'ready_for_execution',
      to: 'draft',
      previous: 'Hi Priya',
      version: 2,
    });
  });
});
