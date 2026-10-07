import { describe, it, expect } from 'vitest';

import {
  WHAT_MATTERS_LIMITS,
  buildWhatMatters,
  isHighRelevance,
  isImportantChange,
  whyChangeMatters,
  type Coverage,
  type MattersOpportunity,
  type MattersSignal,
} from '@/lib/what-matters';

/**
 * What matters now: the current business situation, from opportunities and
 * signals only — every item tied to its record, explained, linked to its
 * recommendation, and nothing invented when data is thin.
 */

const NOW = new Date('2026-10-07T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

const FULL: Coverage = {
  trendKeywords: 3,
  competitorsTracked: 2,
  resultPeriods: 4,
  hasGoals: true,
  lastCollectedAt: daysAgo(0.2),
};
const EMPTY: Coverage = {
  trendKeywords: 0,
  competitorsTracked: 0,
  resultPeriods: 0,
  hasGoals: false,
  lastCollectedAt: null,
};

function opp(o: Partial<MattersOpportunity> = {}): MattersOpportunity {
  return {
    id: 'o1',
    title: 'Respond to Acme Coffee’s pricing change',
    typeLabel: 'Competitor move',
    status: 'RECOMMENDED',
    priority: 'HIGH',
    priorityScore: 75,
    confidence: 'HIGH',
    why: 'Acme Coffee made a change to its pricing, seen directly on its site',
    daysLeft: 10,
    detectedAt: daysAgo(2),
    signalIds: ['sig-acme'],
    recommendation: {
      id: 'r1',
      title: 'Respond to Acme Coffee’s pricing change',
      status: 'PRESENTED',
    },
    ...o,
  };
}
function sig(o: Partial<MattersSignal> = {}): MattersSignal {
  return {
    id: 'sig-drop',
    source: 'ANALYTICS',
    title: 'Total engagement down 40%',
    summary:
      'Total engagement went from 500 to 300 between the last two periods.',
    reliability: 'HIGH',
    occurrences: 1,
    strength: -40,
    observedAt: daysAgo(1),
    expiresAt: inDays(40),
    contextMatches: [],
    metadata: { metric: 'totalEngagement', from: 500, to: 300 },
    recommendation: null,
    opportunityId: null,
    ...o,
  };
}

describe('active, high-relevance opportunities', () => {
  it('high or urgent priority, a high score, or closing within a week', () => {
    expect(isHighRelevance(opp())).toBe(true);
    expect(
      isHighRelevance(opp({ priority: 'URGENT', priorityScore: 10 })),
    ).toBe(true);
    expect(
      isHighRelevance(opp({ priority: 'MEDIUM', priorityScore: 60 })),
    ).toBe(true);
    expect(
      isHighRelevance(opp({ priority: 'LOW', priorityScore: 20, daysLeft: 5 })),
    ).toBe(true);
    expect(
      isHighRelevance(
        opp({ priority: 'LOW', priorityScore: 20, daysLeft: 30 }),
      ),
    ).toBe(false);
  });

  it('each is tied to its opportunity, says why from its own record, and links to its suggestion', () => {
    const w = buildWhatMatters(
      { opportunities: [opp()], signals: [], coverage: FULL },
      NOW,
    );
    expect(w.items).toEqual([
      {
        key: 'opportunity:o1',
        kind: 'opportunity',
        title: 'Respond to Acme Coffee’s pricing change',
        why: 'Acme Coffee made a change to its pricing, seen directly on its site.',
        source: 'Competitor move · spotted 2 days ago',
        confidence: { label: 'Strong evidence', weak: false },
        urgency: 'Closes in 10 days',
        ref: { type: 'opportunity', id: 'o1' },
        href: '/dashboard/opportunities?focus=o1',
        related: {
          label: 'See Aura’s suggestion',
          href: '/dashboard/suggestions',
        },
      },
    ]);
  });

  it('no suggestion yet: offers to ask for one, on the opportunity', () => {
    const [item] = buildWhatMatters(
      {
        opportunities: [opp({ recommendation: null, status: 'DETECTED' })],
        signals: [],
        coverage: FULL,
      },
      NOW,
    ).items;
    expect(item!.related).toEqual({
      label: 'Ask Aura for a suggestion',
      href: '/dashboard/opportunities?focus=o1',
    });
  });

  it('a suggestion already accepted: points to its next step', () => {
    const [item] = buildWhatMatters(
      {
        opportunities: [
          opp({ recommendation: { id: 'r', title: 'x', status: 'EDITED' } }),
        ],
        signals: [],
        coverage: FULL,
      },
      NOW,
    ).items;
    expect(item!.related!.label).toBe('You said yes — see the next step');
  });

  it(`at most ${WHAT_MATTERS_LIMITS.opportunities}, closing soonest first`, () => {
    const w = buildWhatMatters(
      {
        opportunities: [
          opp({ id: 'a', daysLeft: 20, signalIds: [] }),
          opp({ id: 'b', daysLeft: 2, signalIds: [] }),
          opp({ id: 'c', daysLeft: null, signalIds: [] }),
          opp({ id: 'd', daysLeft: 6, signalIds: [] }),
        ],
        signals: [],
        coverage: FULL,
      },
      NOW,
    );
    expect(w.items.map((i) => i.ref.id)).toEqual(['b', 'd', 'a']);
  });
});

describe('important changes', () => {
  it('a results shift, a competitor change and a corroborated trend are changes', () => {
    expect(isImportantChange(sig(), NOW)).toBe(true);
    expect(
      isImportantChange(
        sig({
          source: 'COMPETITORS',
          metadata: { competitor: 'Acme', change: 'pricing' },
        }),
        NOW,
      ),
    ).toBe(true);
    expect(
      isImportantChange(
        sig({ source: 'TRENDS', reliability: 'MEDIUM', metadata: {} }),
        NOW,
      ),
    ).toBe(true);
  });

  it('standing facts, stale or expired signals, and lone weak stories are not news', () => {
    // A competitor's current positioning, with nothing to compare against.
    expect(
      isImportantChange(
        sig({ source: 'COMPETITORS', metadata: { change: 'positioning' } }),
        NOW,
      ),
    ).toBe(false);
    // One results period: nothing moved.
    expect(isImportantChange(sig({ metadata: { metrics: {} } }), NOW)).toBe(
      false,
    );
    expect(isImportantChange(sig({ source: 'BUSINESS_CONTEXT' }), NOW)).toBe(
      false,
    );
    expect(isImportantChange(sig({ source: 'MEMORY' }), NOW)).toBe(false);
    expect(isImportantChange(sig({ observedAt: daysAgo(20) }), NOW)).toBe(
      false,
    );
    expect(isImportantChange(sig({ expiresAt: daysAgo(1) }), NOW)).toBe(false);
    expect(
      isImportantChange(
        sig({
          source: 'TRENDS',
          reliability: 'LOW',
          occurrences: 1,
          metadata: {},
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it('why it matters is built from the signal’s own words — no invented figures', () => {
    expect(whyChangeMatters(sig())).toBe(
      'Total engagement went from 500 to 300 between the last two periods. Worth finding out why before it goes further.',
    );
    expect(
      whyChangeMatters(
        sig({
          source: 'COMPETITORS',
          summary: 'Cut subscriptions by 20%',
          metadata: { competitor: 'Acme Coffee', change: 'pricing' },
        }),
      ),
    ).toBe(
      'Cut subscriptions by 20%. Buyers comparing you with Acme Coffee will see the new prices.',
    );
    expect(
      whyChangeMatters(
        sig({
          source: 'TRENDS',
          contextMatches: ['keyword:specialty coffee'],
          metadata: {},
        }),
      ),
    ).toBe(
      'Your market is talking about this, and it relates to “specialty coffee”, which you follow.',
    );
  });

  it('a change an opportunity already covers is not listed twice', () => {
    const w = buildWhatMatters(
      {
        opportunities: [opp({ signalIds: ['sig-drop'] })],
        signals: [sig()],
        coverage: FULL,
      },
      NOW,
    );
    expect(w.items.map((i) => i.key)).toEqual(['opportunity:o1']);
  });

  it('a change is tied to its signal, and to the opportunity or suggestion that uses it', () => {
    const w = buildWhatMatters(
      {
        opportunities: [],
        signals: [
          sig({
            opportunityId: 'o9',
            recommendation: {
              id: 'r9',
              title: 'Win back',
              status: 'GENERATED',
            },
          }),
        ],
        coverage: FULL,
      },
      NOW,
    );
    expect(w.items[0]).toEqual(
      expect.objectContaining({
        kind: 'change',
        ref: { type: 'signal', id: 'sig-drop' },
        href: '/dashboard/opportunities?focus=o9',
        source: 'Your results · yesterday',
        related: {
          label: 'See Aura’s suggestion',
          href: '/dashboard/suggestions',
        },
      }),
    );
    // On its own: links to where it came from, nothing related.
    const alone = buildWhatMatters(
      { opportunities: [], signals: [sig()], coverage: FULL },
      NOW,
    ).items[0]!;
    expect(alone.href).toBe('/dashboard/analytics');
    expect(alone.related).toBeNull();
  });
});

describe('states — never fabricated', () => {
  it('nothing recorded at all: says so, lists what is missing, shows no items', () => {
    const w = buildWhatMatters(
      { opportunities: [], signals: [], coverage: EMPTY },
      NOW,
    );
    expect(w.state).toBe('insufficient');
    expect(w.items).toEqual([]);
    expect(w.summary).toBe(
      'Aura doesn’t have enough information yet to say what matters for your business.',
    );
    expect(w.gaps.map((g) => g.key)).toEqual([
      'trends',
      'competitors',
      'results',
      'goals',
    ]);
    expect(w.basis).toBeNull();
    for (const g of w.gaps)
      expect(g.action.href.startsWith('/dashboard/')).toBe(true);
  });

  it('enough sources but nothing stands out: quiet, and says what it looked at', () => {
    const w = buildWhatMatters(
      {
        opportunities: [
          opp({ priority: 'LOW', priorityScore: 10, daysLeft: null }),
        ],
        signals: [
          sig({ source: 'BUSINESS_CONTEXT' }),
          sig({ id: 's2', source: 'MEMORY' }),
        ],
        coverage: FULL,
      },
      NOW,
    );
    expect(w.state).toBe('quiet');
    expect(w.items).toEqual([]);
    expect(w.summary).toMatch(/^Nothing stands out right now/);
    expect(w.basis).toBe(
      'Based on 2 current signals from your business and what works for you, last checked today.',
    );
  });

  it('thin data with nothing standing out is "not enough information", not "all quiet"', () => {
    const w = buildWhatMatters(
      {
        opportunities: [],
        signals: [sig({ source: 'BUSINESS_CONTEXT' })],
        coverage: { ...EMPTY, hasGoals: true },
      },
      NOW,
    );
    expect(w.state).toBe('insufficient');
  });

  it('only weak evidence: shown, marked as early, and the summary says to check it', () => {
    const w = buildWhatMatters(
      {
        opportunities: [opp({ confidence: 'LOW' })],
        signals: [],
        coverage: FULL,
      },
      NOW,
    );
    expect(w.state).toBe('limited');
    expect(w.items[0]!.confidence).toEqual({
      label: 'Early sign — limited evidence',
      weak: true,
    });
    expect(w.summary).toMatch(/rests on limited information/);
  });

  it('items with partial data sources: limited, with what would help', () => {
    const w = buildWhatMatters(
      {
        opportunities: [opp()],
        signals: [],
        coverage: { ...EMPTY, hasGoals: false },
      },
      NOW,
    );
    expect(w.state).toBe('limited');
    expect(w.gaps.length).toBeGreaterThanOrEqual(3);
  });

  it('ready: a one-line situation built only from the items', () => {
    const w = buildWhatMatters(
      {
        opportunities: [opp({ daysLeft: 3 })],
        signals: [
          sig(),
          sig({
            id: 'sig-x',
            source: 'COMPETITORS',
            title: 'Bean Co changed its homepage',
            summary: 'New hero message about freshness',
            metadata: { competitor: 'Bean Co', change: 'homepage' },
          }),
        ],
        coverage: FULL,
      },
      NOW,
    );
    expect(w.state).toBe('ready');
    expect(w.summary).toBe(
      '1 opportunity worth acting on (1 closing soon) and 2 changes to know about.',
    );
    expect(w.items).toHaveLength(3);
  });

  it('strong items before weak ones, and never more than the limit', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      sig({ id: `s${i}`, reliability: i % 2 ? 'HIGH' : 'MEDIUM', strength: i }),
    );
    const w = buildWhatMatters(
      {
        opportunities: [opp({ confidence: 'LOW', signalIds: [] })],
        signals: many,
        coverage: FULL,
      },
      NOW,
    );
    expect(w.items).toHaveLength(WHAT_MATTERS_LIMITS.items);
    expect(w.items.at(-1)!.confidence.weak).toBe(true);
  });

  it('every item refers to a record that was given — nothing appears from nowhere', () => {
    const opportunities = [opp(), opp({ id: 'o2', signalIds: [] })];
    const signals = [
      sig(),
      sig({
        id: 'sig-2',
        source: 'TRENDS',
        reliability: 'MEDIUM',
        metadata: {},
      }),
    ];
    const ids = new Set([
      ...opportunities.map((o) => o.id),
      ...signals.map((s) => s.id),
    ]);
    const w = buildWhatMatters({ opportunities, signals, coverage: FULL }, NOW);
    expect(w.items.length).toBeGreaterThan(0);
    for (const i of w.items) {
      expect(ids.has(i.ref.id)).toBe(true);
      const source =
        i.ref.type === 'opportunity'
          ? opportunities.find((o) => o.id === i.ref.id)!.title
          : signals.find((s) => s.id === i.ref.id)!.title;
      expect(i.title).toBe(source);
    }
  });
});
