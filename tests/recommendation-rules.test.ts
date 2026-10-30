import { describe, it, expect } from 'vitest';

import { selectActions, type EngineContext } from '@/lib/recommendation-engine';
import { buildHandoff, type HandoffSource } from '@/lib/recommendation-handoff';
import {
  CONFIDENCE_RULES,
  EXPIRY_RULES,
  FREQUENCY_LIMITS,
  LOW_CONFIDENCE_BLOCKER,
  MIN_EVIDENCE,
  applyGuardrails,
  capRelevance,
  channelSupport,
  evidenceShortfall,
  executability,
  findConflicts,
  findDuplicate,
  frequencyBreach,
  integrationAvailable,
  mutedActions,
  titleSimilarity,
  type RecentRecommendation,
} from '@/lib/recommendation-rules';
import { RECOMMENDATION_TYPES, executionBrief } from '@/lib/recommendations';

/**
 * Recommendation rules and guardrails — each rule on its own.
 */

const NOW = new Date('2026-10-06T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

type Ev = HandoffSource['signals'][number];
const ev = (
  o: Partial<Ev> & {
    source?:
      'TRENDS' | 'COMPETITORS' | 'ANALYTICS' | 'MEMORY' | 'BUSINESS_CONTEXT';
    expired?: boolean;
  } = {},
): Ev => {
  const { source = 'TRENDS', expired = false, ...rest } = o;
  return {
    id: `os-${Math.random()}`,
    kind: 'TREND_ITEM',
    refId: 'r',
    label: 'Story',
    detail: 'Detail',
    url: null,
    observedAt: days(-1),
    signalId: `sig-${Math.random()}`,
    signal: {
      source,
      reliability: 'HIGH',
      expiresAt: expired ? days(-1) : days(10),
    },
    ...rest,
  };
};
function handoff(o: Partial<HandoffSource> = {}) {
  return buildHandoff(
    {
      id: 'opp1',
      type: 'TRENDING_TOPIC',
      status: 'DETECTED',
      title: 'Specialty coffee prices climb',
      summary: 'Rising prices.',
      rationale: 'Two stories.',
      angle: null,
      details: {},
      source: 'TRENDS',
      detectedBy: 'rule:trending-topic',
      priority: 'MEDIUM',
      priorityScore: 55,
      confidence: 'HIGH',
      confidenceReason: 'r',
      impact: 'high',
      effort: 'low',
      detectedAt: days(-1),
      lastSeenAt: days(-1),
      relevantUntil: days(12),
      contextRevision: 'rev',
      contextFingerprint: 'fp',
      contextFields: [],
      signals: [ev()],
      ...o,
    },
    { now: NOW, shakyFields: [], currentRevision: 'rev' },
  );
}
const CTX: EngineContext = {
  publishesOn: ['LinkedIn', 'Instagram', 'YouTube'],
  connected: ['LinkedIn'],
  audience: 'Home brewers',
  assumedAudience: null,
  goals: null,
  campaignThemes: [],
  learnedFormats: [],
};
const recent = (
  o: Partial<RecentRecommendation> = {},
): RecentRecommendation => ({
  id: 'r1',
  opportunityId: 'other-opp',
  title: 'Post about: Specialty coffee prices climb',
  type: 'CONTENT',
  actionId: 'post',
  channel: 'LinkedIn',
  status: 'GENERATED',
  priorityScore: 50,
  createdAt: days(-2),
  decidedAt: null,
  signalIds: [],
  competitor: null,
  ...o,
});

describe('minimum evidence', () => {
  it('is defined for every recommendation type', () => {
    for (const t of RECOMMENDATION_TYPES)
      expect(MIN_EVIDENCE[t].count).toBeGreaterThanOrEqual(1);
  });

  it('a campaign needs two current signals; one post needs one', () => {
    expect(evidenceShortfall('CONTENT', handoff())).toBeNull();
    expect(evidenceShortfall('CAMPAIGN', handoff())).toMatch(
      /two current signals.*has 1/,
    );
    expect(
      evidenceShortfall('CAMPAIGN', handoff({ signals: [ev(), ev()] })),
    ).toBeNull();
  });

  it('only current evidence counts', () => {
    expect(
      evidenceShortfall(
        'CONTENT',
        handoff({ signals: [ev({ expired: true })] }),
      ),
    ).toMatch(/has 0/);
  });

  it('a competitive response needs a competitor signal; an optimisation needs the business’s own results', () => {
    expect(evidenceShortfall('COMPETITIVE_RESPONSE', handoff())).toMatch(
      /tracked competitor/,
    );
    expect(
      evidenceShortfall(
        'COMPETITIVE_RESPONSE',
        handoff({ signals: [ev({ source: 'COMPETITORS' })] }),
      ),
    ).toBeNull();
    expect(evidenceShortfall('OPTIMIZATION', handoff())).toMatch(/own results/);
    expect(
      evidenceShortfall(
        'OPTIMIZATION',
        handoff({ signals: [ev({ source: 'MEMORY' })] }),
      ),
    ).toBeNull();
  });
});

describe('confidence and low-confidence behaviour', () => {
  it('high and medium are executable; low is advisory and flagged', () => {
    expect(CONFIDENCE_RULES.HIGH.executable).toBe(true);
    expect(CONFIDENCE_RULES.MEDIUM.executable).toBe(true);
    expect(CONFIDENCE_RULES.LOW).toMatchObject({ executable: false });
    expect(CONFIDENCE_RULES.LOW.flag).toMatch(/low confidence/);
    expect(
      executability({
        type: 'CONTENT',
        channel: 'LinkedIn',
        confidence: 'LOW',
        ctx: CTX,
      }),
    ).toEqual({ executable: false, blockers: [LOW_CONFIDENCE_BLOCKER] });
    expect(
      executability({
        type: 'CONTENT',
        channel: 'LinkedIn',
        confidence: 'MEDIUM',
        ctx: CTX,
      }).executable,
    ).toBe(true);
  });
});

describe('channels and integrations', () => {
  it('knows which channels Aura can connect', () => {
    expect(integrationAvailable('LinkedIn')).toBe(true);
    expect(integrationAvailable('Instagram')).toBe(true);
    // Blogs publish to a connected website (WordPress, Shopify, Ghost).
    expect(integrationAvailable('Blog')).toBe(true);
    for (const c of ['X', 'YouTube', 'Newsletter'])
      expect(integrationAvailable(c)).toBe(false);
  });

  it('grades each channel for this business', () => {
    expect(channelSupport('LinkedIn', CTX)).toBe('publishable');
    expect(channelSupport('Instagram', CTX)).toBe('connect-to-publish');
    expect(channelSupport('YouTube', CTX)).toBe('draft-only');
    expect(channelSupport('X', CTX)).toBe('unsupported');
  });

  it('a channel the business does not use is not executable', () => {
    expect(
      executability({
        type: 'CONTENT',
        channel: 'X',
        confidence: 'HIGH',
        ctx: CTX,
      }),
    ).toEqual({
      executable: false,
      blockers: ['X is not a channel the business uses.'],
    });
  });

  it('connecting a channel Aura cannot connect is not executable', () => {
    expect(
      executability({
        type: 'CHANNEL',
        channel: 'YouTube',
        confidence: 'HIGH',
        ctx: CTX,
      }).blockers,
    ).toEqual(['Aura cannot connect YouTube yet.']);
    expect(
      executability({
        type: 'CHANNEL',
        channel: 'Instagram',
        confidence: 'HIGH',
        ctx: CTX,
      }).executable,
    ).toBe(true);
  });

  it('the execution brief says so, and leads to review instead of the work', () => {
    const base = {
      id: 'rec',
      opportunityId: 'opp1',
      type: 'CONTENT' as const,
      title: 't',
      action: 'a',
      steps: [],
      rationale: 'r',
      expectedOutcome: 'e',
      channel: 'YouTube',
      contentType: null,
      audience: null,
      details: {},
      relevantUntil: null,
      evidence: [],
    };
    const blocked = executionBrief({
      ...base,
      executable: false,
      blockers: ['x'],
    });
    expect(blocked).toMatchObject({
      executable: false,
      blockers: ['x'],
      publishing: 'manual',
    });
    expect(blocked.href).toBe('/dashboard/opportunities?focus=opp1&rec=rec');
    const ok = executionBrief({ ...base, channel: 'LinkedIn' });
    expect(ok).toMatchObject({ executable: true, publishing: 'aura' });
    expect(ok.href.startsWith('/dashboard/content/new')).toBe(true);
  });
});

describe('frequency limits', () => {
  it('per day, open at once, and per channel per week', () => {
    expect(frequencyBreach({ createdLastDay: 3, open: 4 })).toBeNull();
    expect(
      frequencyBreach({ createdLastDay: FREQUENCY_LIMITS.perDay, open: 0 }),
    ).toMatch(/last 24 hours/);
    expect(
      frequencyBreach({ createdLastDay: 0, open: FREQUENCY_LIMITS.maxOpen }),
    ).toMatch(/waiting for a decision/);
    expect(
      frequencyBreach({
        createdLastDay: 0,
        open: 0,
        channel: 'LinkedIn',
        sameChannelLastWeek: FREQUENCY_LIMITS.perChannelPerWeek,
      }),
    ).toMatch(/for LinkedIn in the last 7 days/);
  });
});

describe('duplicates and repetition', () => {
  const candidate = {
    opportunityId: 'opp1',
    title: 'Post about: Specialty coffee prices are climbing',
    type: 'CONTENT' as const,
    channel: 'LinkedIn',
  };

  it('measures title similarity, ignoring the action prefix', () => {
    expect(
      titleSimilarity(
        'Post about: Coffee prices climb',
        'A short series on: coffee prices climb',
      ),
    ).toBe(1);
    expect(titleSimilarity('Coffee prices climb', 'Cold brew season')).toBe(0);
  });

  it('the same recommendation in play is a duplicate', () => {
    expect(findDuplicate(candidate, [recent()], NOW)?.reason).toMatch(
      /repeats/,
    );
  });

  it('a different channel or type is not', () => {
    expect(
      findDuplicate(candidate, [recent({ channel: 'Instagram' })], NOW),
    ).toBeNull();
    expect(
      findDuplicate(candidate, [recent({ type: 'CAMPAIGN' })], NOW),
    ).toBeNull();
  });

  it('one the business rejected in the last 30 days is not proposed again', () => {
    const rejected = recent({
      status: 'REJECTED',
      createdAt: days(-25),
      decidedAt: days(-20),
    });
    expect(findDuplicate(candidate, [rejected], NOW)?.reason).toMatch(
      /rejected 20 day/,
    );
    const old = recent({
      status: 'REJECTED',
      createdAt: days(-45),
      decidedAt: days(-40),
    });
    expect(findDuplicate(candidate, [old], NOW)).toBeNull();
  });

  it('a finished one older than 14 days is not a duplicate', () => {
    expect(
      findDuplicate(
        candidate,
        [recent({ status: 'COMPLETED', createdAt: days(-20) })],
        NOW,
      ),
    ).toBeNull();
  });

  it('mutes an action rejected 3 times in 30 days; one acceptance lifts it', () => {
    const rej = (id: string, d = -5) =>
      recent({ id, status: 'REJECTED', decidedAt: days(d) });
    expect(mutedActions([rej('a'), rej('b'), rej('c')], NOW)).toEqual(
      new Set(['post:LinkedIn']),
    );
    expect(mutedActions([rej('a'), rej('b')], NOW).size).toBe(0);
    expect(
      mutedActions(
        [
          rej('a'),
          rej('b'),
          rej('c'),
          recent({ id: 'd', status: 'ACCEPTED', decidedAt: days(-1) }),
        ],
        NOW,
      ).size,
    ).toBe(0);
    expect(mutedActions([rej('a'), rej('b'), rej('c', -40)], NOW).size).toBe(0);
  });
});

describe('expiration', () => {
  it('never more than 30 days, never past the opportunity', () => {
    expect(capRelevance(days(60), NOW)).toEqual(
      days(EXPIRY_RULES.maxProposedDays),
    );
    expect(capRelevance(days(5), NOW)).toEqual(days(5));
    expect(capRelevance(null, NOW)).toEqual(days(30));
  });
});

describe('conflicts', () => {
  const cand = {
    opportunityId: 'opp1',
    actionId: 'series',
    signalIds: ['s1'],
    competitor: null,
    priorityScore: 70,
  };

  it('the same evidence with a different action conflicts; the higher priority goes first', () => {
    const c = findConflicts(cand, [
      recent({ signalIds: ['s1'], priorityScore: 50 }),
    ]);
    expect(c).toEqual([
      {
        id: 'r1',
        title: 'Post about: Specialty coffee prices climb',
        why: 'both rest on the same evidence, with different actions',
        precedence: 'this',
      },
    ]);
    expect(
      findConflicts({ ...cand, priorityScore: 10 }, [
        recent({ signalIds: ['s1'] }),
      ])[0]!.precedence,
    ).toBe('other');
  });

  it('two answers to the same competitor conflict', () => {
    const c = findConflicts({ ...cand, competitor: 'Acme', signalIds: [] }, [
      recent({ type: 'COMPETITIVE_RESPONSE', competitor: 'Acme' }),
    ]);
    expect(c[0]!.why).toBe('both answer Acme');
  });

  it('finished ones, and the same action, do not conflict', () => {
    expect(
      findConflicts(cand, [recent({ signalIds: ['s1'], status: 'COMPLETED' })]),
    ).toEqual([]);
    expect(
      findConflicts(cand, [recent({ signalIds: ['s1'], actionId: 'series' })]),
    ).toEqual([]);
  });
});

describe('applying the rules to the engine’s choice', () => {
  it('sets aside a series with too little evidence, keeping the post', () => {
    const h = handoff();
    const s = applyGuardrails(selectActions(h, CTX, [], NOW), {
      h,
      muted: new Set(),
    });
    expect(s.viable.map((a) => a.spec.id)).toEqual(['post']);
    expect(s.unsupported.find((u) => u.id === 'series')!.reasons[0]).toMatch(
      /two current signals/,
    );
  });

  it('sets aside a muted action', () => {
    const h = handoff();
    const s = applyGuardrails(selectActions(h, CTX, [], NOW), {
      h,
      muted: new Set(['post:LinkedIn']),
    });
    expect(s.viable.map((a) => a.spec.id)).not.toContain('post');
    expect(s.unsupported.find((u) => u.id === 'post')!.reasons[0]).toMatch(
      /rejected this 3\+ times/,
    );
  });

  it('never proposes connecting a channel Aura cannot connect', () => {
    const h = handoff({
      type: 'CHANNEL',
      details: { channel: 'YouTube' },
      signals: [ev({ source: 'BUSINESS_CONTEXT' })],
    });
    const s = applyGuardrails(
      selectActions(h, { ...CTX, connected: [] }, [], NOW),
      { h, muted: new Set() },
    );
    expect(s.viable).toEqual([]);
    expect(s.unsupported[0]!.reasons).toContain(
      'Aura cannot connect YouTube yet',
    );
  });
});
