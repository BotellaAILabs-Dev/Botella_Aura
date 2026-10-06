import { describe, it, expect } from 'vitest';

import { canTransition } from '@/lib/opportunities';
import {
  ACCEPTED_RECOMMENDATION_STATUSES,
  ACTION_FOR_STATUS,
  EDITABLE_FIELDS,
  OPEN_RECOMMENDATION_STATUSES,
  OPPORTUNITY_TO_RECOMMENDATION,
  RECOMMENDATION_ACTIONS,
  RECOMMENDATION_STATUSES,
  RECOMMENDATION_TO_OPPORTUNITY,
  RECOMMENDATION_TRANSITIONS,
  USER_SETTABLE_STATUSES,
  canTransitionRecommendation,
  diffEdit,
  isRecommendationPastRelevance,
  recommendationOutcome,
} from '@/lib/recommendations';

/**
 * The Recommendation Lifecycle (lib/recommendations.ts):
 *
 *   Generated → Presented → Accepted / Edited / Skipped / Rejected → Completed
 *
 * The database half — persisted actions, timestamps, history, duplicate
 * protection, opportunity sync — is proven by scripts/verify-lifecycle.ts.
 */
describe('the status model', () => {
  it('has every status of the ticket, plus in progress, withdrawn and expired', () => {
    expect(RECOMMENDATION_STATUSES).toEqual([
      'GENERATED',
      'PRESENTED',
      'ACCEPTED',
      'EDITED',
      'SKIPPED',
      'REJECTED',
      'IN_PROGRESS',
      'COMPLETED',
      'WITHDRAWN',
      'EXPIRED',
    ]);
  });

  it('generated → presented → each decision', () => {
    expect(canTransitionRecommendation('GENERATED', 'PRESENTED')).toBe(true);
    for (const d of ['ACCEPTED', 'EDITED', 'SKIPPED', 'REJECTED'] as const) {
      expect(canTransitionRecommendation('PRESENTED', d)).toBe(true);
      // A decision can also be made on one never formally presented.
      expect(canTransitionRecommendation('GENERATED', d)).toBe(true);
    }
  });

  it('accepted or edited → completed (directly, or after starting)', () => {
    for (const s of ACCEPTED_RECOMMENDATION_STATUSES) {
      expect(canTransitionRecommendation(s, 'COMPLETED')).toBe(true);
      expect(canTransitionRecommendation(s, 'IN_PROGRESS')).toBe(true);
    }
    expect(canTransitionRecommendation('IN_PROGRESS', 'COMPLETED')).toBe(true);
  });

  it('nothing undecided can be completed or started', () => {
    for (const s of OPEN_RECOMMENDATION_STATUSES) {
      expect(canTransitionRecommendation(s, 'COMPLETED')).toBe(false);
      expect(canTransitionRecommendation(s, 'IN_PROGRESS')).toBe(false);
    }
  });

  it('a presented recommendation is never "un-presented"', () => {
    expect(canTransitionRecommendation('PRESENTED', 'GENERATED')).toBe(false);
    for (const s of RECOMMENDATION_STATUSES) {
      expect(canTransitionRecommendation(s, 'GENERATED')).toBe(false);
    }
  });

  it('an accepted recommendation can still be edited; a rejected or skipped one cannot', () => {
    expect(canTransitionRecommendation('ACCEPTED', 'EDITED')).toBe(true);
    expect(canTransitionRecommendation('EDITED', 'EDITED')).toBe(true);
    expect(canTransitionRecommendation('REJECTED', 'EDITED')).toBe(false);
    expect(canTransitionRecommendation('SKIPPED', 'EDITED')).toBe(false);
  });

  it('a decision is not silently reversed (accepted cannot become rejected)', () => {
    expect(canTransitionRecommendation('ACCEPTED', 'REJECTED')).toBe(false);
    expect(canTransitionRecommendation('ACCEPTED', 'SKIPPED')).toBe(false);
    expect(canTransitionRecommendation('REJECTED', 'ACCEPTED')).toBe(false);
    expect(canTransitionRecommendation('SKIPPED', 'ACCEPTED')).toBe(false);
  });

  it('no status moves to itself except EDITED (a further edit is a new change)', () => {
    for (const s of RECOMMENDATION_STATUSES) {
      expect(canTransitionRecommendation(s, s)).toBe(s === 'EDITED');
    }
  });

  it('every target of every move is a known status', () => {
    for (const targets of Object.values(RECOMMENDATION_TRANSITIONS)) {
      for (const t of targets) expect(RECOMMENDATION_STATUSES).toContain(t);
    }
  });

  it('only undecided recommendations expire', () => {
    const past = new Date(Date.now() - 1000);
    for (const s of RECOMMENDATION_STATUSES) {
      expect(
        isRecommendationPastRelevance(
          { status: s, relevantUntil: past },
          new Date(),
        ),
      ).toBe(s === 'GENERATED' || s === 'PRESENTED');
    }
  });
});

describe('actions recorded in history', () => {
  it('every status has its own action, all distinct', () => {
    const actions = RECOMMENDATION_STATUSES.map((s) => ACTION_FOR_STATUS[s]);
    expect(new Set(actions).size).toBe(RECOMMENDATION_STATUSES.length);
    for (const a of actions) expect(RECOMMENDATION_ACTIONS).toContain(a);
  });

  it('a person sets accept / skip / reject / start / complete / withdraw by hand — never presented, edited or expired', () => {
    expect([...USER_SETTABLE_STATUSES].sort()).toEqual(
      [
        'ACCEPTED',
        'SKIPPED',
        'REJECTED',
        'IN_PROGRESS',
        'COMPLETED',
        'WITHDRAWN',
      ].sort(),
    );
  });
});

describe('accepted, edited, skipped and rejected are told apart', () => {
  it('the outcome is the first decision', () => {
    expect(recommendationOutcome(['GENERATED', 'PRESENTED'])).toBe('undecided');
    expect(recommendationOutcome(['GENERATED', 'ACCEPTED', 'COMPLETED'])).toBe(
      'accepted',
    );
    expect(recommendationOutcome(['GENERATED', 'PRESENTED', 'SKIPPED'])).toBe(
      'skipped',
    );
    expect(recommendationOutcome(['GENERATED', 'REJECTED'])).toBe('rejected');
    expect(recommendationOutcome(['GENERATED', 'EXPIRED'])).toBe('expired');
    expect(recommendationOutcome(['GENERATED', 'WITHDRAWN'])).toBe('withdrawn');
  });

  it('an edit is a yes with changes — even after accepting', () => {
    expect(recommendationOutcome(['GENERATED', 'EDITED'])).toBe('edited');
    expect(
      recommendationOutcome(['GENERATED', 'ACCEPTED', 'EDITED', 'COMPLETED']),
    ).toBe('edited');
  });
});

describe('opportunity sync', () => {
  it('accepted and edited both accept the opportunity; rejected rejects it', () => {
    expect(RECOMMENDATION_TO_OPPORTUNITY.ACCEPTED).toBe('ACCEPTED');
    expect(RECOMMENDATION_TO_OPPORTUNITY.EDITED).toBe('ACCEPTED');
    expect(RECOMMENDATION_TO_OPPORTUNITY.REJECTED).toBe('REJECTED');
  });

  it('presenting or skipping leaves the opportunity open (it can be recommended again)', () => {
    expect(RECOMMENDATION_TO_OPPORTUNITY.PRESENTED).toBeNull();
    expect(RECOMMENDATION_TO_OPPORTUNITY.SKIPPED).toBeNull();
  });

  it('every opportunity decision can be carried onto a presented recommendation too', () => {
    for (const to of Object.values(OPPORTUNITY_TO_RECOMMENDATION)) {
      expect(canTransitionRecommendation('PRESENTED', to!)).toBe(true);
    }
    for (const to of Object.values(RECOMMENDATION_TO_OPPORTUNITY)) {
      if (to && to !== 'RECOMMENDED') {
        expect(canTransition('RECOMMENDED', to)).toBe(true);
      }
    }
  });
});

describe('diffEdit — what an edit changed', () => {
  const before = {
    title: 'Answer Acme',
    summary: 'Acme cut prices.',
    steps: ['Draft', 'Post'],
    channel: 'Instagram',
    audience: null,
  };

  it('records only the fields that changed, from → to', () => {
    expect(
      diffEdit(before, {
        title: 'Answer Acme on freshness',
        channel: 'Instagram',
      }),
    ).toEqual({
      title: { from: 'Answer Acme', to: 'Answer Acme on freshness' },
    });
  });

  it('an edit that changes nothing is empty (a no-op, not a history entry)', () => {
    expect(
      diffEdit(before, { title: 'Answer Acme', steps: ['Draft', 'Post'] }),
    ).toEqual({});
    expect(diffEdit(before, {})).toEqual({});
  });

  it('compares lists by value and treats a missing value as null', () => {
    expect(diffEdit(before, { steps: ['Draft', 'Review', 'Post'] })).toEqual({
      steps: { from: ['Draft', 'Post'], to: ['Draft', 'Review', 'Post'] },
    });
    expect(diffEdit(before, { audience: 'Home brewers' })).toEqual({
      audience: { from: null, to: 'Home brewers' },
    });
    expect(diffEdit({ audience: undefined }, { audience: null })).toEqual({});
  });

  it('ignores anything that is not an editable field', () => {
    expect(
      diffEdit(before, { confidence: 'HIGH', opportunityId: 'x' } as never),
    ).toEqual({});
    expect(EDITABLE_FIELDS).not.toContain('confidence');
    expect(EDITABLE_FIELDS).not.toContain('opportunityId');
  });
});
