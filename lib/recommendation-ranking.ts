import type { OpportunityConfidence } from '@/lib/opportunities';
import {
  channelSupport,
  titleSimilarity,
  type ChannelSupport,
} from '@/lib/recommendation-rules';
import type {
  RecommendationStatus,
  RecommendationType,
} from '@/lib/recommendations';

/**
 * Recommendation prioritisation: what to surface FIRST, now.
 *
 * Not a permanent "best recommendation" ranking. It is computed on read, from
 * the business as it is at that moment — goals, channels, what is closing,
 * what the business has accepted or turned down — so the same recommendation
 * can rise or fall from one day to the next. A recommendation's own stored
 * priority (from its opportunity and chosen action) is one input of several.
 *
 * Every factor adds or removes points WITH its reason, so the position of any
 * recommendation can be explained factor by factor. Same inputs, same order:
 * there is no randomness, and ties break on a fixed sequence.
 *
 * Pure and client-safe. The service is server/recommendations/ranking.service.ts.
 */

/** What is ranked: recommendations waiting for a decision, or accepted and not yet started. */
export const RANKED_STATUSES: RecommendationStatus[] = ['PROPOSED', 'ACCEPTED'];

export interface RankableRecommendation {
  id: string;
  title: string;
  type: RecommendationType;
  status: RecommendationStatus;
  actionId: string | null;
  channel: string | null;
  priority: string;
  /** 0–100, from the engine (opportunity impact, action effort, confidence, time). */
  priorityScore: number;
  confidence: OpportunityConfidence;
  executable: boolean;
  blockers: string[];
  relevantUntil: Date | null;
  createdAt: Date;
  /** Evidence still current (its signal has not expired or been pruned). */
  currentEvidence: number;
  snoozedUntil: Date | null;
  snoozeCount: number;
  /** Words describing it, for goal matching (title, summary, rationale). */
  text: string;
}

/** A past decision on a recommendation, from the workspace's history. */
export interface PastDecision {
  /** So a recommendation's own decision never counts as its history. */
  id?: string;
  title: string;
  actionId: string | null;
  channel: string | null;
  status: RecommendationStatus;
  decidedAt: Date;
}

export interface RankingContext {
  goals: string | null;
  campaignThemes: string[];
  publishesOn: string[];
  connected: string[];
}

/** The points each factor can add or remove. The product's rules, as data. */
export const RANKING_WEIGHTS = {
  /** The stored priority score (0–100) contributes up to this many points. */
  basePriority: 50,
  confidence: { HIGH: 10, MEDIUM: 4, LOW: -10 },
  goalMatch: 10,
  closingWithin3Days: 15,
  closingWithin7Days: 8,
  /** Waiting for a decision this long without one: it is losing relevance. */
  waitingDays: 14,
  waitingPenalty: -5,
  channel: {
    publishable: 8,
    'connect-to-publish': 2,
    'draft-only': 0,
    unsupported: 0,
  } satisfies Record<ChannelSupport, number>,
  /** Advice that cannot be acted on yet sinks below anything actionable. */
  blocked: -25,
  noCurrentEvidence: -20,
  corroborated: 4,
  accepted: 5,
  /** Per similar recommendation the business acted on (up to 2). */
  similarAccepted: 6,
  /** Per similar recommendation the business rejected (up to 3). */
  similarRejected: -8,
  /** Per deferral beyond the first. */
  deferredAgain: -5,
  /** How far back previous decisions count. */
  historyDays: 90,
} as const;

/** Bands: what the business should look at now, next, or later. */
export const BANDS = {
  /** Surface now: at least this score, AND acted on safely (see bandFor). */
  now: 70,
  next: 40,
} as const;

export type Band = 'now' | 'next' | 'later' | 'hidden';

export interface RankingFactor {
  factor:
    | 'priority'
    | 'confidence'
    | 'goals'
    | 'timing'
    | 'channel'
    | 'evidence'
    | 'history'
    | 'status';
  /** Points added (positive) or removed (negative). */
  points: number;
  why: string;
}

export interface RankedRecommendation {
  id: string;
  rank: number;
  score: number;
  band: Band;
  factors: RankingFactor[];
  /** The ranking in one sentence. */
  explanation: string;
  /** Why it is not in "now" despite its score, or why it is hidden. */
  heldBack: string | null;
  /** It is back after being deferred. */
  resurfaced: boolean;
}

const DAY = 86_400_000;
const CONF_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 } as const;

const words = (t: string) =>
  new Set(
    t
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  );

function similar(r: RankableRecommendation, p: PastDecision): boolean {
  return (
    (Boolean(r.actionId) &&
      r.actionId === p.actionId &&
      r.channel === p.channel) ||
    titleSimilarity(r.title, p.title) >= 0.6
  );
}

/** Score one recommendation, factor by factor. */
export function scoreRecommendation(
  r: RankableRecommendation,
  ctx: RankingContext,
  history: PastDecision[],
  now: Date,
): { score: number; factors: RankingFactor[] } {
  const W = RANKING_WEIGHTS;
  const f: RankingFactor[] = [];

  // PRIORITY — the recommendation's own.
  f.push({
    factor: 'priority',
    points: Math.round((r.priorityScore / 100) * W.basePriority),
    why: `${r.priority.toLowerCase()} priority (${r.priorityScore}/100)`,
  });

  // CONFIDENCE
  f.push({
    factor: 'confidence',
    points: W.confidence[r.confidence],
    why: `${r.confidence.toLowerCase()} confidence`,
  });

  // GOALS
  const goalWords = words([ctx.goals ?? '', ...ctx.campaignThemes].join(' '));
  const hit = [...words(r.text)].find((w) => goalWords.has(w));
  if (hit) {
    f.push({
      factor: 'goals',
      points: W.goalMatch,
      why: `relates to your current goal or campaign (“${hit}”)`,
    });
  }

  // TIMING
  if (r.relevantUntil) {
    const left = (r.relevantUntil.getTime() - now.getTime()) / DAY;
    if (left <= 3) {
      f.push({
        factor: 'timing',
        points: W.closingWithin3Days,
        why: `closes in ${Math.max(0, Math.ceil(left))} day(s)`,
      });
    } else if (left <= 7) {
      f.push({
        factor: 'timing',
        points: W.closingWithin7Days,
        why: `closes within a week`,
      });
    }
  }
  const waiting = (now.getTime() - r.createdAt.getTime()) / DAY;
  if (r.status === 'PROPOSED' && waiting >= W.waitingDays) {
    f.push({
      factor: 'timing',
      points: W.waitingPenalty,
      why: `waiting ${Math.floor(waiting)} days for a decision`,
    });
  }

  // CHANNEL
  if (!r.executable) {
    f.push({
      factor: 'channel',
      points: W.blocked,
      why: `cannot be acted on yet: ${r.blockers[0] ?? 'blocked'}`,
    });
  } else if (r.channel) {
    const support = channelSupport(r.channel, ctx);
    const points = W.channel[support];
    if (points) {
      f.push({
        factor: 'channel',
        points,
        why:
          support === 'publishable'
            ? `${r.channel} is connected — Aura can publish and measure it`
            : `${r.channel} can be connected to publish from Aura`,
      });
    }
  }

  // EVIDENCE
  if (r.currentEvidence === 0) {
    f.push({
      factor: 'evidence',
      points: W.noCurrentEvidence,
      why: 'none of its evidence is current any more',
    });
  } else if (r.currentEvidence >= 2) {
    f.push({
      factor: 'evidence',
      points: W.corroborated,
      why: `${r.currentEvidence} current pieces of evidence`,
    });
  }

  // STATUS
  if (r.status === 'ACCEPTED') {
    f.push({
      factor: 'status',
      points: W.accepted,
      why: 'you accepted it — the next step is to start it',
    });
  }

  // HISTORY — what the business did with similar recommendations.
  const recent = history.filter(
    (p) =>
      p.id !== r.id &&
      (now.getTime() - p.decidedAt.getTime()) / DAY <= W.historyDays,
  );
  const acted = recent.filter(
    (p) =>
      ['ACCEPTED', 'IN_PROGRESS', 'COMPLETED'].includes(p.status) &&
      similar(r, p),
  ).length;
  const rejected = recent.filter(
    (p) => p.status === 'REJECTED' && similar(r, p),
  ).length;
  if (acted) {
    f.push({
      factor: 'history',
      points: W.similarAccepted * Math.min(acted, 2),
      why: `you acted on ${acted} similar recommendation${acted === 1 ? '' : 's'}`,
    });
  }
  if (rejected) {
    f.push({
      factor: 'history',
      points: W.similarRejected * Math.min(rejected, 3),
      why: `you turned down ${rejected} similar recommendation${rejected === 1 ? '' : 's'}`,
    });
  }
  if (r.snoozeCount > 1) {
    f.push({
      factor: 'history',
      points: W.deferredAgain * (r.snoozeCount - 1),
      why: `deferred ${r.snoozeCount} times`,
    });
  }

  const raw = f.reduce((s, x) => s + x.points, 0);
  return { score: Math.max(0, Math.min(100, raw)), factors: f };
}

/**
 * The band. "Now" is the top of the list, so it has to be safe to act on:
 * a high score is not enough without current evidence, at least medium
 * confidence, and nothing blocking it.
 */
export function bandFor(
  r: RankableRecommendation,
  score: number,
  now: Date,
): { band: Band; heldBack: string | null } {
  if (r.snoozedUntil && r.snoozedUntil > now) {
    return {
      band: 'hidden',
      heldBack: `deferred until ${r.snoozedUntil.toISOString().slice(0, 10)}`,
    };
  }
  if (score >= BANDS.now) {
    const held =
      r.currentEvidence === 0
        ? 'its evidence is no longer current'
        : CONF_RANK[r.confidence] < CONF_RANK.MEDIUM
          ? 'its confidence is low'
          : !r.executable
            ? 'it cannot be acted on yet'
            : null;
    return held
      ? { band: 'next', heldBack: held }
      : { band: 'now', heldBack: null };
  }
  return { band: score >= BANDS.next ? 'next' : 'later', heldBack: null };
}

/**
 * TIE-BREAKING, in order, when two scores are equal:
 *   1. the one closing sooner (no deadline last)
 *   2. higher confidence
 *   3. more current evidence
 *   4. waiting longer (created earlier)
 *   5. id — so the order is total and identical on every read
 */
export function compareRanked(
  a: { r: RankableRecommendation; score: number },
  b: { r: RankableRecommendation; score: number },
): number {
  const t = (d: Date | null) => (d ? d.getTime() : Number.POSITIVE_INFINITY);
  return (
    b.score - a.score ||
    t(a.r.relevantUntil) - t(b.r.relevantUntil) ||
    CONF_RANK[b.r.confidence] - CONF_RANK[a.r.confidence] ||
    b.r.currentEvidence - a.r.currentEvidence ||
    a.r.createdAt.getTime() - b.r.createdAt.getTime() ||
    (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0)
  );
}

const BAND_ORDER: Record<Band, number> = {
  now: 0,
  next: 1,
  later: 2,
  hidden: 3,
};

/**
 * Rank a workspace's recommendations for surfacing. Hidden (deferred) ones
 * come last and are left out unless asked for.
 */
export function rankRecommendations(
  recs: RankableRecommendation[],
  ctx: RankingContext,
  history: PastDecision[],
  now: Date,
  options: { includeHidden?: boolean } = {},
): RankedRecommendation[] {
  const scored = recs
    .filter((r) => RANKED_STATUSES.includes(r.status))
    .map((r) => {
      const { score, factors } = scoreRecommendation(r, ctx, history, now);
      const { band, heldBack } = bandFor(r, score, now);
      return { r, score, factors, band, heldBack };
    })
    .filter((x) => options.includeHidden || x.band !== 'hidden');

  scored.sort(
    (a, b) => BAND_ORDER[a.band] - BAND_ORDER[b.band] || compareRanked(a, b),
  );

  return scored.map((x, i) => {
    const top = [...x.factors]
      .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
      .slice(0, 3)
      .map((f) => `${f.why} (${f.points > 0 ? '+' : ''}${f.points})`);
    const resurfaced =
      x.r.snoozeCount > 0 && (!x.r.snoozedUntil || x.r.snoozedUntil <= now);
    return {
      id: x.r.id,
      rank: i + 1,
      score: x.score,
      band: x.band,
      factors: x.factors,
      explanation: `${BAND_LABEL[x.band]} (score ${x.score}): ${top.join('; ')}.${
        x.heldBack ? ` Held back from the top because ${x.heldBack}.` : ''
      }${resurfaced ? ' Back after you deferred it.' : ''}`,
      heldBack: x.heldBack,
      resurfaced,
    };
  });
}

const BAND_LABEL: Record<Band, string> = {
  now: 'Surface now',
  next: 'Next',
  later: 'Later',
  hidden: 'Deferred',
};
