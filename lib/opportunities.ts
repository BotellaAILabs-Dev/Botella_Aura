import { z } from 'zod';

/**
 * Opportunities: the rules.
 *
 * An opportunity is something Aura noticed that the business could act on — a
 * trend worth riding, a competitor move worth answering, a gap in what it
 * publishes. It is stored on its own (independently of any recommendation),
 * carries the evidence it came from with links to the underlying signals, and
 * moves through a tracked lifecycle.
 *
 * This module is the pure part: the vocabulary, the lifecycle, and how
 * confidence, priority and relevance are derived. The service
 * (server/opportunities/opportunity.service.ts) applies them to the database.
 */

export const OPPORTUNITY_TYPES = [
  'TRENDING_TOPIC',
  'COMPETITOR_MOVE',
  'COMPETITIVE_GAP',
  'CONTENT_GAP',
  'SEASONAL_MOMENT',
  'AUDIENCE_SEGMENT',
  'CHANNEL',
  'PERFORMANCE_PATTERN',
  'OTHER',
] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

export const OPPORTUNITY_STATUSES = [
  'DETECTED',
  'REVIEWED',
  'RECOMMENDED',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const OPPORTUNITY_PRIORITIES = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'URGENT',
] as const;
export type OpportunityPriority = (typeof OPPORTUNITY_PRIORITIES)[number];

export const OPPORTUNITY_CONFIDENCES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type OpportunityConfidence = (typeof OPPORTUNITY_CONFIDENCES)[number];

export const OPPORTUNITY_SOURCES = [
  'ADVISOR',
  'TRENDS',
  'COMPETITORS',
  'MEMORY',
  'ANALYTICS',
  'MANUAL',
] as const;
export type OpportunitySource = (typeof OPPORTUNITY_SOURCES)[number];

export const SIGNAL_KINDS = [
  'COMPETITOR_SNAPSHOT',
  'TREND_ITEM',
  'MEMORY_INSIGHT',
  'CONTENT_DRAFT',
  'ANALYTICS_REPORT',
  'KNOWLEDGE_CHUNK',
  'LEAD_SIGNAL',
  'BUSINESS_CONTEXT',
  'EXTERNAL',
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** How each type is described to a person. */
export const OPPORTUNITY_TYPE_INFO: Record<
  OpportunityType,
  { label: string; relevanceDays: number | null }
> = {
  TRENDING_TOPIC: { label: 'Trending topic', relevanceDays: 14 },
  COMPETITOR_MOVE: { label: 'Competitor move', relevanceDays: 30 },
  COMPETITIVE_GAP: { label: 'Competitive gap', relevanceDays: 90 },
  CONTENT_GAP: { label: 'Content gap', relevanceDays: 60 },
  // Seasonal moments expire on the event date the detector supplies.
  SEASONAL_MOMENT: { label: 'Seasonal moment', relevanceDays: 30 },
  AUDIENCE_SEGMENT: { label: 'Audience segment', relevanceDays: 120 },
  CHANNEL: { label: 'Channel', relevanceDays: 120 },
  PERFORMANCE_PATTERN: { label: 'What is working', relevanceDays: 60 },
  OTHER: { label: 'Other', relevanceDays: 60 },
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 *   DETECTED ─► REVIEWED ─► RECOMMENDED ─► ACCEPTED
 *       │           │            │
 *       └───────────┴────────────┴──► REJECTED
 *       └───────────┴────────────┴──► EXPIRED   (relevance window passed)
 *
 * A person can skip ahead (accept straight from DETECTED) — the lifecycle
 * records what happened, it does not force ceremony. ACCEPTED is final.
 * REJECTED can be reopened to REVIEWED if someone changes their mind; EXPIRED
 * can only come back by being detected again with fresh evidence.
 */
export const TRANSITIONS: Record<OpportunityStatus, OpportunityStatus[]> = {
  DETECTED: ['REVIEWED', 'RECOMMENDED', 'ACCEPTED', 'REJECTED', 'EXPIRED'],
  REVIEWED: ['RECOMMENDED', 'ACCEPTED', 'REJECTED', 'EXPIRED'],
  RECOMMENDED: ['ACCEPTED', 'REJECTED', 'EXPIRED'],
  ACCEPTED: [],
  REJECTED: ['REVIEWED'],
  EXPIRED: [],
};

/** Still something a person could act on. */
export const ACTIVE_STATUSES: OpportunityStatus[] = [
  'DETECTED',
  'REVIEWED',
  'RECOMMENDED',
];

export function canTransition(
  from: OpportunityStatus,
  to: OpportunityStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Expired from age alone? Only an opportunity still open can expire. */
export function isPastRelevance(
  o: { status: OpportunityStatus; relevantUntil: Date | null },
  now: Date,
): boolean {
  return (
    ACTIVE_STATUSES.includes(o.status) &&
    o.relevantUntil !== null &&
    o.relevantUntil <= now
  );
}

// ---------------------------------------------------------------------------
// Detection input
// ---------------------------------------------------------------------------

export const signalInputSchema = z.object({
  kind: z.enum(SIGNAL_KINDS),
  /** Id of the underlying record. Null only for EXTERNAL evidence with a URL. */
  refId: z.string().max(200).nullable().optional(),
  label: z.string().trim().min(1).max(200),
  detail: z.string().trim().min(1).max(2000),
  url: z.string().url().max(2000).optional(),
  observedAt: z.date().optional(),
  /** The normalised Signal this came from (server/signals), when it did. */
  signalId: z.string().max(40).optional(),
});
export type SignalInput = z.infer<typeof signalInputSchema>;

export const opportunityInputSchema = z.object({
  type: z.enum(OPPORTUNITY_TYPES),
  title: z.string().trim().min(3).max(200),
  summary: z.string().trim().min(1).max(4000),
  rationale: z.string().trim().max(4000).optional(),
  angle: z.string().trim().max(2000).optional(),
  details: z.record(z.unknown()).default({}),
  source: z.enum(OPPORTUNITY_SOURCES),
  detectedBy: z.string().trim().min(1).max(100),
  /** Every opportunity carries evidence. One with none is a guess. */
  signals: z
    .array(signalInputSchema)
    .min(1, 'An opportunity needs at least one piece of evidence.')
    .max(50),
  /** How much it would matter and cost, as the detector judged it. */
  impact: z.enum(['low', 'medium', 'high']).default('medium'),
  effort: z.enum(['low', 'medium', 'high']).default('medium'),
  /** The detector's own confidence; the stored value never exceeds the evidence. */
  confidence: z.enum(OPPORTUNITY_CONFIDENCES).optional(),
  /** When it stops being worth acting on; defaults from the type. */
  relevantUntil: z.date().nullable().optional(),
  /** Override the generated dedupe key (e.g. a stable id from the detector). */
  dedupeKey: z.string().max(200).optional(),
  /** Business Context fields it relies on, e.g. ["audience.stated"]. */
  contextFields: z.array(z.string().max(60)).max(20).default([]),
});
export type OpportunityInput = z.input<typeof opportunityInputSchema>;
export type ParsedOpportunityInput = z.output<typeof opportunityInputSchema>;

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/** Same opportunity, same key — however the title is capitalised or punctuated. */
export function dedupeKeyFor(type: OpportunityType, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 12)
    .join('-');
  return `${type}:${slug}`;
}

/**
 * What makes two pieces of evidence the same. The service stores a hash of
 * this as the signal's fingerprint, so re-detecting an opportunity never adds
 * the same evidence twice. (Plain string here so this module stays usable in
 * the browser.)
 */
export function signalKey(
  s: Pick<SignalInput, 'kind' | 'refId' | 'detail'>,
): string {
  return `${s.kind}|${s.refId ?? ''}|${s.detail.replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

export function defaultRelevantUntil(
  type: OpportunityType,
  detectedAt: Date,
): Date | null {
  const days = OPPORTUNITY_TYPE_INFO[type].relevanceDays;
  return days === null
    ? null
    : new Date(detectedAt.getTime() + days * 86_400_000);
}

const CONF_RANK: Record<OpportunityConfidence, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

/**
 * How sure Aura can be, from the evidence — never more than the detector
 * claimed, and never more than the evidence supports:
 *
 *   one signal                                → LOW
 *   two or more signals                       → MEDIUM
 *   three or more from two or more kinds      → HIGH  (independent corroboration)
 *
 * It is capped at MEDIUM when it rests on business information the company
 * has not confirmed or that is out of date: an opportunity aimed at an
 * audience Aura only guessed is itself a guess.
 */
export function deriveConfidence(args: {
  signals: Pick<SignalInput, 'kind' | 'refId' | 'detail'>[];
  claimed?: OpportunityConfidence;
  /** Context fields it relies on that are untrusted or stale. */
  shakyContext?: string[];
}): { confidence: OpportunityConfidence; reason: string } {
  const distinct = new Set(args.signals.map(signalKey)).size;
  const kinds = new Set(args.signals.map((s) => s.kind)).size;
  let confidence: OpportunityConfidence =
    distinct >= 3 && kinds >= 2 ? 'HIGH' : distinct >= 2 ? 'MEDIUM' : 'LOW';
  const reasons = [
    `${distinct} piece${distinct === 1 ? '' : 's'} of evidence from ${kinds} kind${kinds === 1 ? '' : 's'} of signal`,
  ];
  if (args.claimed && CONF_RANK[args.claimed] < CONF_RANK[confidence]) {
    confidence = args.claimed;
    reasons.push(`the detector rated it ${args.claimed.toLowerCase()}`);
  }
  if (args.shakyContext?.length && CONF_RANK[confidence] > CONF_RANK.MEDIUM) {
    confidence = 'MEDIUM';
    reasons.push(
      `relies on unconfirmed or out-of-date business information (${args.shakyContext.join(', ')})`,
    );
  }
  return { confidence, reason: reasons.join('; ') };
}

const LEVEL = { low: 1, medium: 2, high: 3 } as const;

/**
 * Priority from what it is worth, what it costs, how sure Aura is, and how
 * soon it stops being relevant. URGENT means worth doing AND closing within a
 * week — not merely closing soon.
 */
export function derivePriority(args: {
  impact: 'low' | 'medium' | 'high';
  effort: 'low' | 'medium' | 'high';
  confidence: OpportunityConfidence;
  relevantUntil: Date | null;
  now: Date;
}): { priority: OpportunityPriority; score: number } {
  let score =
    LEVEL[args.impact] * 22 +
    (4 - LEVEL[args.effort]) * 8 +
    CONF_RANK[args.confidence] * 6;
  // 22..66 + 8..24 + 6..18  →  36..108, normalised to 0..100.
  score = Math.round(((score - 36) / 72) * 100);
  const daysLeft =
    args.relevantUntil === null
      ? null
      : (args.relevantUntil.getTime() - args.now.getTime()) / 86_400_000;
  if (daysLeft !== null && daysLeft <= 7 && score >= 50) {
    return { priority: 'URGENT', score: Math.min(100, score + 10) };
  }
  return {
    priority: score >= 66 ? 'HIGH' : score >= 33 ? 'MEDIUM' : 'LOW',
    score,
  };
}
