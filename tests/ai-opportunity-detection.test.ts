import { describe, it, expect } from 'vitest';

import {
  AI_DETECTION_LIMITS,
  AI_DETECTION_TYPES,
  aiResponseSchema,
  aiToOpportunityInput,
  buildAiDetectionPrompt,
  selectSignalsForAi,
  unsupportedNumbers,
  validateAiOutput,
} from '@/lib/ai-opportunity-detection';
import type { BusinessContextSnapshot } from '@/lib/business-context-snapshot';
import { derivePriority, opportunityInputSchema } from '@/lib/opportunities';
import type { DetectableSignal } from '@/lib/opportunity-detection';

/**
 * AI-assisted opportunity detection: the prompt it is given, and the checks
 * every opportunity it returns must pass before it is stored. The model is
 * never called here — validation is deterministic, so each check is tested
 * with hand-written model output.
 */

const NOW = new Date('2026-10-03T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
let n = 0;
function sig(o: Partial<DetectableSignal> = {}): DetectableSignal {
  n += 1;
  return {
    id: `sig${n}`,
    source: 'COMPETITORS',
    kind: 'COMPETITOR_SNAPSHOT',
    title: `Signal ${n}`,
    summary: `Summary ${n}`,
    url: null,
    refId: `ref${n}`,
    observedAt: daysAgo(2),
    expiresAt: daysAgo(-20),
    reliability: 'HIGH',
    occurrences: 1,
    contextMatches: [],
    metadata: {},
    dedupeKey: `k${n}`,
    ...o,
  };
}

const trust = {
  sourceType: 'USER_INPUT',
  confidence: 'HIGH',
  capturedAt: null,
  freshness: 'fresh',
};
const SNAPSHOT = {
  fingerprint: 'abcdef1234567890',
  trust: {
    'identity.description': trust,
    'market.competitors': trust,
    'history.recentContent': trust,
  },
  assumptions: [
    {
      field: 'audience.stated',
      label: 'Audience',
      value: 'Home brewers',
      reason: 'inferred, not confirmed',
    },
  ],
} as unknown as BusinessContextSnapshot;
const SNAPSHOT_TEXT =
  'BUSINESS CONTEXT — What it does: We roast single-origin coffee. Competitors: Acme Coffee';

const acmeSubs = sig({
  title: 'Acme Coffee: subscriptions',
  summary:
    'Acme launched a brewing-guide series alongside a 20% subscription cut',
});
const acmeBlog = sig({
  title: 'Acme Coffee: blog',
  summary: 'Acme publishes weekly guides on water chemistry for pour-over',
});
const lowTrend = sig({
  source: 'TRENDS',
  kind: 'TREND_ITEM',
  reliability: 'LOW',
  contextMatches: ['keyword:specialty coffee'],
  title: 'Reddit: is pour-over worth it?',
  summary: 'Home brewers argue about pour-over gear',
});
const analytics = sig({
  source: 'ANALYTICS',
  kind: 'ANALYTICS_REPORT',
  title: 'Engagement up on brewing videos',
  summary: 'Saves on brewing videos rose from 40 to 90',
});

const { refs } = buildAiDetectionPrompt({
  snapshot: SNAPSHOT,
  snapshotText: SNAPSHOT_TEXT,
  signals: [acmeSubs, acmeBlog, lowTrend, analytics],
});
const validate = (items: unknown[]) =>
  validateAiOutput(items, {
    refs,
    snapshot: SNAPSHOT,
    snapshotText: SNAPSHOT_TEXT,
    now: NOW,
  });

/** A model opportunity that passes every check; tests break one thing each. */
function good(o: Record<string, unknown> = {}) {
  return {
    type: 'CONTENT_GAP',
    title: 'Own the brewing-guide conversation',
    summary:
      'Acme is publishing brewing guides and you have not covered brewing at all.',
    reasoning:
      'Both Acme signals show a sustained push into brewing education, which your recent content does not touch.',
    angle: 'Guides from the roaster’s side: how the roast changes the brew.',
    evidence: [
      { signal: 'S1', supports: 'Acme launched a brewing-guide series.' },
      { signal: 'S2', supports: 'Acme publishes weekly brewing guides.' },
    ],
    businessFacts: ['identity.description', 'history.recentContent'],
    assumptions: [],
    confidence: 'MEDIUM',
    confidenceReason: 'Two direct observations of the same competitor.',
    impact: 'medium',
    effort: 'low',
    ...o,
  };
}

describe('input', () => {
  it('sends the snapshot, fact keys and each signal under a checkable reference', () => {
    const p = buildAiDetectionPrompt({
      snapshot: SNAPSHOT,
      snapshotText: SNAPSHOT_TEXT,
      signals: [acmeSubs, analytics],
    });
    expect(p.prompt).toContain(SNAPSHOT_TEXT);
    expect(p.prompt).toContain('[S1] (COMPETITORS, HIGH reliability');
    expect(p.prompt).toContain('identity.description');
    expect(p.prompt).toContain('audience.stated (ASSUMPTION');
    expect(p.refs.get('S2')).toBe(analytics);
    expect(p.system).toMatch(/Do not invent numbers/);
    expect(p.system).toMatch(/assumptions/);
  });

  it('only asks for the categories rules cannot detect', () => {
    expect(AI_DETECTION_TYPES).toEqual([
      'CONTENT_GAP',
      'COMPETITIVE_GAP',
      'AUDIENCE_SEGMENT',
    ]);
  });

  it('sends relevant, current, not-rejected signals, most reliable first', () => {
    const unrelated = sig({ source: 'TRENDS', kind: 'TREND_ITEM' });
    const expired = sig({ expiresAt: daysAgo(1) });
    const rejected = sig();
    const medium = sig({ reliability: 'MEDIUM' });
    const picked = selectSignalsForAi(
      [lowTrend, unrelated, expired, rejected, medium, acmeSubs],
      { now: NOW, rejectedSignalIds: new Set([rejected.id]) },
    );
    expect(picked.map((s) => s.id)).toEqual([
      acmeSubs.id,
      medium.id,
      lowTrend.id,
    ]);
  });
});

describe('validation', () => {
  it('accepts a well-formed, evidence-backed opportunity', () => {
    const r = validate([good()]);
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.signals.map((s) => s.id)).toEqual([
      acmeSubs.id,
      acmeBlog.id,
    ]);
  });

  it('rejects output that does not follow the schema — including a missing confidence', () => {
    const { confidence: _c, ...noConfidence } = good();
    const r = validate([noConfidence, 'not an object', { title: 'x' }]);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected).toHaveLength(3);
    expect(
      r.rejected.every((x) => x.reasons[0]!.code === 'invalid-shape'),
    ).toBe(true);
    expect(
      r.rejected[0]!.reasons.some((x) => x.detail.startsWith('confidence')),
    ).toBe(true);
  });

  it('rejects categories the rules already handle', () => {
    const r = validate([good({ type: 'TRENDING_TOPIC' })]);
    expect(r.rejected[0]!.reasons[0]!.code).toBe('type-not-allowed');
  });

  it('rejects a citation of a signal that was never supplied', () => {
    const r = validate([
      good({
        evidence: [
          { signal: 'S1', supports: 'Acme launched guides.' },
          { signal: 'S9', supports: 'An invented observation.' },
        ],
      }),
    ]);
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain(
      'unknown-signal',
    );
  });

  it('rejects no evidence at all', () => {
    const r = validate([good({ evidence: [] })]);
    expect(r.rejected[0]!.reasons[0]!.code).toBe('invalid-shape');
  });

  it('enforces the minimum evidence for each category, by signal source', () => {
    // A competitive gap is a theme: one competitor signal is not enough.
    const gap = validate([
      good({
        type: 'COMPETITIVE_GAP',
        evidence: [{ signal: 'S1', supports: 'Acme launched guides.' }],
      }),
    ]);
    expect(gap.rejected[0]!.reasons[0]!.code).toBe('insufficient-evidence');
    // An audience segment must stand on the business's own results.
    const segment = validate([good({ type: 'AUDIENCE_SEGMENT' })]);
    expect(segment.rejected[0]!.reasons[0]!.code).toBe('insufficient-evidence');
    const ok = validate([
      good({
        type: 'AUDIENCE_SEGMENT',
        evidence: [{ signal: 'S4', supports: 'Saves on brewing videos rose.' }],
      }),
    ]);
    expect(ok.accepted).toHaveLength(1);
  });

  it('rejects reliance on a business fact the context does not contain', () => {
    const r = validate([good({ businessFacts: ['products.pricing'] })]);
    expect(r.rejected[0]!.reasons[0]!.code).toBe('unknown-business-fact');
  });

  it('rejects an opportunity that declares it needed an assumption', () => {
    const r = validate([
      good({ assumptions: ['The business sells brewing equipment'] }),
    ]);
    expect(r.rejected[0]!.reasons[0]!.code).toBe('declared-assumption');
  });

  it('accepts reliance on an unconfirmed fact, but records it as assumed', () => {
    const r = validate([
      good({ businessFacts: ['identity.description', 'audience.stated'] }),
    ]);
    expect(r.accepted[0]!.assumedFacts).toEqual(['audience.stated']);
  });

  it('rejects figures that appear in no cited signal or business fact', () => {
    const r = validate([
      good({
        summary: 'Acme’s guides drove 35% more subscriptions last month.',
      }),
    ]);
    expect(r.rejected[0]!.reasons[0]!.code).toBe('unsupported-number');
    expect(r.rejected[0]!.reasons[0]!.detail).toContain('35%');
    // The 20% is in the cited signal, so it may be repeated.
    const ok = validate([
      good({ summary: 'Acme paired its guides with a 20% subscription cut.' }),
    ]);
    expect(ok.accepted).toHaveLength(1);
  });

  it('rejects a second opportunity of the same category over the same evidence', () => {
    const r = validate([good(), good({ title: 'Brewing guides, our way' })]);
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected[0]!.reasons[0]!.code).toBe('duplicate');
  });

  it('accepts no more than the per-run limit', () => {
    const extra = AI_DETECTION_LIMITS.maxOpportunities + 2;
    const own = Array.from({ length: extra }, () =>
      sig({ source: 'ANALYTICS', kind: 'ANALYTICS_REPORT' }),
    );
    const prompt = buildAiDetectionPrompt({
      snapshot: SNAPSHOT,
      snapshotText: SNAPSHOT_TEXT,
      signals: own,
    });
    // Each on its own evidence, so none is a duplicate of another.
    const many = own.map((_, i) =>
      good({
        type: 'AUDIENCE_SEGMENT',
        title: `Opportunity number ${i}`,
        evidence: [{ signal: `S${i + 1}`, supports: 'Supports it directly.' }],
      }),
    );
    const r = validateAiOutput(many, {
      refs: prompt.refs,
      snapshot: SNAPSHOT,
      snapshotText: SNAPSHOT_TEXT,
      now: NOW,
    });
    expect(r.accepted).toHaveLength(AI_DETECTION_LIMITS.maxOpportunities);
    expect(r.rejected.map((x) => x.reasons[0]!.code)).toEqual([
      'over-limit',
      'over-limit',
    ]);
  });

  it('keeps valid opportunities when others in the same response are invalid', () => {
    const r = validate([good({ businessFacts: ['made.up'] }), good()]);
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.index).toBe(0);
  });
});

describe('confidence', () => {
  it('is captured, and never above what the cited evidence supports', () => {
    const r = validate([
      good({
        confidence: 'HIGH',
        evidence: [
          { signal: 'S3', supports: 'Home brewers discuss pour-over.' },
        ],
      }),
    ]);
    const v = r.accepted[0]!;
    expect(v.confidence.claimed).toBe('HIGH');
    expect(v.confidence.evidence).toBe('LOW');
    expect(v.confidence.kept).toBe('LOW');
    expect(v.warnings[0]).toMatch(/lowered to LOW/);
  });

  it('a low-confidence AI opportunity is never high priority', () => {
    const r = validate([
      good({
        confidence: 'HIGH',
        impact: 'high',
        effort: 'low',
        evidence: [
          { signal: 'S3', supports: 'Home brewers discuss pour-over.' },
        ],
      }),
    ]);
    const input = opportunityInputSchema.parse(
      aiToOpportunityInput(r.accepted[0]!, {
        model: 'm',
        snapshotFingerprint: 'f',
        now: NOW,
      }),
    );
    const { priority } = derivePriority({
      impact: input.impact,
      effort: input.effort,
      confidence: input.confidence!,
      relevantUntil: input.relevantUntil ?? null,
      now: NOW,
    });
    expect(['LOW', 'MEDIUM']).toContain(priority);
  });
});

describe('stored opportunity', () => {
  it('follows the opportunity schema and references its supporting signals', () => {
    const v = validate([good()]).accepted[0]!;
    const input = opportunityInputSchema.parse(
      aiToOpportunityInput(v, {
        model: 'claude-x',
        snapshotFingerprint: SNAPSHOT.fingerprint,
        now: NOW,
      }),
    );
    expect(input.source).toBe('AI_DETECTION');
    expect(input.detectedBy).toBe('ai:claude-x');
    expect(input.signals.map((s) => s.signalId)).toEqual([
      acmeSubs.id,
      acmeBlog.id,
    ]);
    // Evidence is the signal itself, not the model's paraphrase of it.
    expect(input.signals[0]!.detail).toBe(acmeSubs.summary);
    expect(input.confidence).toBe('MEDIUM');
    expect(input.contextFields).toEqual([
      'identity.description',
      'history.recentContent',
    ]);
    const ai = (input.details as { ai: Record<string, unknown> }).ai;
    expect(ai.snapshotFingerprint).toBe(SNAPSHOT.fingerprint);
    expect(ai.confidence).toMatchObject({ claimed: 'MEDIUM', kept: 'MEDIUM' });
    expect((ai.evidence as { supports: string }[])[0]!.supports).toMatch(
      /brewing-guide/,
    );
    // Relevant until its newest evidence expires.
    expect(input.relevantUntil).toEqual(acmeSubs.expiresAt);
  });

  it('the response envelope tolerates an empty answer', () => {
    expect(
      aiResponseSchema.safeParse({
        opportunities: [],
        noOpportunityReason: 'Nothing new.',
      }).success,
    ).toBe(true);
    expect(aiResponseSchema.safeParse({ ideas: [] }).success).toBe(false);
  });
});

describe('unsupportedNumbers', () => {
  it('flags invented percentages, money and large numbers; ignores small counts and the year', () => {
    expect(
      unsupportedNumbers(
        'Up 35% to $1,200 across 3 competitors in 2026, with 150 signups',
        'nothing here',
        NOW,
      ),
    ).toEqual(['35%', '$1,200', '150']);
    expect(unsupportedNumbers('A 1,200 rise', 'rose by 1200', NOW)).toEqual([]);
  });
});
