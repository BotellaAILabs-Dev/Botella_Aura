import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import {
  ACTIVE_STATUSES,
  canTransition,
  dedupeKeyFor,
  defaultRelevantUntil,
  deriveConfidence,
  derivePriority,
  isPastRelevance,
  OPPORTUNITY_STATUSES,
  opportunityInputSchema,
  TRANSITIONS,
} from '@/lib/opportunities';
import {
  advisorOpportunityType,
  advisorToOpportunityInput,
} from '@/server/opportunities/from-advisor';
import { shakyContextFields } from '@/server/opportunities/opportunity.service';
import { buildBusinessContext } from '@/server/business-context/build';
import type { CampaignOpportunity } from '@/server/advisor/types';

/**
 * The opportunity model's rules: lifecycle, evidence, confidence, priority
 * and relevance. The database round trip is proved separately by
 * `pnpm verify:opportunities`.
 */

const NOW = new Date('2026-10-02T12:00:00Z');
const sig = (
  kind: 'TREND_ITEM' | 'COMPETITOR_SNAPSHOT' | 'MEMORY_INSIGHT',
  n: number,
) => ({
  kind,
  refId: `${kind}-${n}`,
  label: 'x',
  detail: `observation ${n}`,
});

describe('lifecycle', () => {
  it('follows Detected → Reviewed → Recommended → Accepted / Rejected / Expired', () => {
    expect(canTransition('DETECTED', 'REVIEWED')).toBe(true);
    expect(canTransition('REVIEWED', 'RECOMMENDED')).toBe(true);
    expect(canTransition('RECOMMENDED', 'ACCEPTED')).toBe(true);
    expect(canTransition('RECOMMENDED', 'REJECTED')).toBe(true);
    expect(canTransition('REVIEWED', 'EXPIRED')).toBe(true);
  });

  it('treats accepted and expired as final, and lets a rejection be reopened', () => {
    expect(TRANSITIONS.ACCEPTED).toEqual([]);
    expect(TRANSITIONS.EXPIRED).toEqual([]);
    expect(canTransition('REJECTED', 'REVIEWED')).toBe(true);
    expect(canTransition('REJECTED', 'ACCEPTED')).toBe(false);
    expect(canTransition('ACCEPTED', 'REJECTED')).toBe(false);
  });

  it('never goes backwards except to reopen a rejection', () => {
    expect(canTransition('RECOMMENDED', 'REVIEWED')).toBe(false);
    expect(canTransition('REVIEWED', 'DETECTED')).toBe(false);
  });

  it('defines every status, and only open ones count as active', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual(
      [...OPPORTUNITY_STATUSES].sort(),
    );
    expect(ACTIVE_STATUSES).toEqual(['DETECTED', 'REVIEWED', 'RECOMMENDED']);
  });

  it('expires only open opportunities past their relevance window', () => {
    const past = new Date(NOW.getTime() - 1000);
    expect(
      isPastRelevance({ status: 'DETECTED', relevantUntil: past }, NOW),
    ).toBe(true);
    expect(
      isPastRelevance({ status: 'ACCEPTED', relevantUntil: past }, NOW),
    ).toBe(false);
    expect(
      isPastRelevance({ status: 'DETECTED', relevantUntil: null }, NOW),
    ).toBe(false);
  });
});

describe('evidence is required', () => {
  const base = {
    type: 'TRENDING_TOPIC' as const,
    title: 'Ride the AI-copilot conversation',
    summary: 'Everyone is talking about it.',
    source: 'ADVISOR' as const,
    detectedBy: 'test',
  };

  it('refuses an opportunity with no evidence', () => {
    const r = opportunityInputSchema.safeParse({ ...base, signals: [] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(
      'at least one piece of evidence',
    );
  });

  it('accepts one with evidence linked to its signal', () => {
    expect(
      opportunityInputSchema.safeParse({
        ...base,
        signals: [sig('TREND_ITEM', 1)],
      }).success,
    ).toBe(true);
  });
});

describe('derivations', () => {
  it('gives the same opportunity the same key however it is written', () => {
    expect(
      dedupeKeyFor('TRENDING_TOPIC', 'Ride the AI-Copilot conversation!'),
    ).toBe(dedupeKeyFor('TRENDING_TOPIC', 'ride the ai copilot  conversation'));
    expect(dedupeKeyFor('CONTENT_GAP', 'x')).not.toBe(
      dedupeKeyFor('TRENDING_TOPIC', 'x'),
    );
  });

  it('sets a relevance window by type', () => {
    expect(
      defaultRelevantUntil('TRENDING_TOPIC', NOW)!.getTime() - NOW.getTime(),
    ).toBe(14 * 86_400_000);
    expect(
      defaultRelevantUntil('AUDIENCE_SEGMENT', NOW)!.getTime() - NOW.getTime(),
    ).toBe(120 * 86_400_000);
  });

  it('derives confidence from how much independent evidence there is', () => {
    expect(
      deriveConfidence({ signals: [sig('TREND_ITEM', 1)] }).confidence,
    ).toBe('LOW');
    expect(
      deriveConfidence({
        signals: [sig('TREND_ITEM', 1), sig('TREND_ITEM', 2)],
      }).confidence,
    ).toBe('MEDIUM');
    expect(
      deriveConfidence({
        signals: [
          sig('TREND_ITEM', 1),
          sig('TREND_ITEM', 2),
          sig('COMPETITOR_SNAPSHOT', 3),
        ],
      }).confidence,
    ).toBe('HIGH');
  });

  it('does not count the same evidence twice', () => {
    expect(
      deriveConfidence({
        signals: [sig('TREND_ITEM', 1), sig('TREND_ITEM', 1)],
      }).confidence,
    ).toBe('LOW');
  });

  it('never exceeds what the detector claimed, or what shaky business information supports', () => {
    const strong = [
      sig('TREND_ITEM', 1),
      sig('TREND_ITEM', 2),
      sig('MEMORY_INSIGHT', 3),
    ];
    expect(
      deriveConfidence({ signals: strong, claimed: 'LOW' }).confidence,
    ).toBe('LOW');
    const capped = deriveConfidence({
      signals: strong,
      shakyContext: ['audience.stated'],
    });
    expect(capped.confidence).toBe('MEDIUM');
    expect(capped.reason).toContain('audience.stated');
  });

  it('ranks by worth and cost, and calls it urgent only when it is both worth doing and closing', () => {
    const far = new Date(NOW.getTime() + 60 * 86_400_000);
    const soon = new Date(NOW.getTime() + 3 * 86_400_000);
    expect(
      derivePriority({
        impact: 'high',
        effort: 'low',
        confidence: 'HIGH',
        relevantUntil: far,
        now: NOW,
      }).priority,
    ).toBe('HIGH');
    expect(
      derivePriority({
        impact: 'low',
        effort: 'high',
        confidence: 'LOW',
        relevantUntil: far,
        now: NOW,
      }).priority,
    ).toBe('LOW');
    expect(
      derivePriority({
        impact: 'high',
        effort: 'low',
        confidence: 'HIGH',
        relevantUntil: soon,
        now: NOW,
      }).priority,
    ).toBe('URGENT');
    expect(
      derivePriority({
        impact: 'low',
        effort: 'high',
        confidence: 'LOW',
        relevantUntil: soon,
        now: NOW,
      }).priority,
    ).not.toBe('URGENT');
  });
});

describe('link to the Business Context', () => {
  it('flags the business information an opportunity rests on that is not confirmed', () => {
    const ctx = buildBusinessContext(
      {
        company: {
          id: 'c1',
          name: 'Verdant',
          website: null,
          industry: null,
          brandVoiceNotes: null,
          brandVoiceProfile: null,
          preferences: {
            business: {
              description: 'We roast single-origin coffee in small batches.',
            },
          },
        },
        plan: {
          inputs: { audience: 'Cafe owners' },
          month: NOW,
          updatedAt: NOW,
        },
      },
      NOW,
    );
    // Description is stated; the audience is borrowed from the plan; market mode is missing.
    expect(
      shakyContextFields(ctx, [
        'identity.description',
        'audience.stated',
        'audience.marketMode',
      ]),
    ).toEqual(['audience.stated', 'audience.marketMode']);
  });
});

describe('advisor opportunities become stored opportunities', () => {
  const opp = (o: Partial<CampaignOpportunity> = {}): CampaignOpportunity => ({
    id: 'opp-1',
    title: 'Answer Acme’s price cut',
    rationale: 'Acme cut prices; buyers are comparing.',
    angle: 'Lead with total cost, not sticker price.',
    channels: ['LinkedIn'],
    contentIdeas: ['a', 'b', 'c'],
    effort: 'low',
    impact: 'high',
    timing: 'This week',
    evidence: [
      {
        kind: 'competitor',
        label: 'Acme',
        detail: 'Pricing change: -20%',
        signal: {
          kind: 'COMPETITOR_SNAPSHOT',
          refId: 'snap_1',
          observedAt: '2026-09-30T00:00:00.000Z',
        },
      },
      {
        kind: 'trend',
        label: 'Hacker News',
        detail: 'Pricing debate',
        url: 'https://news.ycombinator.com/x',
      },
    ],
    ...o,
  });

  it('keeps each piece of evidence linked to the record it came from', () => {
    const input = advisorToOpportunityInput(opp(), 'claude-x');
    expect(input.signals?.[0]).toMatchObject({
      kind: 'COMPETITOR_SNAPSHOT',
      refId: 'snap_1',
    });
    expect(input.signals?.[0]?.observedAt).toEqual(
      new Date('2026-09-30T00:00:00.000Z'),
    );
    // No record behind it: kept as evidence, honestly marked external.
    expect(input.signals?.[1]).toMatchObject({
      kind: 'EXTERNAL',
      refId: null,
      url: 'https://news.ycombinator.com/x',
    });
    expect(opportunityInputSchema.safeParse(input).success).toBe(true);
  });

  it('classifies the opportunity from its evidence', () => {
    expect(advisorOpportunityType(opp())).toBe('COMPETITOR_MOVE');
    expect(
      advisorOpportunityType(
        opp({ evidence: [{ kind: 'trend', label: 'x', detail: 'y' }] }),
      ),
    ).toBe('TRENDING_TOPIC');
    expect(
      advisorOpportunityType(
        opp({ evidence: [{ kind: 'gap', label: 'x', detail: 'y' }] }),
      ),
    ).toBe('CONTENT_GAP');
  });

  it('records which model detected it', () => {
    expect(advisorToOpportunityInput(opp(), 'none').detectedBy).toBe(
      'deterministic',
    );
    expect(advisorToOpportunityInput(opp(), 'claude-x').detectedBy).toBe(
      'claude-x',
    );
  });
});
