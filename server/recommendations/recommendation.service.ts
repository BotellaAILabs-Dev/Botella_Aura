import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import {
  ACTIVE_STATUSES,
  type OpportunityPriority,
} from '@/lib/opportunities';
import {
  buildHandoff,
  handoffEligibility,
  recommendationSeed,
  type HandoffEligibility,
  type OpportunityHandoff,
} from '@/lib/recommendation-handoff';
import {
  LIVE_RECOMMENDATION_STATUSES,
  RECOMMENDATION_TO_OPPORTUNITY,
  boundByOpportunity,
  canTransitionRecommendation,
  draftFromOpportunity,
  executionBrief,
  recommendationContentSchema,
  type RecommendationContentInput,
  type RecommendationStatus,
} from '@/lib/recommendations';
import { getBusinessContext } from '@/server/business-context/business-context.service';
import {
  OpportunityError,
  shakyContextFields,
  transitionOpportunity,
} from '@/server/opportunities/opportunity.service';

/**
 * Recommendations, applied to the database (rules: lib/recommendations.ts).
 *
 *   getOpportunityHandoff                what an opportunity hands over
 *   createRecommendationFromOpportunity  a complete recommendation from an
 *                                        opportunity: its content (a default
 *                                        draft, overridable by a person or
 *                                        the engine), the inherited link,
 *                                        assessment, context and evidence
 *   transitionRecommendation             move it through its lifecycle, with
 *                                        history, kept in step with the
 *                                        opportunity
 *   expireRecommendations                close undecided ones whose moment
 *                                        has passed
 *   getRecommendation / listRecommendations
 */

const handoffInclude = {
  signals: {
    orderBy: { createdAt: 'asc' },
    include: {
      signal: { select: { source: true, reliability: true, expiresAt: true } },
    },
  },
} satisfies Prisma.OpportunityInclude;

export interface HandoffResult {
  handoff: OpportunityHandoff;
  eligibility: HandoffEligibility;
}

/**
 * The hand-off for one opportunity, with whether it can be recommended now.
 * Null for an opportunity that does not exist in this workspace.
 */
export async function getOpportunityHandoff(
  companyId: string,
  opportunityId: string,
  options: { now?: Date; client?: Prisma.TransactionClient } = {},
): Promise<HandoffResult | null> {
  const now = options.now ?? new Date();
  const client = options.client ?? db;
  const [o, ctx] = await Promise.all([
    client.opportunity.findFirst({
      where: { id: opportunityId, companyId },
      include: handoffInclude,
    }),
    getBusinessContext(companyId, { sections: [] }),
  ]);
  if (!o) return null;
  const handoff = buildHandoff(o, {
    now,
    shakyFields: shakyContextFields(ctx, o.contextFields),
    currentRevision: ctx?.meta.revision ?? null,
  });
  return {
    handoff,
    eligibility: handoffEligibility(o, handoff.evidence, now),
  };
}

const withDetail = {
  evidence: { orderBy: { createdAt: 'asc' } },
  events: { orderBy: { createdAt: 'asc' } },
  opportunity: {
    select: { id: true, title: true, type: true, status: true },
  },
} satisfies Prisma.RecommendationInclude;

/**
 * Create a recommendation from an opportunity.
 *
 * Its content starts as the default draft (lib/recommendations.ts
 * draftFromOpportunity) and any field the caller supplies replaces the
 * draft's — a person editing it, or the recommendation engine writing it.
 * The result is validated as a whole; confidence and relevance are bounded by
 * the opportunity's.
 *
 * In one transaction: checks the opportunity can be recommended and has no
 * recommendation still in play, stores the recommendation with its hand-off,
 * evidence and first history entry, and moves the opportunity to RECOMMENDED.
 */
export async function createRecommendationFromOpportunity(args: {
  companyId: string;
  opportunityId: string;
  /** "user:<id>", "rule:…", or a model name. */
  createdBy: string;
  actorId: string | null;
  content?: Partial<RecommendationContentInput>;
  /**
   * Priority assigned for this recommendation (the engine weighs the chosen
   * action's effort). Defaults to the opportunity's.
   */
  priority?: { priority: OpportunityPriority; priorityScore: number };
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const ctx = await getBusinessContext(args.companyId, {
    sections: ['targeting'],
  });
  return db.$transaction(async (tx) => {
    const found = await getOpportunityHandoff(
      args.companyId,
      args.opportunityId,
      { now, client: tx },
    );
    if (!found) throw new OpportunityError('Opportunity not found.', 404);
    const { handoff, eligibility } = found;
    if (!eligibility.eligible) {
      throw new OpportunityError(
        `This opportunity cannot be recommended: ${eligibility.reasons.join(' ')}`,
        409,
      );
    }
    const live = await tx.recommendation.findFirst({
      where: {
        companyId: args.companyId,
        opportunityId: args.opportunityId,
        status: { in: LIVE_RECOMMENDATION_STATUSES },
      },
      select: { id: true, status: true },
    });
    if (live) {
      throw new OpportunityError(
        `This opportunity already has a recommendation that is ${live.status.toLowerCase().replace('_', ' ')}. Finish or withdraw it first.`,
        409,
      );
    }

    const draft = draftFromOpportunity(handoff, {
      channels: ctx?.channels.preferred ?? [],
      audience: ctx?.audience.stated ?? null,
    });
    const content = recommendationContentSchema.parse({
      ...draft,
      ...args.content,
    });
    const bounds = boundByOpportunity(content, handoff);
    const { evidence, ...seed } = recommendationSeed(handoff);
    const {
      confidence: _claimed,
      confidenceReason: _claimedReason,
      relevantUntil: _asked,
      ...own
    } = content;

    const created = await tx.recommendation.create({
      data: {
        ...seed,
        ...own,
        details: own.details as Prisma.InputJsonObject,
        ...bounds,
        ...(args.priority ?? {}),
        companyId: args.companyId,
        handoff: handoff as unknown as Prisma.InputJsonObject,
        createdBy: args.createdBy.slice(0, 100),
        createdAt: now,
        statusChangedAt: now,
        evidence: { create: evidence },
        events: {
          create: {
            fromStatus: null,
            toStatus: 'PROPOSED',
            actorId: args.actorId,
            note: `Recommended by ${args.createdBy}.`,
            createdAt: now,
          },
        },
      },
    });

    if (handoff.opportunity.status !== 'RECOMMENDED') {
      await transitionOpportunity(
        {
          companyId: args.companyId,
          opportunityId: args.opportunityId,
          to: 'RECOMMENDED',
          actorId: args.actorId,
          note: `Recommendation created: ${content.title}`,
          now,
        },
        tx,
      );
    }
    return tx.recommendation.findUniqueOrThrow({
      where: { id: created.id },
      include: withDetail,
    });
  });
}

/**
 * Move a recommendation through its lifecycle, recording who, when and why.
 * Compare-and-swap on the current status, so it is decided once. Accepting
 * or rejecting it is the same decision on its opportunity, in the same
 * transaction.
 */
export async function transitionRecommendation(args: {
  companyId: string;
  recommendationId: string;
  to: RecommendationStatus;
  actorId: string | null;
  note?: string;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  return db.$transaction(async (tx) => {
    const current = await tx.recommendation.findFirst({
      where: { id: args.recommendationId, companyId: args.companyId },
      include: { opportunity: { select: { id: true, status: true } } },
    });
    if (!current) throw new OpportunityError('Recommendation not found.', 404);
    if (!canTransitionRecommendation(current.status, args.to)) {
      throw new OpportunityError(
        `A recommendation that is ${current.status.toLowerCase().replace('_', ' ')} cannot be marked ${args.to.toLowerCase().replace('_', ' ')}.`,
        409,
      );
    }

    const stamp: Prisma.RecommendationUpdateManyMutationInput = {
      status: args.to,
      statusChangedAt: now,
    };
    if (['ACCEPTED', 'REJECTED', 'WITHDRAWN'].includes(args.to)) {
      Object.assign(stamp, {
        decidedAt: now,
        decidedById: args.actorId,
        decisionNote: args.note ?? null,
      });
    }
    if (args.to === 'IN_PROGRESS') stamp.startedAt = now;
    if (args.to === 'COMPLETED') {
      stamp.completedAt = now;
      if (!current.startedAt) stamp.startedAt = now;
    }
    if (args.to === 'EXPIRED') stamp.expiredAt = now;

    const swapped = await tx.recommendation.updateMany({
      where: { id: current.id, status: current.status },
      data: stamp,
    });
    if (swapped.count === 0) {
      throw new OpportunityError(
        'Someone else updated this recommendation first. Reload to see its status.',
        409,
      );
    }
    await tx.recommendationEvent.create({
      data: {
        recommendationId: current.id,
        fromStatus: current.status,
        toStatus: args.to,
        actorId: args.actorId,
        note: args.note ?? null,
        createdAt: now,
      },
    });

    const to = RECOMMENDATION_TO_OPPORTUNITY[args.to];
    if (to && ACTIVE_STATUSES.includes(current.opportunity.status)) {
      await transitionOpportunity(
        {
          companyId: args.companyId,
          opportunityId: current.opportunity.id,
          to,
          actorId: args.actorId,
          note:
            args.note ??
            `Recommendation ${args.to.toLowerCase().replace('_', ' ')}.`,
          now,
        },
        tx,
      );
    }
    return tx.recommendation.findUniqueOrThrow({
      where: { id: current.id },
      include: withDetail,
    });
  });
}

/** Accept, reject or withdraw — the decisions on a recommendation. */
export function decideRecommendation(args: {
  companyId: string;
  recommendationId: string;
  decision: 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN';
  actorId: string | null;
  note?: string;
  now?: Date;
}) {
  const { decision, ...rest } = args;
  return transitionRecommendation({ ...rest, to: decision });
}

/**
 * Expire every recommendation still waiting for a decision whose relevance
 * window has passed. Its opportunity is left alone: that has its own window.
 */
export async function expireRecommendations(
  companyId: string,
  now: Date = new Date(),
): Promise<number> {
  const due = await db.recommendation.findMany({
    where: { companyId, status: 'PROPOSED', relevantUntil: { lte: now } },
    select: { id: true },
  });
  let expired = 0;
  for (const r of due) {
    try {
      await transitionRecommendation({
        companyId,
        recommendationId: r.id,
        to: 'EXPIRED',
        actorId: null,
        note: 'Its relevance window passed before a decision.',
        now,
      });
      expired += 1;
    } catch {
      // Decided a moment ago — not expired.
    }
  }
  return expired;
}

/** One recommendation with its evidence, history, opportunity and execution brief. */
export async function getRecommendation(
  companyId: string,
  recommendationId: string,
) {
  const r = await db.recommendation.findFirst({
    where: { id: recommendationId, companyId },
    include: withDetail,
  });
  return r ? { ...r, execution: executionBrief(r) } : null;
}

/** A workspace's recommendations, newest first. Expires stale ones first. */
export async function listRecommendations(
  companyId: string,
  options: {
    opportunityId?: string;
    status?: RecommendationStatus[];
    limit?: number;
    now?: Date;
  } = {},
) {
  await expireRecommendations(companyId, options.now);
  return db.recommendation.findMany({
    where: {
      companyId,
      ...(options.opportunityId
        ? { opportunityId: options.opportunityId }
        : {}),
      ...(options.status ? { status: { in: options.status } } : {}),
    },
    include: {
      evidence: { orderBy: { createdAt: 'asc' } },
      opportunity: {
        select: { id: true, title: true, type: true, status: true },
      },
    },
    orderBy: [{ createdAt: 'desc' }],
    take: options.limit ?? 50,
  });
}
