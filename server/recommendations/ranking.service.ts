import { db } from '@/lib/db';
import { engineContext } from '@/lib/recommendation-engine';
import {
  RANKED_STATUSES,
  RANKING_WEIGHTS,
  rankRecommendations,
  type PastDecision,
  type RankableRecommendation,
  type RankedRecommendation,
} from '@/lib/recommendation-ranking';
import { getContextSnapshot } from '@/server/business-context/snapshot.service';
import { OpportunityError } from '@/server/opportunities/opportunity.service';
import { expireRecommendations } from './recommendation.service';

/**
 * Prioritisation, applied (rules: lib/recommendation-ranking.ts).
 *
 * surfaceRecommendations reads the workspace's recommendations waiting for a
 * decision or to be started, the business as it is NOW (goals, campaign
 * themes, channels from the current snapshot), what is still current in each
 * one's evidence, and the business's decisions on similar recommendations
 * over the last 90 days — and returns them in the order to surface them,
 * each with its score, band and the reasons.
 *
 * Nothing is stored: the order is computed on every read.
 */

const DAY = 86_400_000;

export interface SurfacedRecommendation extends RankedRecommendation {
  recommendation: {
    id: string;
    title: string;
    action: string;
    type: string;
    status: string;
    channel: string | null;
    priority: string;
    confidence: string;
    executable: boolean;
    relevantUntil: string | null;
    evidence: { label: string; current: boolean }[];
  };
}

export async function surfaceRecommendations(
  companyId: string,
  options: { now?: Date; includeHidden?: boolean } = {},
): Promise<SurfacedRecommendation[]> {
  const now = options.now ?? new Date();
  await expireRecommendations(companyId, now);

  const [rows, past, snap] = await Promise.all([
    db.recommendation.findMany({
      where: { companyId, status: { in: RANKED_STATUSES } },
      include: {
        evidence: {
          include: { signal: { select: { expiresAt: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    }),
    db.recommendation.findMany({
      where: {
        companyId,
        decidedAt: {
          gte: new Date(now.getTime() - RANKING_WEIGHTS.historyDays * DAY),
        },
        status: {
          in: [
            'ACCEPTED',
            'EDITED',
            'IN_PROGRESS',
            'COMPLETED',
            'SKIPPED',
            'REJECTED',
          ],
        },
      },
      select: {
        id: true,
        title: true,
        channel: true,
        status: true,
        decidedAt: true,
        details: true,
      },
    }),
    getContextSnapshot(companyId, { view: 'recommendation', now }),
  ]);

  const ctx = snap
    ? engineContext(snap.snapshot)
    : { goals: null, campaignThemes: [], publishesOn: [], connected: [] };
  const actionOf = (details: unknown) => {
    const a = (details as { action?: unknown } | null)?.action;
    return typeof a === 'string' ? a : null;
  };
  /** Evidence is current while its signal is; copies with no signal link
   * (older evidence) count as current, as in the hand-off. */
  const currentOf = (e: {
    signalId: string | null;
    signal: { expiresAt: Date | null } | null;
  }) =>
    !e.signalId ||
    Boolean(
      e.signal && (e.signal.expiresAt === null || e.signal.expiresAt > now),
    );

  const rankable: RankableRecommendation[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    status: r.status,
    actionId: actionOf(r.details),
    channel: r.channel,
    priority: r.priority,
    priorityScore: r.priorityScore,
    confidence: r.confidence,
    executable: r.executable,
    blockers: r.blockers,
    relevantUntil: r.relevantUntil,
    createdAt: r.createdAt,
    currentEvidence: r.evidence.filter(currentOf).length,
    snoozedUntil: r.snoozedUntil,
    snoozeCount: r.snoozeCount,
    text: `${r.title} ${r.summary} ${r.rationale}`,
  }));
  const history: PastDecision[] = past
    .filter((p) => p.decidedAt)
    .map((p) => ({
      id: p.id,
      title: p.title,
      actionId: actionOf(p.details),
      channel: p.channel,
      status: p.status,
      decidedAt: p.decidedAt!,
    }));

  const ranked = rankRecommendations(rankable, ctx, history, now, {
    includeHidden: options.includeHidden,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ranked.map((x) => {
    const r = byId.get(x.id)!;
    return {
      ...x,
      recommendation: {
        id: r.id,
        title: r.title,
        action: r.action,
        type: r.type,
        status: r.status,
        channel: r.channel,
        priority: r.priority,
        confidence: r.confidence,
        executable: r.executable,
        relevantUntil: r.relevantUntil?.toISOString() ?? null,
        evidence: r.evidence.map((e) => ({
          label: e.label,
          current: currentOf(e),
        })),
      },
    };
  });
}

export const SNOOZE_LIMITS = {
  minDays: 1,
  maxDays: 30,
  defaultDays: 7,
} as const;

/**
 * "Not now": hide a recommendation from the surfaced list until a date, after
 * which it comes back (and says so). Each deferral after the first lowers it.
 * Refused if it would expire while hidden — that is a "no", not a "not now".
 */
export async function snoozeRecommendation(args: {
  companyId: string;
  recommendationId: string;
  days?: number;
  actorId: string | null;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const days = Math.min(
    SNOOZE_LIMITS.maxDays,
    Math.max(
      SNOOZE_LIMITS.minDays,
      Math.round(args.days ?? SNOOZE_LIMITS.defaultDays),
    ),
  );
  const until = new Date(now.getTime() + days * DAY);
  return db.$transaction(async (tx) => {
    const r = await tx.recommendation.findFirst({
      where: { id: args.recommendationId, companyId: args.companyId },
    });
    if (!r) throw new OpportunityError('Recommendation not found.', 404);
    if (!RANKED_STATUSES.includes(r.status)) {
      throw new OpportunityError(
        `A recommendation that is ${r.status.toLowerCase().replace('_', ' ')} cannot be deferred.`,
        409,
      );
    }
    if (r.relevantUntil && r.relevantUntil <= until) {
      throw new OpportunityError(
        `It stops being relevant on ${r.relevantUntil.toISOString().slice(0, 10)}, before ${until.toISOString().slice(0, 10)}. Reject or withdraw it instead.`,
        409,
      );
    }
    await tx.recommendation.update({
      where: { id: r.id },
      data: { snoozedUntil: until, snoozeCount: { increment: 1 } },
    });
    await tx.recommendationEvent.create({
      data: {
        recommendationId: r.id,
        fromStatus: r.status,
        toStatus: r.status,
        action: 'defer',
        source: 'user',
        metadata: { until: until.toISOString(), times: r.snoozeCount + 1 },
        actorId: args.actorId,
        note: `Deferred until ${until.toISOString().slice(0, 10)}.`,
        createdAt: now,
      },
    });
    return tx.recommendation.findUniqueOrThrow({ where: { id: r.id } });
  });
}
