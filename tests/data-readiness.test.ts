import { describe, it, expect } from 'vitest';

import {
  askFor,
  assessReadiness,
  mayWriteRecommendations,
  type ReadinessInput,
} from '@/lib/data-readiness';

/**
 * Empty and insufficient-data states: Aura says clearly when it does not have
 * enough to recommend, gives one next step for each gap, and never fills the
 * space with a generic suggestion.
 */

function full(): ReadinessInput {
  return {
    business: {
      description: 'We roast single-origin coffee in small batches.',
      offerings: 'Coffee subscriptions',
      audience: 'Home brewers',
      goals: 'Grow subscriptions',
      channels: ['LinkedIn'],
      connected: ['LinkedIn'],
    },
    sources: { trendKeywords: 3, competitorsTracked: 2 },
    currentSignals: 12,
    opportunities: { active: 3, lowConfidence: 1 },
    results: { analyticsReports: 4, publishedPosts: 10 },
  };
}
const withPatch = (p: {
  business?: Partial<ReadinessInput['business']>;
  sources?: Partial<ReadinessInput['sources']>;
  currentSignals?: number;
  opportunities?: Partial<ReadinessInput['opportunities']>;
  results?: Partial<ReadinessInput['results']>;
}) => {
  const f = full();
  return assessReadiness({
    business: { ...f.business, ...p.business },
    sources: { ...f.sources, ...p.sources },
    currentSignals: p.currentSignals ?? f.currentSignals,
    opportunities: { ...f.opportunities, ...p.opportunities },
    results: { ...f.results, ...p.results },
  });
};
const scenarios = (r: ReturnType<typeof assessReadiness>) =>
  r.items.map((i) => `${i.scenario}:${i.severity}`);

describe('everything Aura needs', () => {
  it('ready: nothing to show, recommendations allowed', () => {
    const r = assessReadiness(full());
    expect(r).toEqual({
      state: 'ready',
      canRecommend: true,
      items: [],
      primary: null,
    });
  });
});

describe('the six scenarios', () => {
  it('insufficient business context: not knowing what the business does blocks everything', () => {
    const r = withPatch({ business: { description: null, offerings: '  ' } });
    expect(r.canRecommend).toBe(false);
    expect(r.primary).toEqual(
      expect.objectContaining({
        scenario: 'business_context',
        severity: 'blocking',
        next: {
          label: 'Describe your business',
          href: askFor('identity.description'),
        },
      }),
    );
  });

  it('missing audience or goals only limit — each links to its own question', () => {
    const r = withPatch({ business: { audience: null, goals: '' } });
    expect(r.state).toBe('limited');
    expect(r.canRecommend).toBe(true);
    expect(r.items.map((i) => i.next?.href)).toEqual([
      askFor('audience.stated'),
      askFor('objectives.goals'),
    ]);
  });

  it('no channels: blocks, and asks where the business publishes — Aura won’t guess', () => {
    const r = withPatch({ business: { channels: [], connected: [] } });
    expect(r.canRecommend).toBe(false);
    expect(r.primary!.scenario).toBe('no_channels');
    expect(r.primary!.message).toMatch(/won’t guess/);
    expect(r.primary!.next!.href).toBe(askFor('channels.preferred'));
    // Not also told to connect a channel it has not even named.
    expect(scenarios(r)).not.toContain('no_connected_channel:limiting');
  });

  it('insufficient signals: nothing watched → set up what to watch; watched but nothing seen → check now', () => {
    const none = withPatch({
      sources: { trendKeywords: 0, competitorsTracked: 0 },
      currentSignals: 0,
    });
    expect(none.primary).toEqual(
      expect.objectContaining({
        scenario: 'insufficient_signals',
        next: {
          label: 'Choose topics to follow',
          href: '/dashboard/settings/trends',
        },
      }),
    );
    const stale = withPatch({ currentSignals: 0 });
    expect(stale.primary!.next).toEqual({
      label: 'Check for new opportunities',
      action: 'detect_opportunities',
    });
    // No signals means "no opportunities" is not reported separately.
    expect(scenarios(stale)).not.toContain('no_opportunities:blocking');
  });

  it('no opportunities detected: honestly empty, with a way to check again', () => {
    const r = withPatch({ opportunities: { active: 0, lowConfidence: 0 } });
    expect(r.canRecommend).toBe(false);
    expect(r.primary).toEqual(
      expect.objectContaining({
        scenario: 'no_opportunities',
        next: {
          label: 'Check for new opportunities',
          action: 'detect_opportunities',
        },
      }),
    );
    expect(r.primary!.message).toMatch(
      /rather say so than suggest something generic/,
    );
  });

  it('only low-confidence opportunities: limited, and said so', () => {
    const r = withPatch({ opportunities: { active: 2, lowConfidence: 2 } });
    expect(r.state).toBe('limited');
    expect(r.items[0]).toEqual(
      expect.objectContaining({
        scenario: 'low_confidence',
        severity: 'limiting',
      }),
    );
    expect(r.items[0]!.message).toMatch(/needs your review/);
  });

  it('no connected channel: limited — suggest, but not publish or measure', () => {
    const r = withPatch({ business: { connected: [] } });
    expect(r.state).toBe('limited');
    expect(r.items[0]!.next!.href).toBe('/dashboard/connectors');
  });

  it('no historical performance data: limited — Aura won’t claim to know what works', () => {
    const r = withPatch({
      results: { analyticsReports: 0, publishedPosts: 0 },
    });
    expect(r.state).toBe('limited');
    expect(r.items[0]).toEqual(
      expect.objectContaining({ scenario: 'no_performance_data' }),
    );
    expect(r.items[0]!.message).toMatch(/won’t claim to know/);
    // Published posts alone count as some history.
    expect(withPatch({ results: { analyticsReports: 0 } }).state).toBe('ready');
  });
});

describe('the fallback', () => {
  it('a brand-new workspace: blocking gaps first, in the order to fix them, each with a next step', () => {
    const r = assessReadiness({
      business: {
        description: null,
        offerings: null,
        audience: null,
        goals: null,
        channels: [],
        connected: [],
      },
      sources: { trendKeywords: 0, competitorsTracked: 0 },
      currentSignals: 0,
      opportunities: { active: 0, lowConfidence: 0 },
      results: { analyticsReports: 0, publishedPosts: 0 },
    });
    expect(r.state).toBe('blocked');
    expect(scenarios(r)).toEqual([
      'business_context:blocking',
      'no_channels:blocking',
      'insufficient_signals:blocking',
      'no_performance_data:limiting',
    ]);
    expect(r.primary!.scenario).toBe('business_context');
    for (const i of r.items) expect(i.next).not.toBeNull();
  });

  it('missing business information links into the Business Context questions', () => {
    expect(askFor('channels.preferred')).toBe(
      '/dashboard/business?ask=channels.preferred#aura-questions',
    );
  });

  it('every message is specific — no item says the same thing twice', () => {
    const r = withPatch({
      business: { audience: null, goals: null, connected: [] },
      opportunities: { active: 1, lowConfidence: 1 },
      results: { analyticsReports: 0, publishedPosts: 0 },
    });
    const messages = r.items.map((i) => i.message);
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe('no generic recommendation when data is insufficient', () => {
  it('nothing is written without knowing the business or where it publishes', () => {
    expect(mayWriteRecommendations(full().business)).toEqual({
      ok: true,
      reason: null,
    });
    expect(
      mayWriteRecommendations({
        ...full().business,
        description: null,
        offerings: null,
      }),
    ).toEqual({
      ok: false,
      reason: 'Aura does not know what the business does yet.',
    });
    expect(
      mayWriteRecommendations({ ...full().business, channels: [] }),
    ).toEqual({
      ok: false,
      reason: 'The business has not said where it publishes.',
    });
  });
});
