import { CONNECTORS } from '@/lib/connectors';
import type { OpportunityConfidence } from '@/lib/opportunities';
import type { OpportunityHandoff } from '@/lib/recommendation-handoff';
import type { ScoredAction, Selection } from '@/lib/recommendation-engine';
import type { RecommendationType } from '@/lib/recommendations';
import type { SignalSource } from '@/lib/signals';
import type { CONTENT_CHANNELS } from '@/lib/validations/planner';

/**
 * Recommendation rules and guardrails: what Aura can and cannot recommend.
 *
 * A recommendation is not made because a model produced one. It is made
 * because an opportunity passed these rules — and every rule is plain logic,
 * stated here as data, enforced by the engine
 * (server/recommendations/engine.service.ts) and tested on its own.
 *
 *   ELIGIBILITY        lib/recommendation-handoff.ts handoffEligibility, plus
 *                      "none in play" and the frequency limits below
 *   MINIMUM EVIDENCE   MIN_EVIDENCE — per recommendation type
 *   CONFIDENCE         CONFIDENCE_RULES — what each level allows
 *   PRIORITY           lib/recommendation-engine.ts assess (documented in
 *                      docs/RECOMMENDATION-RULES.md)
 *   FREQUENCY          FREQUENCY_LIMITS
 *   DUPLICATES         DUPLICATE_RULES, findDuplicate, mutedActions
 *   CHANNELS           channelSupport — only channels the business uses
 *   INTEGRATIONS       CHANNEL_INTEGRATIONS — only what Aura can connect
 *   EXPIRATION         EXPIRY_RULES, capRelevance
 *   CONFLICTS          findConflicts
 *   LOW CONFIDENCE     executability — advisory, not executable
 *
 * Pure and client-safe.
 */

type Channel = (typeof CONTENT_CHANNELS)[number];
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Minimum evidence
// ---------------------------------------------------------------------------

/**
 * How much CURRENT evidence each kind of recommendation needs, and of what
 * kind. Counted over the opportunity's evidence, not the model's word.
 */
export const MIN_EVIDENCE: Record<
  RecommendationType,
  { count: number; sources?: SignalSource[]; description: string }
> = {
  CONTENT: { count: 1, description: 'one current signal' },
  CAMPAIGN: {
    count: 2,
    description: 'two current signals — a series is a bigger bet than one post',
  },
  COMPETITIVE_RESPONSE: {
    count: 1,
    sources: ['COMPETITORS'],
    description: 'one current signal from a tracked competitor',
  },
  AUDIENCE: { count: 1, description: 'one current signal' },
  CHANNEL: {
    count: 1,
    sources: ['BUSINESS_CONTEXT'],
    description: 'the business’s own statement that it uses the channel',
  },
  OPTIMIZATION: {
    count: 1,
    sources: ['ANALYTICS', 'MEMORY'],
    description:
      'one current signal from the business’s own results or patterns',
  },
  OTHER: { count: 1, description: 'one current signal' },
};

/** Why the evidence is not enough for this type, or null if it is. */
export function evidenceShortfall(
  type: RecommendationType,
  h: OpportunityHandoff,
): string | null {
  const need = MIN_EVIDENCE[type];
  const usable = h.evidence.filter(
    (e) =>
      e.current &&
      // Evidence with no normalised signal (older advisor evidence) has no
      // known source; it counts only where any source will do.
      (!need.sources || (e.source !== null && need.sources.includes(e.source))),
  );
  return usable.length >= need.count
    ? null
    : `needs ${need.description}; has ${usable.length}`;
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

/**
 * What each confidence level allows.
 *
 *   HIGH, MEDIUM  an executable recommendation
 *   LOW           ADVISORY: stored and shown, flagged, priority capped (never
 *                 high or urgent), and NOT executable until a person accepts
 *                 it — accepting is the review that a low-confidence
 *                 recommendation needs before anything acts on it.
 */
export const CONFIDENCE_RULES: Record<
  OpportunityConfidence,
  { executable: boolean; flag: string | null }
> = {
  HIGH: { executable: true, flag: null },
  MEDIUM: { executable: true, flag: null },
  LOW: {
    executable: false,
    flag: 'low confidence — review the evidence before acting on it',
  },
};

export const LOW_CONFIDENCE_BLOCKER =
  'Low confidence: accept it after reviewing the evidence to make it actionable.';

// ---------------------------------------------------------------------------
// Frequency
// ---------------------------------------------------------------------------

/**
 * How many recommendations a business gets, so Aura informs rather than
 * floods. Checked before any work is done.
 */
export const FREQUENCY_LIMITS = {
  /** New recommendations per workspace per rolling 24 hours. */
  perDay: 10,
  /** Waiting for a decision at once. More is a backlog nobody reads. */
  maxOpen: 15,
  /** Content recommendations for one channel per rolling 7 days. */
  perChannelPerWeek: 5,
} as const;

export function frequencyBreach(stats: {
  createdLastDay: number;
  open: number;
  /** For the channel the recommendation would use, if any. */
  sameChannelLastWeek?: number;
  channel?: string | null;
}): string | null {
  if (stats.createdLastDay >= FREQUENCY_LIMITS.perDay) {
    return `${stats.createdLastDay} recommendations were made in the last 24 hours (limit ${FREQUENCY_LIMITS.perDay}).`;
  }
  if (stats.open >= FREQUENCY_LIMITS.maxOpen) {
    return `${stats.open} recommendations are waiting for a decision (limit ${FREQUENCY_LIMITS.maxOpen}). Decide on some first.`;
  }
  if (
    stats.channel &&
    (stats.sameChannelLastWeek ?? 0) >= FREQUENCY_LIMITS.perChannelPerWeek
  ) {
    return `${stats.sameChannelLastWeek} recommendations for ${stats.channel} in the last 7 days (limit ${FREQUENCY_LIMITS.perChannelPerWeek}).`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Duplicates and repetition
// ---------------------------------------------------------------------------

export const DUPLICATE_RULES = {
  /** A similar recommendation still in play, or made this recently. */
  windowDays: 14,
  /** A similar one the business rejected this recently. */
  rejectedWindowDays: 30,
  /** Title word overlap (Jaccard) at or above which two are "the same". */
  similarity: 0.6,
  /** Rejections of the same action on the same channel that mute it… */
  muteAfterRejections: 3,
  /** …within this window. */
  muteWindowDays: 30,
} as const;

/** A recent recommendation, as the duplicate and conflict rules read it. */
export interface RecentRecommendation {
  id: string;
  opportunityId: string;
  title: string;
  type: RecommendationType;
  /** The engine's action id (details.action), when known. */
  actionId: string | null;
  channel: string | null;
  status: string;
  priorityScore: number;
  createdAt: Date;
  decidedAt: Date | null;
  signalIds: string[];
  competitor: string | null;
}

const LIVE = ['PROPOSED', 'ACCEPTED', 'IN_PROGRESS'];

const FILLER = new Set([
  'the',
  'and',
  'are',
  'for',
  'with',
  'your',
  'you',
  'this',
  'that',
  'about',
  'from',
  'into',
  'its',
  'our',
  'how',
  'why',
  'what',
  'was',
  'were',
]);
/** "climbing", "climbed", "climbs" → "climb": enough to see a repeat. */
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '') || w;

function titleWords(t: string): Set<string> {
  return new Set(
    t
      .toLowerCase()
      .replace(/^[^:]*:\s*/, '') // "Post about: X" → "X"
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !FILLER.has(w))
      .map(stem),
  );
}

/** Word overlap between two titles, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const x = titleWords(a);
  const y = titleWords(b);
  if (!x.size || !y.size) return 0;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared);
}

/**
 * The same recommendation made again: same type and channel, a near-identical
 * title, and either still in play / made in the last 14 days, or rejected in
 * the last 30. (Same opportunity is already "one in play".)
 */
export function findDuplicate(
  candidate: {
    opportunityId: string;
    title: string;
    type: RecommendationType;
    channel: string | null;
  },
  recent: RecentRecommendation[],
  now: Date,
): { id: string; reason: string } | null {
  for (const r of recent) {
    if (r.opportunityId === candidate.opportunityId) continue;
    if (r.type !== candidate.type || r.channel !== candidate.channel) continue;
    if (titleSimilarity(r.title, candidate.title) < DUPLICATE_RULES.similarity)
      continue;
    const ageDays = (now.getTime() - r.createdAt.getTime()) / DAY;
    if (LIVE.includes(r.status) || ageDays <= DUPLICATE_RULES.windowDays) {
      return {
        id: r.id,
        reason: `repeats “${r.title}”, made ${Math.floor(ageDays)} day(s) ago`,
      };
    }
    const rejectedDays = r.decidedAt
      ? (now.getTime() - r.decidedAt.getTime()) / DAY
      : Infinity;
    if (
      r.status === 'REJECTED' &&
      rejectedDays <= DUPLICATE_RULES.rejectedWindowDays
    ) {
      return {
        id: r.id,
        reason: `repeats “${r.title}”, which the business rejected ${Math.floor(rejectedDays)} day(s) ago`,
      };
    }
  }
  return null;
}

/**
 * Actions the business keeps rejecting: the same action on the same channel
 * rejected 3+ times in 30 days, with none accepted since, is not proposed
 * again until that changes. Keys are "<actionId>:<channel>".
 */
export function mutedActions(
  recent: RecentRecommendation[],
  now: Date,
): Set<string> {
  const byKey = new Map<string, { rejected: number; accepted: boolean }>();
  for (const r of recent) {
    if (!r.actionId || !r.decidedAt) continue;
    if (
      (now.getTime() - r.decidedAt.getTime()) / DAY >
      DUPLICATE_RULES.muteWindowDays
    )
      continue;
    const key = `${r.actionId}:${r.channel ?? ''}`;
    const e = byKey.get(key) ?? { rejected: 0, accepted: false };
    if (r.status === 'REJECTED') e.rejected += 1;
    if (['ACCEPTED', 'IN_PROGRESS', 'COMPLETED'].includes(r.status))
      e.accepted = true;
    byKey.set(key, e);
  }
  return new Set(
    [...byKey]
      .filter(
        ([, e]) =>
          e.rejected >= DUPLICATE_RULES.muteAfterRejections && !e.accepted,
      )
      .map(([k]) => k),
  );
}

// ---------------------------------------------------------------------------
// Channels and integrations
// ---------------------------------------------------------------------------

/**
 * Which Aura integration publishes to each channel. A channel with no
 * integration, or one still "coming soon", can be written for (drafts) but
 * not connected or published to from Aura.
 */
export const CHANNEL_INTEGRATIONS: Record<Channel, string | null> = {
  LinkedIn: 'linkedin',
  Instagram: 'meta',
  X: 'x',
  YouTube: 'youtube',
  Blog: 'wordpress',
  // Mailchimp reads audiences and results; it does not send newsletters.
  Newsletter: null,
};

/** Can Aura connect (and so publish to) this channel at all? */
export function integrationAvailable(channel: string): boolean {
  const id = CHANNEL_INTEGRATIONS[channel as Channel];
  return Boolean(
    id && CONNECTORS.find((c) => c.id === id)?.status === 'available',
  );
}

export type ChannelSupport =
  /** The business does not use it: not an executable recommendation. */
  | 'unsupported'
  /** The business uses it; write the draft in Aura, publish by hand. */
  | 'draft-only'
  /** The business uses it; Aura can connect it but it is not connected yet. */
  | 'connect-to-publish'
  /** Connected: Aura can publish and measure it. */
  | 'publishable';

export function channelSupport(
  channel: string,
  ctx: { publishesOn: string[]; connected: string[] },
): ChannelSupport {
  if (!ctx.publishesOn.includes(channel)) return 'unsupported';
  if (ctx.connected.includes(channel)) return 'publishable';
  return integrationAvailable(channel) ? 'connect-to-publish' : 'draft-only';
}

// ---------------------------------------------------------------------------
// Expiration
// ---------------------------------------------------------------------------

export const EXPIRY_RULES = {
  /** A recommendation waiting for a decision lapses after this, at most. */
  maxProposedDays: 30,
} as const;

/** The opportunity's window, but never more than 30 days from creation. */
export function capRelevance(until: Date | null, createdAt: Date): Date {
  const cap = new Date(
    createdAt.getTime() + EXPIRY_RULES.maxProposedDays * DAY,
  );
  return until && until < cap ? until : cap;
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export interface Conflict {
  id: string;
  title: string;
  why: string;
  /** Which one should go first. */
  precedence: 'this' | 'other';
}

/**
 * Two recommendations in play that pull the business in different directions
 * on the same thing:
 *
 *   SAME EVIDENCE    built on any of the same signals, with different actions
 *   SAME COMPETITOR  two different answers to the same competitor
 *
 * Neither is dropped — they may both be worth doing — but each is flagged
 * with the other, and the higher-priority one is marked to go first.
 */
export function findConflicts(
  candidate: {
    opportunityId: string;
    actionId: string;
    signalIds: string[];
    competitor: string | null;
    priorityScore: number;
  },
  recent: RecentRecommendation[],
): Conflict[] {
  const out: Conflict[] = [];
  for (const r of recent) {
    if (!LIVE.includes(r.status) || r.opportunityId === candidate.opportunityId)
      continue;
    const sharesEvidence =
      r.actionId !== candidate.actionId &&
      r.signalIds.some((s) => candidate.signalIds.includes(s));
    const sameCompetitor =
      candidate.competitor !== null &&
      r.competitor === candidate.competitor &&
      r.type === 'COMPETITIVE_RESPONSE';
    if (!sharesEvidence && !sameCompetitor) continue;
    out.push({
      id: r.id,
      title: r.title,
      why: sameCompetitor
        ? `both answer ${candidate.competitor}`
        : 'both rest on the same evidence, with different actions',
      precedence: candidate.priorityScore > r.priorityScore ? 'this' : 'other',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Executability — what may be acted on
// ---------------------------------------------------------------------------

/**
 * Whether a recommendation may be handed to an execution workflow, and if
 * not, why. Blocked recommendations are still stored and shown (as advice),
 * never executed:
 *
 *   · low confidence, until a person accepts it;
 *   · a channel the business does not use;
 *   · connecting a channel Aura cannot connect.
 */
export function executability(args: {
  type: RecommendationType;
  channel: string | null;
  confidence: OpportunityConfidence;
  ctx: { publishesOn: string[]; connected: string[] };
}): { executable: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!CONFIDENCE_RULES[args.confidence].executable)
    blockers.push(LOW_CONFIDENCE_BLOCKER);
  if (args.channel) {
    if (args.type === 'CHANNEL') {
      if (!integrationAvailable(args.channel)) {
        blockers.push(`Aura cannot connect ${args.channel} yet.`);
      }
    } else if (channelSupport(args.channel, args.ctx) === 'unsupported') {
      blockers.push(`${args.channel} is not a channel the business uses.`);
    }
  }
  return { executable: blockers.length === 0, blockers };
}

// ---------------------------------------------------------------------------
// Applying the rules to the engine's choice of action
// ---------------------------------------------------------------------------

/**
 * Take the engine's ranked actions and set aside every one the rules do not
 * allow, with the reason: too little evidence of the right kind, an action
 * the business keeps rejecting, or connecting a channel Aura cannot connect.
 * What remains is still ranked by fit.
 */
export function applyGuardrails(
  selection: Selection,
  args: { h: OpportunityHandoff; muted: Set<string> },
): Selection {
  const viable: ScoredAction[] = [];
  const unsupported = [...selection.unsupported];
  for (const a of selection.viable) {
    const reasons: string[] = [];
    const short = evidenceShortfall(a.spec.type, args.h);
    if (short) reasons.push(short);
    if (args.muted.has(`${a.spec.id}:${a.channel ?? ''}`)) {
      reasons.push(
        `the business rejected this ${DUPLICATE_RULES.muteAfterRejections}+ times in the last ${DUPLICATE_RULES.muteWindowDays} days`,
      );
    }
    if (
      a.spec.id === 'connect-channel' &&
      a.channel &&
      !integrationAvailable(a.channel)
    ) {
      reasons.push(`Aura cannot connect ${a.channel} yet`);
    }
    if (reasons.length)
      unsupported.push({ id: a.spec.id, label: a.spec.label, reasons });
    else viable.push(a);
  }
  return { viable, unsupported };
}
