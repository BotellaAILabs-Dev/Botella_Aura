import { describe, it, expect } from 'vitest';

import {
  HANDOFF_VERSION,
  OPPORTUNITY_TO_RECOMMENDATION,
  RECOMMENDATION_TO_OPPORTUNITY,
  buildHandoff,
  handoffEligibility,
  opportunityHandoffSchema,
  recommendationSeed,
  type HandoffSource,
} from '@/lib/recommendation-handoff';
import { canTransition } from '@/lib/opportunities';

/**
 * Opportunity → Recommendation hand-off: what is passed, when it may be
 * passed, what evidence carries forward, and how the two stay in step.
 */

const NOW = new Date('2026-10-05T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

function opp(o: Partial<HandoffSource> = {}): HandoffSource {
  return {
    id: 'opp1',
    type: 'CONTENT_GAP',
    status: 'DETECTED',
    title: 'Own the brewing-guide conversation',
    summary: 'Acme publishes brewing guides; you have not covered brewing.',
    rationale: 'Two Acme changes push brewing education.',
    angle: 'Guides from the roaster’s side.',
    details: {
      ai: {
        model: 'claude-x',
        promptVersion: 'ai-detect-v1',
        evidence: [{ signalId: 'sig1', supports: 'Acme launched guides.' }],
      },
    },
    source: 'AI_DETECTION',
    detectedBy: 'ai:claude-x',
    priority: 'MEDIUM',
    priorityScore: 55,
    confidence: 'MEDIUM',
    confidenceReason: '2 pieces of evidence',
    impact: 'medium',
    effort: 'low',
    detectedAt: days(-2),
    lastSeenAt: days(-1),
    relevantUntil: days(20),
    contextRevision: 'rev-1',
    contextFingerprint: 'fp-1',
    contextFields: ['identity.description', 'audience.stated'],
    signals: [
      {
        id: 'os1',
        kind: 'COMPETITOR_SNAPSHOT',
        refId: 'snap1',
        label: 'Acme Coffee',
        detail: 'Launched a brewing-guide series',
        url: 'https://acme.example/guides',
        observedAt: days(-3),
        signalId: 'sig1',
        signal: {
          source: 'COMPETITORS',
          reliability: 'HIGH',
          expiresAt: days(25),
        },
      },
      {
        id: 'os2',
        kind: 'TREND_ITEM',
        refId: 'd1:i1',
        label: 'The Drum',
        detail: 'Brewing at home is up',
        url: null,
        observedAt: days(-5),
        signalId: 'sig2',
        signal: {
          source: 'TRENDS',
          reliability: 'MEDIUM',
          expiresAt: days(-1),
        },
      },
      {
        id: 'os3',
        kind: 'EXTERNAL',
        refId: null,
        label: 'Advisor note',
        detail: 'Older evidence with no signal link',
        url: null,
        observedAt: null,
        signalId: null,
        signal: null,
      },
    ],
    ...o,
  };
}

const build = (
  o = opp(),
  extra: Partial<Parameters<typeof buildHandoff>[1]> = {},
) =>
  buildHandoff(o, {
    now: NOW,
    shakyFields: ['audience.stated'],
    currentRevision: 'rev-2',
    ...extra,
  });

describe('what is passed', () => {
  it('is a versioned hand-off that matches its schema', () => {
    const h = build();
    expect(h.version).toBe(HANDOFF_VERSION);
    expect(opportunityHandoffSchema.safeParse(h).success).toBe(true);
    // And survives a round-trip through JSON, as it is stored.
    expect(
      opportunityHandoffSchema.safeParse(JSON.parse(JSON.stringify(h))).success,
    ).toBe(true);
  });

  it('carries the opportunity, its assessment and how it was detected', () => {
    const h = build();
    expect(h.opportunity).toMatchObject({
      id: 'opp1',
      type: 'CONTENT_GAP',
      title: 'Own the brewing-guide conversation',
      angle: 'Guides from the roaster’s side.',
    });
    expect(h.assessment).toEqual({
      confidence: 'MEDIUM',
      confidenceReason: '2 pieces of evidence',
      priority: 'MEDIUM',
      priorityScore: 55,
      impact: 'medium',
      effort: 'low',
    });
    expect(h.provenance).toEqual({
      source: 'AI_DETECTION',
      detectedBy: 'ai:claude-x',
      rule: null,
      ai: { model: 'claude-x', promptVersion: 'ai-detect-v1' },
    });
    expect(
      build(opp({ detectedBy: 'rule:competitor-move' })).provenance.rule,
    ).toBe('competitor-move');
  });

  it('leaves impact and effort null when they were never recorded', () => {
    const h = build(opp({ impact: null, effort: 'bogus' }));
    expect(h.assessment.impact).toBeNull();
    expect(h.assessment.effort).toBeNull();
  });
});

describe('required context', () => {
  it('names the snapshot view, the fields relied on, and which are now shaky', () => {
    const h = build();
    expect(h.context).toEqual({
      snapshotView: 'recommendation',
      revision: 'rev-1',
      fingerprint: 'fp-1',
      fields: ['identity.description', 'audience.stated'],
      shakyFields: ['audience.stated'],
      changedSinceDetection: true,
    });
    expect(
      build(opp(), { currentRevision: 'rev-1' }).context.changedSinceDetection,
    ).toBe(false);
    expect(
      build(opp({ contextRevision: null })).context.changedSinceDetection,
    ).toBeNull();
  });
});

describe('evidence that carries forward', () => {
  it('passes every piece, linked to its evidence row and signal, marked current or not', () => {
    const h = build();
    expect(
      h.evidence.map((e) => [e.opportunitySignalId, e.signalId, e.current]),
    ).toEqual([
      ['os1', 'sig1', true],
      ['os2', 'sig2', false], // its signal has expired
      ['os3', null, true], // no signal to expire
    ]);
    expect(h.evidence[0]).toMatchObject({
      source: 'COMPETITORS',
      reliability: 'HIGH',
      url: 'https://acme.example/guides',
      supports: 'Acme launched guides.',
    });
  });

  it('marks evidence whose signal was pruned as not current', () => {
    const o = opp();
    o.signals[0] = { ...o.signals[0]!, signal: null };
    expect(build(o).evidence[0]!.current).toBe(false);
  });

  it('seeds a recommendation that references the opportunity and copies its evidence', () => {
    const seed = recommendationSeed(build(), { title: '  ' });
    expect(seed.opportunityId).toBe('opp1');
    expect(seed.title).toBe('Own the brewing-guide conversation');
    expect(seed).toMatchObject({
      confidence: 'MEDIUM',
      priority: 'MEDIUM',
      priorityScore: 55,
      handoffVersion: HANDOFF_VERSION,
      contextFingerprint: 'fp-1',
    });
    expect(seed.evidence).toHaveLength(3);
    expect(seed.evidence[0]).toMatchObject({
      opportunitySignalId: 'os1',
      signalId: 'sig1',
      kind: 'COMPETITOR_SNAPSHOT',
      reliability: 'HIGH',
    });
    expect(seed.evidence[0]!.observedAt).toEqual(days(-3));
    expect(
      recommendationSeed(build(), { title: 'Run a guide series' }).title,
    ).toBe('Run a guide series');
  });
});

describe('eligibility', () => {
  const ev = (current: boolean) => [{ current }];

  it('allows an open, relevant opportunity with current evidence', () => {
    for (const status of ['DETECTED', 'REVIEWED', 'RECOMMENDED'] as const) {
      expect(
        handoffEligibility({ status, relevantUntil: days(3) }, ev(true), NOW),
      ).toEqual({
        eligible: true,
        reasons: [],
      });
    }
  });

  it('refuses decided or expired ones, past their window, or with no current evidence', () => {
    for (const status of ['ACCEPTED', 'REJECTED', 'EXPIRED'] as const) {
      expect(
        handoffEligibility({ status, relevantUntil: null }, ev(true), NOW)
          .eligible,
      ).toBe(false);
    }
    expect(
      handoffEligibility(
        { status: 'DETECTED', relevantUntil: days(-1) },
        ev(true),
        NOW,
      ).reasons,
    ).toEqual(['Its relevance window has passed.']);
    expect(
      handoffEligibility(
        { status: 'DETECTED', relevantUntil: null },
        ev(false),
        NOW,
      ).reasons,
    ).toEqual(['None of its evidence is current any more.']);
    expect(
      handoffEligibility({ status: 'DETECTED', relevantUntil: null }, [], NOW)
        .reasons,
    ).toEqual(['It has no evidence.']);
  });
});

describe('status sync', () => {
  it('maps every recommendation decision to a move the opportunity lifecycle allows', () => {
    // From RECOMMENDED, where an opportunity with an open recommendation is.
    for (const to of Object.values(RECOMMENDATION_TO_OPPORTUNITY)) {
      if (to && to !== 'RECOMMENDED') {
        expect(canTransition('RECOMMENDED', to)).toBe(true);
      }
    }
    expect(RECOMMENDATION_TO_OPPORTUNITY.WITHDRAWN).toBeNull();
  });

  it('mirrors opportunity decisions and expiry onto an open recommendation', () => {
    expect(OPPORTUNITY_TO_RECOMMENDATION).toEqual({
      ACCEPTED: 'ACCEPTED',
      REJECTED: 'REJECTED',
      EXPIRED: 'WITHDRAWN',
    });
  });
});
