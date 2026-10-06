import { describe, it, expect } from 'vitest';

import {
  BANDS,
  RANKING_WEIGHTS as W,
  bandFor,
  compareRanked,
  rankRecommendations,
  scoreRecommendation,
  type PastDecision,
  type RankableRecommendation,
  type RankingContext,
} from '@/lib/recommendation-ranking';

/**
 * Recommendation prioritisation: each factor, the bands, explanations,
 * tie-breaking, consistency, and how past decisions resurface or sink
 * recommendations.
 */

const NOW = new Date('2026-10-06T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
let n = 0;
function rec(o: Partial<RankableRecommendation> = {}): RankableRecommendation {
  n += 1;
  return {
    id: `rec${String(n).padStart(3, '0')}`,
    title: `Recommendation ${n}`,
    type: 'CONTENT',
    status: 'PROPOSED',
    actionId: 'post',
    channel: 'LinkedIn',
    priority: 'MEDIUM',
    priorityScore: 60,
    confidence: 'MEDIUM',
    executable: true,
    blockers: [],
    relevantUntil: days(20),
    createdAt: days(-1),
    currentEvidence: 1,
    snoozedUntil: null,
    snoozeCount: 0,
    text: 'A topic about beans',
    ...o,
  };
}
const CTX: RankingContext = {
  goals: 'Grow coffee subscriptions',
  campaignThemes: ['freshness'],
  publishesOn: ['LinkedIn', 'Instagram', 'YouTube'],
  connected: ['LinkedIn'],
};
const pts = (r: RankableRecommendation, history: PastDecision[] = []) =>
  Object.fromEntries(
    scoreRecommendation(r, CTX, history, NOW).factors.map((f) => [
      f.factor + ':' + f.why,
      f.points,
    ]),
  );
const factor = (
  r: RankableRecommendation,
  name: string,
  history: PastDecision[] = [],
) =>
  scoreRecommendation(r, CTX, history, NOW)
    .factors.filter((f) => f.factor === name)
    .reduce((s, f) => s + f.points, 0);

describe('priority factors', () => {
  it('the recommendation’s own priority is the base', () => {
    expect(factor(rec({ priorityScore: 100 }), 'priority')).toBe(
      W.basePriority,
    );
    expect(factor(rec({ priorityScore: 50 }), 'priority')).toBe(25);
  });

  it('confidence raises or lowers it', () => {
    expect(factor(rec({ confidence: 'HIGH' }), 'confidence')).toBe(10);
    expect(factor(rec({ confidence: 'LOW' }), 'confidence')).toBe(-10);
  });

  it('fitting the business’s goal or campaign raises it', () => {
    expect(
      factor(rec({ text: 'Win more subscriptions this month' }), 'goals'),
    ).toBe(W.goalMatch);
    expect(factor(rec({ text: 'A freshness guarantee' }), 'goals')).toBe(
      W.goalMatch,
    );
    expect(factor(rec({ text: 'Unrelated topic' }), 'goals')).toBe(0);
  });

  it('timing: closing soon raises it; waiting long for a decision lowers it', () => {
    expect(factor(rec({ relevantUntil: days(2) }), 'timing')).toBe(
      W.closingWithin3Days,
    );
    expect(factor(rec({ relevantUntil: days(6) }), 'timing')).toBe(
      W.closingWithin7Days,
    );
    expect(factor(rec({ relevantUntil: days(20) }), 'timing')).toBe(0);
    expect(factor(rec({ createdAt: days(-20) }), 'timing')).toBe(
      W.waitingPenalty,
    );
    expect(
      factor(rec({ createdAt: days(-20), status: 'ACCEPTED' }), 'timing'),
    ).toBe(0);
  });

  it('available channels: connected first, blocked last', () => {
    expect(factor(rec({ channel: 'LinkedIn' }), 'channel')).toBe(
      W.channel.publishable,
    );
    expect(factor(rec({ channel: 'Instagram' }), 'channel')).toBe(
      W.channel['connect-to-publish'],
    );
    expect(factor(rec({ channel: 'YouTube' }), 'channel')).toBe(0);
    expect(
      factor(
        rec({
          executable: false,
          blockers: ['X is not a channel the business uses.'],
        }),
        'channel',
      ),
    ).toBe(W.blocked);
  });

  it('evidence: none current sinks it; corroboration lifts it', () => {
    expect(factor(rec({ currentEvidence: 0 }), 'evidence')).toBe(
      W.noCurrentEvidence,
    );
    expect(factor(rec({ currentEvidence: 3 }), 'evidence')).toBe(
      W.corroborated,
    );
  });

  it('accepted and waiting to start comes before a fresh proposal, other things equal', () => {
    expect(factor(rec({ status: 'ACCEPTED' }), 'status')).toBe(W.accepted);
  });
});

describe('previous decisions', () => {
  const past = (o: Partial<PastDecision>): PastDecision => ({
    title: 'Something else entirely',
    actionId: 'post',
    channel: 'LinkedIn',
    status: 'REJECTED',
    decidedAt: days(-5),
    ...o,
  });

  it('similar ones the business acted on lift it (up to 2)', () => {
    const acted = [
      past({ status: 'COMPLETED' }),
      past({ status: 'ACCEPTED' }),
      past({ status: 'IN_PROGRESS' }),
    ];
    expect(factor(rec(), 'history', acted)).toBe(W.similarAccepted * 2);
  });

  it('similar ones it turned down sink it (up to 3), by action and channel or by title', () => {
    expect(factor(rec(), 'history', [past({})])).toBe(W.similarRejected);
    expect(
      factor(rec(), 'history', [past({}), past({}), past({}), past({})]),
    ).toBe(W.similarRejected * 3);
    const byTitle = past({
      actionId: 'series',
      channel: 'X',
      title: 'Post about: Coffee prices climb',
    });
    expect(
      factor(rec({ title: 'Coffee prices are climbing' }), 'history', [
        byTitle,
      ]),
    ).toBe(W.similarRejected);
    expect(factor(rec({ channel: 'Instagram' }), 'history', [past({})])).toBe(
      0,
    );
  });

  it('only the last 90 days count, and never its own decision', () => {
    expect(factor(rec(), 'history', [past({ decidedAt: days(-120) })])).toBe(0);
    const r = rec({ status: 'ACCEPTED' });
    expect(factor(r, 'history', [past({ id: r.id, status: 'ACCEPTED' })])).toBe(
      0,
    );
  });

  it('a deferred one is hidden until its date, then resurfaced and says so', () => {
    const hidden = rec({ snoozedUntil: days(3), snoozeCount: 1 });
    expect(bandFor(hidden, 90, NOW)).toEqual({
      band: 'hidden',
      heldBack: 'deferred until 2026-10-09',
    });
    expect(rankRecommendations([hidden], CTX, [], NOW)).toEqual([]);
    expect(
      rankRecommendations([hidden], CTX, [], NOW, { includeHidden: true })[0]!
        .band,
    ).toBe('hidden');
    const back = rankRecommendations(
      [rec({ snoozedUntil: days(-1), snoozeCount: 1 })],
      CTX,
      [],
      NOW,
    )[0]!;
    expect(back.resurfaced).toBe(true);
    expect(back.explanation).toMatch(/Back after you deferred it/);
  });

  it('deferring again and again lowers it', () => {
    expect(factor(rec({ snoozeCount: 1 }), 'history')).toBe(0);
    expect(factor(rec({ snoozeCount: 3 }), 'history')).toBe(
      W.deferredAgain * 2,
    );
  });
});

describe('bands: high priority needs supporting evidence', () => {
  it('a high score with current evidence, medium+ confidence and nothing blocking is “now”', () => {
    expect(bandFor(rec(), BANDS.now, NOW)).toEqual({
      band: 'now',
      heldBack: null,
    });
  });

  it('a high score is held back without current evidence, with low confidence, or when blocked', () => {
    expect(bandFor(rec({ currentEvidence: 0 }), 95, NOW)).toEqual({
      band: 'next',
      heldBack: 'its evidence is no longer current',
    });
    expect(bandFor(rec({ confidence: 'LOW' }), 95, NOW).heldBack).toBe(
      'its confidence is low',
    );
    expect(bandFor(rec({ executable: false }), 95, NOW).heldBack).toBe(
      'it cannot be acted on yet',
    );
  });

  it('lower scores are next or later', () => {
    expect(bandFor(rec(), BANDS.next, NOW).band).toBe('next');
    expect(bandFor(rec(), BANDS.next - 1, NOW).band).toBe('later');
  });

  it('every “now” recommendation has current evidence', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      rec({
        priorityScore: 100,
        confidence: 'HIGH',
        currentEvidence: i % 3,
        relevantUntil: days(2),
      }),
    );
    const now = rankRecommendations(many, CTX, [], NOW).filter(
      (r) => r.band === 'now',
    );
    expect(now.length).toBeGreaterThan(0);
    expect(
      now.every((r) => many.find((m) => m.id === r.id)!.currentEvidence > 0),
    ).toBe(true);
  });
});

describe('explaining priority', () => {
  it('the score is the sum of its factors, each with its reason', () => {
    const r = rec({
      priorityScore: 70,
      confidence: 'HIGH',
      relevantUntil: days(5),
      text: 'subscriptions',
    });
    const { score, factors } = scoreRecommendation(r, CTX, [], NOW);
    expect(score).toBe(factors.reduce((s, f) => s + f.points, 0));
    expect(factors.every((f) => f.why.length > 3)).toBe(true);
    expect(pts(r)).toMatchObject({
      'priority:medium priority (70/100)': 35,
      'confidence:high confidence': 10,
      'timing:closes within a week': 8,
      'channel:LinkedIn is connected — Aura can publish and measure it': 8,
    });
  });

  it('the explanation names the band, score and largest factors, and why it was held back', () => {
    const [x] = rankRecommendations(
      [
        rec({
          priorityScore: 100,
          confidence: 'HIGH',
          relevantUntil: days(2),
          currentEvidence: 0,
          // Scores above "now" (50+10+15+8+10−20 = 73) — held back anyway.
          text: 'More subscriptions',
        }),
      ],
      CTX,
      [],
      NOW,
    );
    expect(x!.explanation).toMatch(/^Next \(score \d+\): /);
    expect(x!.explanation).toMatch(/\(\+50\)/);
    expect(x!.explanation).toMatch(
      /Held back from the top because its evidence is no longer current/,
    );
  });

  it('the score stays within 0–100', () => {
    const worst = rec({
      priorityScore: 0,
      confidence: 'LOW',
      executable: false,
      currentEvidence: 0,
      createdAt: days(-30),
      snoozeCount: 5,
    });
    expect(scoreRecommendation(worst, CTX, [], NOW).score).toBe(0);
  });
});

describe('ranking and tie-breaking', () => {
  it('ranks by band, then score', () => {
    const top = rec({
      priorityScore: 100,
      confidence: 'HIGH',
      relevantUntil: days(2),
    });
    const mid = rec({ priorityScore: 60 });
    const low = rec({ priorityScore: 10, confidence: 'LOW' });
    const ranked = rankRecommendations([low, mid, top], CTX, [], NOW);
    expect(ranked.map((r) => r.id)).toEqual([top.id, mid.id, low.id]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('breaks ties: closing sooner, then confidence, then evidence, then waiting longer, then id', () => {
    const base = { score: 50 };
    const a = rec({ relevantUntil: days(5) });
    const b = rec({ relevantUntil: days(9) });
    expect(compareRanked({ r: a, ...base }, { r: b, ...base })).toBeLessThan(0);
    const c = rec({ relevantUntil: null });
    expect(compareRanked({ r: b, ...base }, { r: c, ...base })).toBeLessThan(0);
    const hi = rec({ confidence: 'HIGH', relevantUntil: days(9) });
    expect(compareRanked({ r: hi, ...base }, { r: b, ...base })).toBeLessThan(
      0,
    );
    const more = rec({ currentEvidence: 3, relevantUntil: days(9) });
    expect(compareRanked({ r: more, ...base }, { r: b, ...base })).toBeLessThan(
      0,
    );
    const older = rec({ createdAt: days(-5), relevantUntil: days(9) });
    expect(
      compareRanked({ r: older, ...base }, { r: b, ...base }),
    ).toBeLessThan(0);
    const twinA = rec({
      id: 'aaa',
      relevantUntil: days(9),
      createdAt: days(-1),
    });
    const twinB = rec({
      id: 'bbb',
      relevantUntil: days(9),
      createdAt: days(-1),
    });
    expect(
      compareRanked({ r: twinA, ...base }, { r: twinB, ...base }),
    ).toBeLessThan(0);
  });

  it('is consistent: same inputs, same order, whatever order they arrive in', () => {
    const list = Array.from({ length: 25 }, (_, i) =>
      rec({
        priorityScore: (i * 37) % 100,
        confidence: (['LOW', 'MEDIUM', 'HIGH'] as const)[i % 3],
        relevantUntil: days((i % 7) + 1),
      }),
    );
    const order = rankRecommendations(list, CTX, [], NOW).map((r) => r.id);
    for (let k = 0; k < 5; k++) {
      const shuffled = [...list].sort(() => Math.random() - 0.5);
      expect(
        rankRecommendations(shuffled, CTX, [], NOW).map((r) => r.id),
      ).toEqual(order);
    }
  });

  it('only ranks recommendations waiting for a decision or to be started', () => {
    const ranked = rankRecommendations(
      [
        rec({ status: 'IN_PROGRESS' }),
        rec({ status: 'COMPLETED' }),
        rec({ status: 'REJECTED' }),
        rec({ status: 'ACCEPTED' }),
      ],
      CTX,
      [],
      NOW,
    );
    expect(ranked).toHaveLength(1);
  });
});
