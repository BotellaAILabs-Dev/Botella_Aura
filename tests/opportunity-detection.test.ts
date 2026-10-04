import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import {
  candidateToInput,
  competitorMoveRule,
  confidenceFromReliability,
  detectOpportunities,
  DETECTION_RULES,
  isoWeek,
  mutedRules,
  provenPatternRule,
  resultsShiftRule,
  RULE_MUTING,
  trendingTopicRule,
  unconnectedChannelRule,
  type DetectableSignal,
} from '@/lib/opportunity-detection';
import { derivePriority, opportunityInputSchema } from '@/lib/opportunities';
import { buildBusinessContext } from '@/server/business-context/build';

/**
 * Opportunity detection rules. Each rule is tested on its own; then the
 * engine's shared gates — relevance, evidence, confidence, no repeat of a
 * rejection, muting — and the guarantee that low-confidence signals never
 * become high-priority opportunities.
 */

const NOW = new Date('2026-10-03T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
let n = 0;
function sig(o: Partial<DetectableSignal>): DetectableSignal {
  n += 1;
  return {
    id: `s${n}`,
    source: 'TRENDS',
    kind: 'TREND_ITEM',
    title: `Signal ${n}`,
    summary: `Summary ${n}`,
    url: null,
    refId: `r${n}`,
    observedAt: daysAgo(2),
    expiresAt: daysAgo(-10),
    reliability: 'MEDIUM',
    occurrences: 1,
    contextMatches: [],
    metadata: {},
    dedupeKey: `k${n}`,
    ...o,
  };
}
const story = (o: Partial<DetectableSignal> = {}) =>
  sig({
    source: 'TRENDS',
    kind: 'TREND_ITEM',
    contextMatches: ['keyword:specialty coffee'],
    ...o,
  });
const change = (change: string, o: Partial<DetectableSignal> = {}) =>
  sig({
    source: 'COMPETITORS',
    kind: 'COMPETITOR_SNAPSHOT',
    reliability: 'HIGH',
    contextMatches: ['competitor:Acme'],
    metadata: { competitor: 'Acme', competitorId: 'c-acme', change },
    summary: `Acme ${change} change`,
    ...o,
  });

const ctx = buildBusinessContext(
  {
    company: {
      id: 'c1',
      name: 'Verdant',
      website: null,
      industry: 'Coffee',
      brandVoiceNotes: null,
      brandVoiceProfile: null,
      preferences: {
        business: {
          description: 'We roast single-origin coffee in small batches.',
        },
        marketingProfile: { marketMode: 'B2C', audience: 'Home brewers' },
      },
    },
    campaigns: [
      {
        name: 'Origin series',
        status: 'ACTIVE',
        goal: 'Tell origin stories',
        targetAudience: null,
        themes: ['specialty coffee'],
        endDate: null,
      },
    ],
  },
  NOW,
);

// ---------------------------------------------------------------------------
// Each rule on its own
// ---------------------------------------------------------------------------

describe('rule: competitor move', () => {
  it('fires on a change observed directly on the competitor’s site', () => {
    const [c] = competitorMoveRule.detect([change('pricing')], ctx, NOW);
    expect(c).toMatchObject({
      type: 'COMPETITOR_MOVE',
      impact: 'high',
      title: 'Respond to Acme’s pricing change',
    });
  });

  it('makes several changes by one competitor in a month one opportunity', () => {
    const out = competitorMoveRule.detect(
      [change('pricing'), change('homepage')],
      ctx,
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.signals).toHaveLength(2);
    expect(out[0]?.dedupeKey).toBe('rule:competitor-move:c-acme:2026-10');
  });

  it('ignores news, positioning, low-reliability and old changes', () => {
    expect(
      competitorMoveRule.detect(
        [
          change('news', { reliability: 'MEDIUM' }),
          change('positioning', { reliability: 'MEDIUM' }),
          change('pricing', { observedAt: daysAgo(45) }),
        ],
        ctx,
        NOW,
      ),
    ).toEqual([]);
  });
});

describe('rule: trending topic', () => {
  it('needs two stories on the same business keyword', () => {
    expect(trendingTopicRule.detect([story()], ctx, NOW)).toEqual([]);
    const [c] = trendingTopicRule.detect([story(), story()], ctx, NOW);
    expect(c).toMatchObject({
      type: 'TRENDING_TOPIC',
      title: 'Join the conversation on specialty coffee',
    });
  });

  it('accepts one story seen in several places', () => {
    expect(
      trendingTopicRule.detect([story({ occurrences: 2 })], ctx, NOW),
    ).toHaveLength(1);
  });

  it('never fires on low-reliability stories alone', () => {
    expect(
      trendingTopicRule.detect(
        [story({ reliability: 'LOW' }), story({ reliability: 'LOW' })],
        ctx,
        NOW,
      ),
    ).toEqual([]);
  });

  it('ranks a topic the business is campaigning on higher', () => {
    expect(
      trendingTopicRule.detect([story(), story()], ctx, NOW)[0]?.impact,
    ).toBe('high');
  });

  it('is one opportunity per topic per week', () => {
    expect(
      trendingTopicRule.detect([story(), story()], ctx, NOW)[0]?.dedupeKey,
    ).toBe(`rule:trending-topic:specialty-coffee:${isoWeek(NOW)}`);
    expect(isoWeek(new Date('2026-10-03T00:00:00Z'))).toBe('2026-W40');
  });
});

describe('rule: proven pattern', () => {
  it('fires on a learned pattern with enough results behind it, not on a thin one', () => {
    const good = sig({
      source: 'MEMORY',
      kind: 'MEMORY_INSIGHT',
      reliability: 'MEDIUM',
      summary: 'Carousels beat text posts',
    });
    const thin = sig({
      source: 'MEMORY',
      kind: 'MEMORY_INSIGHT',
      reliability: 'LOW',
    });
    expect(
      provenPatternRule
        .detect([good, thin], ctx, NOW)
        .map((c) => c.signals[0]?.id),
    ).toEqual([good.id]);
  });
});

describe('rule: results shift', () => {
  it('asks why when results drop, and builds on a jump', () => {
    const down = sig({
      source: 'ANALYTICS',
      kind: 'ANALYTICS_REPORT',
      reliability: 'HIGH',
      title: 'Total engagement down 40%',
      metadata: { metric: 'totalEngagement', from: 500, to: 300 },
    });
    const up = sig({
      source: 'ANALYTICS',
      kind: 'ANALYTICS_REPORT',
      reliability: 'HIGH',
      title: 'Replies up 60%',
      metadata: { metric: 'repliesReceived', from: 5, to: 8 },
    });
    const out = resultsShiftRule.detect([down, up], ctx, NOW);
    expect(out.map((c) => [c.title, c.impact])).toEqual([
      ['Find out why: Total engagement down 40%', 'high'],
      ['Build on the jump: Replies up 60%', 'medium'],
    ]);
  });

  it('never fires on a single-period summary', () => {
    const summary = sig({
      source: 'ANALYTICS',
      kind: 'ANALYTICS_REPORT',
      reliability: 'MEDIUM',
      metadata: { metrics: {} },
    });
    expect(resultsShiftRule.detect([summary], ctx, NOW)).toEqual([]);
  });
});

describe('rule: unconnected channel', () => {
  it('suggests connecting a channel the business uses, at low impact', () => {
    const [c] = unconnectedChannelRule.detect(
      [
        sig({
          source: 'BUSINESS_CONTEXT',
          kind: 'BUSINESS_CONTEXT',
          reliability: 'HIGH',
          metadata: { channel: 'Instagram' },
        }),
      ],
      ctx,
      NOW,
    );
    expect(c).toMatchObject({
      type: 'CHANNEL',
      impact: 'low',
      relevantUntil: null,
    });
  });
});

// ---------------------------------------------------------------------------
// The engine's gates
// ---------------------------------------------------------------------------

describe('confidence thresholds', () => {
  it('is HIGH only with corroborated, reliable evidence', () => {
    expect(
      confidenceFromReliability([change('pricing'), story()]).confidence,
    ).toBe('HIGH');
    expect(confidenceFromReliability([change('pricing')]).confidence).toBe(
      'MEDIUM',
    );
    expect(confidenceFromReliability([story(), story()]).confidence).toBe(
      'MEDIUM',
    );
    expect(confidenceFromReliability([story()]).confidence).toBe('LOW');
    expect(
      confidenceFromReliability([
        story({ reliability: 'LOW' }),
        story({ reliability: 'LOW' }),
        story({ reliability: 'LOW' }),
      ]),
    ).toEqual({
      confidence: 'LOW',
      reason: 'only low-reliability signals',
    });
  });

  it('one LOW signal keeps a HIGH-signal group from HIGH', () => {
    expect(
      confidenceFromReliability([
        change('pricing'),
        story({ reliability: 'LOW' }),
      ]).confidence,
    ).toBe('MEDIUM');
  });
});

describe('low-confidence signals never become high-priority opportunities', () => {
  it('caps LOW confidence at MEDIUM priority, whatever the claimed impact', () => {
    const far = new Date(NOW.getTime() + 60 * 86_400_000);
    const soon = new Date(NOW.getTime() + 2 * 86_400_000);
    expect(
      derivePriority({
        impact: 'high',
        effort: 'low',
        confidence: 'LOW',
        relevantUntil: far,
        now: NOW,
      }).priority,
    ).toBe('MEDIUM');
    expect(
      derivePriority({
        impact: 'high',
        effort: 'low',
        confidence: 'LOW',
        relevantUntil: soon,
        now: NOW,
      }).priority,
    ).toBe('MEDIUM');
    expect(
      derivePriority({
        impact: 'high',
        effort: 'low',
        confidence: 'MEDIUM',
        relevantUntil: far,
        now: NOW,
      }).priority,
    ).toBe('HIGH');
  });

  it('end to end: a low-reliability trend on a campaign theme is detected, but not as high priority', () => {
    const lowStory = story({ reliability: 'LOW', occurrences: 2 });
    // occurrences 2 lets the rule consider it, but every signal is LOW…
    expect(detectOpportunities([lowStory], ctx, { now: NOW }).accepted).toEqual(
      [],
    );
    // …and a MEDIUM single story seen twice gives LOW confidence, capped priority.
    const one = story({ occurrences: 2 });
    const [c] = detectOpportunities([one], ctx, { now: NOW }).accepted;
    expect(c?.confidence).toBe('LOW');
    expect(c?.impact).toBe('high'); // on a campaign theme
    expect(
      derivePriority({
        impact: c!.impact,
        effort: c!.effort,
        confidence: c!.confidence,
        relevantUntil: c!.relevantUntil,
        now: NOW,
      }).priority,
    ).not.toMatch(/HIGH|URGENT/);
  });
});

describe('false positives', () => {
  it('drops stories that do not relate to the business', () => {
    const r = detectOpportunities(
      [story({ contextMatches: [] }), story({ contextMatches: [] })],
      ctx,
      { now: NOW },
    );
    expect(r.accepted).toEqual([]);
  });

  it('never uses an expired signal', () => {
    expect(
      detectOpportunities([change('pricing', { expiresAt: daysAgo(1) })], ctx, {
        now: NOW,
      }).accepted,
    ).toEqual([]);
  });

  it('does not propose again what the business rejected', () => {
    const c = change('pricing');
    const r = detectOpportunities([c], ctx, {
      now: NOW,
      rejectedSignalIds: new Set([c.id]),
    });
    expect(r.accepted).toEqual([]);
    expect(r.suppressed[0]).toMatchObject({
      reason: 'already-rejected',
      rule: 'competitor-move',
    });
  });

  it('keeps new evidence even when older evidence was rejected', () => {
    const old = change('pricing');
    const fresh = change('homepage');
    const [c] = detectOpportunities([old, fresh], ctx, {
      now: NOW,
      rejectedSignalIds: new Set([old.id]),
    }).accepted;
    expect(c?.signals.map((s) => s.id)).toEqual([fresh.id]);
  });

  it('mutes a rule whose last three opportunities were rejected', () => {
    const rejected = (d: number) => ({
      rule: 'trending-topic',
      status: 'REJECTED',
      decidedAt: daysAgo(d),
    });
    expect(mutedRules([rejected(1), rejected(5), rejected(9)], NOW)).toEqual(
      new Set(['trending-topic']),
    );
    // One acceptance means the rule is not just noise.
    expect(
      mutedRules(
        [
          rejected(1),
          rejected(5),
          rejected(9),
          { rule: 'trending-topic', status: 'ACCEPTED', decidedAt: daysAgo(3) },
        ],
        NOW,
      ).size,
    ).toBe(0);
    // And muting wears off.
    expect(
      mutedRules([rejected(40), rejected(45), rejected(50)], NOW).size,
    ).toBe(0);
    expect(RULE_MUTING.muteDays).toBe(30);
    const r = detectOpportunities([story(), story()], ctx, {
      now: NOW,
      mutedRules: new Set(['trending-topic']),
    });
    expect(r.suppressed[0]?.reason).toBe('rule-muted');
  });
});

describe('duplicates within a run', () => {
  it('merges the same stories matched by a keyword and the broad industry into one opportunity', () => {
    const both = ['keyword:specialty coffee', 'industry:Coffee'];
    const r = detectOpportunities(
      [story({ contextMatches: both }), story({ contextMatches: both })],
      ctx,
      { now: NOW },
    );
    expect(r.accepted.map((c) => c.title)).toEqual([
      'Join the conversation on specialty coffee',
    ]);
    expect(r.suppressed).toEqual([
      expect.objectContaining({
        reason: 'duplicate',
        title: 'Join the conversation on Coffee',
      }),
    ]);
  });

  it('keeps genuinely different topics apart', () => {
    const a = [
      story({ contextMatches: ['keyword:specialty coffee'] }),
      story({ contextMatches: ['keyword:specialty coffee'] }),
    ];
    const b = [
      story({ contextMatches: ['keyword:cold brew'] }),
      story({ contextMatches: ['keyword:cold brew'] }),
    ];
    expect(
      detectOpportunities([...a, ...b], ctx, { now: NOW }).accepted,
    ).toHaveLength(2);
  });
});

describe('recording', () => {
  it('produces valid opportunity input that keeps its rule, criteria, dedupe key and signal links', () => {
    const [c] = detectOpportunities(
      [change('pricing'), change('homepage')],
      ctx,
      { now: NOW },
    ).accepted;
    const input = candidateToInput(c!);
    expect(opportunityInputSchema.safeParse(input).success).toBe(true);
    expect(input).toMatchObject({
      detectedBy: 'rule:competitor-move',
      source: 'COMPETITORS',
      confidence: 'HIGH',
      dedupeKey: 'rule:competitor-move:c-acme:2026-10',
    });
    expect(input.signals?.every((s) => s.signalId)).toBe(true);
  });

  it('registers every rule with its documented minimum evidence', () => {
    for (const r of DETECTION_RULES)
      expect(r.minimumEvidence.length, r.id).toBeGreaterThan(10);
  });
});
