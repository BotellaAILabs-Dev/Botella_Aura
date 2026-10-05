import { describe, it, expect } from 'vitest';

import {
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_TYPES,
  canTransition,
  type OpportunityType,
} from '@/lib/opportunities';
import { buildHandoff, type HandoffSource } from '@/lib/recommendation-handoff';
import {
  LIVE_RECOMMENDATION_STATUSES,
  OPPORTUNITY_TO_RECOMMENDATION,
  RECOMMENDATION_STATUSES,
  RECOMMENDATION_TO_OPPORTUNITY,
  RECOMMENDATION_TRANSITIONS,
  TYPE_FOR_OPPORTUNITY,
  boundByOpportunity,
  canTransitionRecommendation,
  draftFromOpportunity,
  executionBrief,
  isRecommendationPastRelevance,
  recommendationContentSchema,
} from '@/lib/recommendations';

/**
 * The Recommendation model's rules: what a recommendation must contain, its
 * lifecycle and how it stays in step with its opportunity, the default draft
 * built from an opportunity, and the brief handed to execution workflows.
 */

const NOW = new Date('2026-10-06T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

function opp(o: Partial<HandoffSource> = {}): HandoffSource {
  return {
    id: 'opp1',
    type: 'TRENDING_TOPIC',
    status: 'DETECTED',
    title: 'Specialty coffee prices climb',
    summary: 'Two stories this week on rising specialty coffee prices.',
    rationale: 'Two independent stories in 14 days on a topic you follow.',
    angle: 'Explain what the harvest means for your subscribers.',
    details: {},
    source: 'TRENDS',
    detectedBy: 'rule:trending-topic',
    priority: 'HIGH',
    priorityScore: 70,
    confidence: 'MEDIUM',
    confidenceReason: '2 medium-reliability signals',
    impact: 'medium',
    effort: 'low',
    detectedAt: days(-1),
    lastSeenAt: days(-1),
    relevantUntil: days(10),
    contextRevision: 'rev',
    contextFingerprint: 'fp',
    contextFields: ['identity.description'],
    signals: [
      {
        id: 'os1',
        kind: 'TREND_ITEM',
        refId: 'd:i',
        label: 'The Drum',
        detail: 'Specialty coffee prices climb',
        url: 'https://news.example/1',
        observedAt: days(-2),
        signalId: 'sig1',
        signal: {
          source: 'TRENDS',
          reliability: 'MEDIUM',
          expiresAt: days(12),
        },
      },
    ],
    ...o,
  };
}
const handoff = (o: Partial<HandoffSource> = {}) =>
  buildHandoff(opp(o), { now: NOW, shakyFields: [], currentRevision: 'rev' });
const business = { channels: ['Instagram'], audience: 'Home brewers' };

describe('what a recommendation must contain', () => {
  const valid = {
    type: 'CONTENT',
    title: 'Post on rising coffee prices',
    summary: 'Prices are rising.',
    action: 'Publish a post on Instagram about it.',
    rationale: 'It is current for your buyers.',
    expectedOutcome: 'Engagement from home brewers.',
  };

  it('requires what, why, action and expected outcome', () => {
    expect(recommendationContentSchema.safeParse(valid).success).toBe(true);
    for (const missing of ['title', 'action', 'rationale', 'expectedOutcome']) {
      const { [missing]: _gone, ...rest } = valid as Record<string, string>;
      expect(recommendationContentSchema.safeParse(rest).success).toBe(false);
    }
  });

  it('only accepts Aura’s own channels and content formats', () => {
    expect(
      recommendationContentSchema.safeParse({ ...valid, channel: 'Instagram' })
        .success,
    ).toBe(true);
    expect(
      recommendationContentSchema.safeParse({ ...valid, channel: 'MySpace' })
        .success,
    ).toBe(false);
    expect(
      recommendationContentSchema.safeParse({
        ...valid,
        contentType: 'PODCAST',
      }).success,
    ).toBe(false);
  });

  it('has channel and audience optional, where they do not apply', () => {
    const r = recommendationContentSchema.parse(valid);
    expect(r.channel).toBeNull();
    expect(r.audience).toBeNull();
    expect(r.steps).toEqual([]);
  });
});

describe('confidence and relevance are bounded by the opportunity', () => {
  it('may lower confidence, never raise it', () => {
    const h = handoff();
    expect(boundByOpportunity({ confidence: 'HIGH' }, h).confidence).toBe(
      'MEDIUM',
    );
    const lowered = boundByOpportunity(
      { confidence: 'LOW', confidenceReason: 'untested channel' },
      h,
    );
    expect(lowered).toMatchObject({
      confidence: 'LOW',
      confidenceReason: 'untested channel',
    });
    expect(boundByOpportunity({}, h).confidenceReason).toBe(
      '2 medium-reliability signals',
    );
  });

  it('may shorten the relevance window, never extend it', () => {
    const h = handoff();
    expect(boundByOpportunity({}, h).relevantUntil).toEqual(days(10));
    expect(
      boundByOpportunity({ relevantUntil: days(3) }, h).relevantUntil,
    ).toEqual(days(3));
    expect(
      boundByOpportunity({ relevantUntil: days(40) }, h).relevantUntil,
    ).toEqual(days(10));
  });
});

describe('the default draft from an opportunity', () => {
  it('produces a complete, valid recommendation for every opportunity type', () => {
    for (const type of OPPORTUNITY_TYPES) {
      const d = draftFromOpportunity(handoff({ type }), business);
      expect(recommendationContentSchema.safeParse(d).success).toBe(true);
      expect(d.type).toBe(TYPE_FOR_OPPORTUNITY[type]);
      expect(d.action.length).toBeGreaterThan(10);
      expect(d.expectedOutcome.length).toBeGreaterThan(10);
      expect(d.rationale).toBe(
        'Two independent stories in 14 days on a topic you follow.',
      );
    }
  });

  it('a trend becomes a content recommendation on the business’s channel, for its audience', () => {
    const d = draftFromOpportunity(handoff(), business);
    expect(d).toMatchObject({
      type: 'CONTENT',
      channel: 'Instagram',
      contentType: 'IMAGE_POST',
      audience: 'Home brewers',
      outcomeMetric: 'engagement',
    });
    expect(d.steps).toEqual([
      'Take this angle: Explain what the harvest means for your subscribers.',
    ]);
    expect(d.action).toContain('on Instagram');
  });

  it('uses the opportunity’s own channels and content ideas first', () => {
    const d = draftFromOpportunity(
      handoff({
        details: {
          channels: ['LinkedIn'],
          contentIdeas: ['A short opinion post', 'A carousel'],
          timing: 'This week',
        },
      }),
      business,
    );
    expect(d.channel).toBe('LinkedIn');
    expect(d.contentType).toBe('LINKEDIN_POST');
    expect(d.steps).toEqual(['A short opinion post', 'A carousel']);
    expect(d.details).toMatchObject({ timing: 'This week' });
  });

  it('a channel opportunity recommends connecting that channel, with no audience', () => {
    const d = draftFromOpportunity(
      handoff({ type: 'CHANNEL', details: { channel: 'YouTube' } }),
      business,
    );
    expect(d).toMatchObject({
      type: 'CHANNEL',
      channel: 'YouTube',
      contentType: null,
      audience: null,
    });
    expect(d.action).toContain('Connect YouTube');
  });

  it('leaves channel and audience empty when nothing is known', () => {
    const d = draftFromOpportunity(handoff({ type: 'PERFORMANCE_PATTERN' }), {
      channels: [],
      audience: null,
    });
    expect(d.channel).toBeNull();
    expect(d.audience).toBeNull();
  });
});

describe('status lifecycle', () => {
  it('follows proposed → accepted → in progress → completed', () => {
    expect(canTransitionRecommendation('PROPOSED', 'ACCEPTED')).toBe(true);
    expect(canTransitionRecommendation('ACCEPTED', 'IN_PROGRESS')).toBe(true);
    expect(canTransitionRecommendation('IN_PROGRESS', 'COMPLETED')).toBe(true);
    expect(canTransitionRecommendation('ACCEPTED', 'COMPLETED')).toBe(true);
    expect(canTransitionRecommendation('PROPOSED', 'COMPLETED')).toBe(false);
    expect(canTransitionRecommendation('PROPOSED', 'IN_PROGRESS')).toBe(false);
  });

  it('completed, rejected, withdrawn and expired are final', () => {
    for (const s of [
      'COMPLETED',
      'REJECTED',
      'WITHDRAWN',
      'EXPIRED',
    ] as const) {
      expect(RECOMMENDATION_TRANSITIONS[s]).toEqual([]);
    }
    expect(LIVE_RECOMMENDATION_STATUSES).toEqual([
      'PROPOSED',
      'ACCEPTED',
      'IN_PROGRESS',
    ]);
  });

  it('only one waiting for a decision expires', () => {
    expect(
      isRecommendationPastRelevance(
        { status: 'PROPOSED', relevantUntil: days(-1) },
        NOW,
      ),
    ).toBe(true);
    for (const status of ['ACCEPTED', 'IN_PROGRESS'] as const) {
      expect(
        isRecommendationPastRelevance({ status, relevantUntil: days(-1) }, NOW),
      ).toBe(false);
    }
    expect(
      isRecommendationPastRelevance(
        { status: 'PROPOSED', relevantUntil: null },
        NOW,
      ),
    ).toBe(false);
  });

  it('every status is mapped for opportunity sync, onto moves the opportunity allows', () => {
    expect(Object.keys(RECOMMENDATION_TO_OPPORTUNITY).sort()).toEqual(
      [...RECOMMENDATION_STATUSES].sort(),
    );
    for (const to of Object.values(RECOMMENDATION_TO_OPPORTUNITY)) {
      if (to && to !== 'RECOMMENDED') {
        expect(canTransition('RECOMMENDED', to)).toBe(true);
      }
    }
    for (const [from, to] of Object.entries(OPPORTUNITY_TO_RECOMMENDATION)) {
      expect(OPPORTUNITY_STATUSES).toContain(from);
      expect(canTransitionRecommendation('PROPOSED', to!)).toBe(true);
    }
  });
});

describe('handing over to execution workflows', () => {
  const rec = (type: Parameters<typeof executionBrief>[0]['type']) => ({
    id: 'rec1',
    opportunityId: 'opp1',
    type,
    title: 'Post on rising coffee prices',
    action: 'Publish a post on Instagram about it.',
    steps: ['Open with the harvest numbers'],
    rationale: 'Two stories this week.',
    expectedOutcome: 'Engagement from home brewers.',
    channel: 'Instagram',
    contentType: 'IMAGE_POST',
    audience: 'Home brewers',
    details: { angle: 'Explain the harvest' },
    relevantUntil: days(10),
    evidence: [
      {
        label: 'The Drum',
        detail: 'Prices climb',
        url: 'https://news.example/1',
      },
    ],
  });

  it('sends content to Content Studio with the brief pre-filled', () => {
    const b = executionBrief(rec('CONTENT'));
    expect(b.workflow).toBe('CONTENT');
    expect(b.href.startsWith('/dashboard/content/new?brief=')).toBe(true);
    const brief = decodeURIComponent(b.href.split('brief=')[1]!);
    expect(brief).toContain('Publish a post on Instagram about it.');
    expect(brief).toContain('- Open with the harvest numbers');
    expect(brief).toContain('Angle: Explain the harvest');
    expect(brief).toContain('For: Home brewers');
    expect(b).toMatchObject({
      recommendationId: 'rec1',
      opportunityId: 'opp1',
      channel: 'Instagram',
      contentType: 'IMAGE_POST',
      audience: 'Home brewers',
      dueBy: days(10).toISOString(),
    });
    expect(b.evidence).toEqual([
      {
        label: 'The Drum',
        detail: 'Prices climb',
        url: 'https://news.example/1',
      },
    ]);
  });

  it('routes every type to a workflow', () => {
    const expected: Record<string, string> = {
      CONTENT: 'CONTENT',
      CAMPAIGN: 'PLANNER',
      COMPETITIVE_RESPONSE: 'CONTENT',
      AUDIENCE: 'CONTENT',
      CHANNEL: 'CONNECTORS',
      OPTIMIZATION: 'PLANNER',
      OTHER: 'PLANNER',
    };
    for (const [type, workflow] of Object.entries(expected)) {
      expect(executionBrief(rec(type as never)).workflow).toBe(workflow);
    }
  });
});

describe('type mapping', () => {
  it('maps every opportunity type', () => {
    expect(Object.keys(TYPE_FOR_OPPORTUNITY).sort()).toEqual(
      [...OPPORTUNITY_TYPES].sort() as OpportunityType[],
    );
  });
});
