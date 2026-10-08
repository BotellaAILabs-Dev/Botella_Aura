import { describe, it, expect } from 'vitest';

import { INSIGHT_TYPES } from '@/lib/business-context';
import {
  LEARNING_MIN_SAMPLE,
  REPEAT_HOLD_DAYS,
  historyCounts,
  historyOutcome,
  learningCandidates,
  repeatHold,
  toHistoryEntry,
  type HistorySource,
} from '@/lib/recommendation-history';

/**
 * Recommendation history: what Aura suggested before and what the business
 * did with it — and how that history stops repetition and can feed
 * Marketing Memory.
 */

const NOW = new Date('2026-10-08T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function source(o: Partial<HistorySource> = {}): HistorySource {
  return {
    id: 'rec1',
    title: 'Respond to Acme’s pricing change',
    action: 'Publish a post on LinkedIn.',
    type: 'COMPETITIVE_RESPONSE',
    status: 'EDITED',
    channel: 'LinkedIn',
    details: { action: 'response-post' },
    createdAt: daysAgo(5),
    decidedAt: daysAgo(4),
    decisionNote: 'Good timing.',
    editedAt: daysAgo(3),
    startedAt: null,
    completedAt: null,
    expiredAt: null,
    opportunity: {
      id: 'opp1',
      title: 'Acme cut prices',
      typeLabel: 'Competitor move',
      status: 'ACCEPTED',
    },
    events: [
      {
        action: 'generate',
        toStatus: 'GENERATED',
        actorName: null,
        source: 'engine',
        createdAt: daysAgo(5),
        metadata: {},
      },
      {
        action: 'present',
        toStatus: 'PRESENTED',
        actorName: 'Dana',
        source: 'user',
        createdAt: daysAgo(5),
        metadata: {},
      },
      {
        action: 'accept',
        toStatus: 'ACCEPTED',
        actorName: 'Dana',
        source: 'user',
        createdAt: daysAgo(4),
        metadata: {},
      },
      {
        action: 'edit',
        toStatus: 'EDITED',
        actorName: 'Dana',
        source: 'user',
        createdAt: daysAgo(3),
        metadata: {
          changes: {
            title: { from: 'a', to: 'b' },
            channel: { from: 'X', to: 'LinkedIn' },
          },
        },
      },
      {
        action: 'link',
        toStatus: 'EDITED',
        actorName: 'Dana',
        source: 'user',
        createdAt: daysAgo(2),
        metadata: {
          module: 'content-studio',
          created: {
            type: 'content-draft',
            id: 'd1',
            label: 'Our take on Acme',
          },
        },
      },
    ],
    ...o,
  };
}

describe('what happened to each recommendation', () => {
  it('accepted, edited, skipped, rejected, completed, in progress, withdrawn, expired', () => {
    expect(historyOutcome('ACCEPTED', ['GENERATED', 'ACCEPTED'])).toBe(
      'accepted',
    );
    expect(historyOutcome('EDITED', ['GENERATED', 'ACCEPTED', 'EDITED'])).toBe(
      'edited',
    );
    expect(
      historyOutcome('SKIPPED', ['GENERATED', 'PRESENTED', 'SKIPPED']),
    ).toBe('skipped');
    expect(historyOutcome('REJECTED', ['GENERATED', 'REJECTED'])).toBe(
      'rejected',
    );
    expect(
      historyOutcome('COMPLETED', ['GENERATED', 'ACCEPTED', 'COMPLETED']),
    ).toBe('completed');
    expect(
      historyOutcome('IN_PROGRESS', ['GENERATED', 'ACCEPTED', 'IN_PROGRESS']),
    ).toBe('in_progress');
    expect(historyOutcome('WITHDRAWN', ['GENERATED', 'WITHDRAWN'])).toBe(
      'withdrawn',
    );
    expect(historyOutcome('EXPIRED', ['GENERATED', 'EXPIRED'])).toBe('expired');
  });

  it('one still waiting for an answer is not history yet', () => {
    expect(historyOutcome('PRESENTED', ['GENERATED', 'PRESENTED'])).toBeNull();
    expect(
      toHistoryEntry(source({ status: 'PRESENTED', events: [] }), NOW),
    ).toBeNull();
  });
});

describe('a history entry', () => {
  const e = toHistoryEntry(source(), NOW)!;

  it('has the outcome, who decided, and the note', () => {
    expect(e.outcome).toBe('edited');
    expect(e.outcomeLabel).toBe('Edited & accepted');
    expect(e.decidedBy).toBe('Dana');
    expect(e.note).toBe('Good timing.');
  });

  it('has its timestamps', () => {
    expect(e.suggestedAt).toBe(daysAgo(5).toISOString());
    expect(e.decidedAt).toBe(daysAgo(4).toISOString());
    expect(e.editedAt).toBe(daysAgo(3).toISOString());
    expect(e.completedAt).toBeNull();
  });

  it('says what was changed, in words', () => {
    expect(e.changedFields).toEqual(['headline', 'channel']);
  });

  it('links to what a module made from it', () => {
    expect(e.made).toEqual([
      {
        module: 'Content Studio',
        label: 'Our take on Acme',
        href: '/dashboard/content/d1',
      },
    ]);
  });

  it('links back to its originating opportunity', () => {
    expect(e.opportunity).toEqual({
      id: 'opp1',
      title: 'Acme cut prices',
      typeLabel: 'Competitor move',
      status: 'ACCEPTED',
      href: '/dashboard/opportunities?focus=opp1',
    });
  });

  it('keeps the full timeline, without the noise of "shown"', () => {
    expect(e.timeline.map((t) => `${t.action} by ${t.by}`)).toEqual([
      'Suggested by Aura',
      'Accepted by Dana',
      'Edited by Dana',
      'Worked on by Dana',
    ]);
  });

  it('expired: decided by Aura; decided on the opportunity: says so', () => {
    expect(
      toHistoryEntry(
        source({
          status: 'EXPIRED',
          decidedAt: null,
          expiredAt: daysAgo(1),
          events: [
            {
              action: 'generate',
              toStatus: 'GENERATED',
              actorName: null,
              source: 'engine',
              createdAt: daysAgo(9),
              metadata: {},
            },
            {
              action: 'expire',
              toStatus: 'EXPIRED',
              actorName: null,
              source: 'system',
              createdAt: daysAgo(1),
              metadata: {},
            },
          ],
        }),
        NOW,
      )!,
    ).toEqual(
      expect.objectContaining({
        decidedBy: 'Aura',
        decidedAt: daysAgo(1).toISOString(),
      }),
    );
    expect(
      toHistoryEntry(
        source({
          status: 'REJECTED',
          events: [
            {
              action: 'reject',
              toStatus: 'REJECTED',
              actorName: 'Sam',
              source: 'opportunity',
              createdAt: daysAgo(4),
              metadata: {},
            },
          ],
        }),
        NOW,
      )!.decidedBy,
    ).toBe('Sam (on the opportunity)');
  });

  it('a completed one has its completion time', () => {
    const c = toHistoryEntry(
      source({
        status: 'COMPLETED',
        startedAt: daysAgo(2),
        completedAt: daysAgo(1),
      }),
      NOW,
    )!;
    expect(c.outcome).toBe('completed');
    expect(c.completedAt).toBe(daysAgo(1).toISOString());
    expect(c.startedAt).toBe(daysAgo(2).toISOString());
  });
});

describe('avoiding unnecessary repetition', () => {
  it(`a skip holds the opportunity back for ${REPEAT_HOLD_DAYS.skipped} days, then lets it come back`, () => {
    expect(
      repeatHold({ outcome: 'skipped', decidedAt: daysAgo(2) }, NOW),
    ).toEqual({
      held: true,
      until: daysAgo(2 - REPEAT_HOLD_DAYS.skipped!),
      text: 'Aura won’t suggest it again for 12 more days.',
    });
    expect(
      repeatHold({ outcome: 'skipped', decidedAt: daysAgo(20) }, NOW).held,
    ).toBe(false);
  });

  it(`a rejection holds similar ones back for ${REPEAT_HOLD_DAYS.rejected} days`, () => {
    const h = repeatHold({ outcome: 'rejected', decidedAt: daysAgo(10) }, NOW);
    expect(h.held).toBe(true);
    expect(h.text).toBe('Similar suggestions are held back for 20 more days.');
  });

  it('acted on: never suggested again; expired: free to come back if it still matters', () => {
    for (const outcome of [
      'accepted',
      'edited',
      'completed',
      'in_progress',
    ] as const) {
      expect(repeatHold({ outcome, decidedAt: daysAgo(100) }, NOW).held).toBe(
        true,
      );
    }
    expect(
      repeatHold({ outcome: 'expired', decidedAt: daysAgo(1) }, NOW).held,
    ).toBe(false);
  });

  it('the entry says whether Aura will suggest it again', () => {
    expect(
      toHistoryEntry(
        source({
          status: 'SKIPPED',
          decidedAt: daysAgo(1),
          events: [
            {
              action: 'skip',
              toStatus: 'SKIPPED',
              actorName: 'Dana',
              source: 'user',
              createdAt: daysAgo(1),
              metadata: {},
            },
          ],
        }),
        NOW,
      )!.repeat,
    ).toBe('Aura won’t suggest it again for 13 more days.');
  });
});

describe('counts and learning', () => {
  it('counts each outcome', () => {
    const c = historyCounts([
      { outcome: 'accepted' },
      { outcome: 'accepted' },
      { outcome: 'skipped' },
    ]);
    expect(c.all).toBe(3);
    expect(c.accepted).toBe(2);
    expect(c.skipped).toBe(1);
    expect(c.rejected).toBe(0);
  });

  const answer = (
    i: number,
    outcome: 'accepted' | 'rejected' | 'skipped' | 'edited',
    action = 'post',
    channel: string | null = 'LinkedIn',
  ) => ({ id: `r${i}`, outcome, channel, details: { action } });

  it(`no pattern before ${LEARNING_MIN_SAMPLE} answers of a kind`, () => {
    expect(
      learningCandidates([
        answer(1, 'accepted'),
        answer(2, 'accepted'),
        answer(3, 'edited'),
      ]),
    ).toEqual([]);
  });

  it('a clear yes or no becomes a Marketing Memory-shaped insight', () => {
    const c = learningCandidates([
      answer(1, 'accepted'),
      answer(2, 'edited'),
      answer(3, 'accepted'),
      answer(4, 'accepted'),
      answer(5, 'rejected', 'series', 'Instagram'),
      answer(6, 'rejected', 'series', 'Instagram'),
      answer(7, 'rejected', 'series', 'Instagram'),
      answer(8, 'rejected', 'series', 'Instagram'),
    ]);
    expect(c.map((x) => x.insight).sort()).toEqual(
      [
        'The business usually acts on single posts (4 of 4).',
        'The business usually acts on suggestions for LinkedIn (4 of 4).',
        'The business usually turns down post series (4 of 4).',
        'The business usually turns down suggestions for Instagram (4 of 4).',
      ].sort(),
    );
    for (const x of c) {
      expect(INSIGHT_TYPES).toContain(x.insightType);
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(x.confidence);
      expect(x.sampleSize).toBe(4);
      expect(x.supportingDataSummary.source).toBe('recommendation_history');
      expect(x.supportingDataSummary.recommendationIds).toHaveLength(4);
    }
  });

  it('skips say nothing about whether an idea was right; a mixed record is no pattern', () => {
    expect(
      learningCandidates([1, 2, 3, 4, 5].map((i) => answer(i, 'skipped'))),
    ).toEqual([]);
    expect(
      learningCandidates([
        answer(1, 'accepted'),
        answer(2, 'rejected'),
        answer(3, 'accepted'),
        answer(4, 'rejected'),
      ]),
    ).toEqual([]);
  });
});
