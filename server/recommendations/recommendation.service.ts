import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import {
  buildHandoff,
  handoffEligibility,
  recommendationSeed,
  RECOMMENDATION_TO_OPPORTUNITY,
  type HandoffEligibility,
  type OpportunityHandoff,
} from '@/lib/recommendation-handoff';
import { getBusinessContext } from '@/server/business-context/business-context.service';
import {
  OpportunityError,
  shakyContextFields,
  transitionOpportunity,
} from '@/server/opportunities/opportunity.service';

/**
 * Opportunity → Recommendation, applied to the database.
 *
 * The FOUNDATION for the Sprint 8 recommendation engine, not the engine:
 *
 *   getOpportunityHandoff        what an opportunity hands a recommendation
 *   createRecommendationFromOpportunity
 *                                a recommendation that references its
 *                                opportunity, with the evidence copied
 *                                forward, and the opportunity moved to
 *                                RECOMMENDED in the same transaction
 *   decideRecommendation         accept / reject / withdraw, mirrored onto
 *                                the opportunity
 *
 * What the recommendation actually says to do (`content`) is the engine's
 * job; until then it is empty and a recommendation carries the opportunity's
 * own title, summary and assessment.
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

const withEvidence = {
  evidence: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.RecommendationInclude;

/**
 * Create a recommendation from an opportunity.
 *
 * In one transaction: re-reads the opportunity and checks it can be
 * recommended, refuses if it already has an open recommendation, stores the
 * recommendation with its hand-off and a copy of every piece of evidence, and
 * moves the opportunity to RECOMMENDED (unless it already is). Either all of
 * that happens or none of it does.
 */
export async function createRecommendationFromOpportunity(args: {
  companyId: string;
  opportunityId: string;
  /** "user:<id>", "rule:…", or a model name. */
  createdBy: string;
  actorId: string | null;
  title?: string;
  summary?: string;
  /** The engine's content (what to do). Empty in Sprint 7. */
  content?: Prisma.InputJsonObject;
  now?: Date;
}) {
  const now = args.now ?? new Date();
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
    const open = await tx.recommendation.findFirst({
      where: { opportunityId: args.opportunityId, status: 'PROPOSED' },
      select: { id: true },
    });
    if (open) {
      throw new OpportunityError(
        'This opportunity already has an open recommendation. Decide or withdraw it first.',
        409,
      );
    }

    const { evidence, ...seed } = recommendationSeed(handoff, args);
    const created = await tx.recommendation.create({
      data: {
        ...seed,
        companyId: args.companyId,
        content: args.content ?? {},
        handoff: handoff as unknown as Prisma.InputJsonObject,
        createdBy: args.createdBy.slice(0, 100),
        createdAt: now,
        evidence: { create: evidence },
      },
    });

    if (handoff.opportunity.status !== 'RECOMMENDED') {
      await transitionOpportunity(
        {
          companyId: args.companyId,
          opportunityId: args.opportunityId,
          to: 'RECOMMENDED',
          actorId: args.actorId,
          note: `Recommendation created: ${seed.title}`,
          now,
        },
        tx,
      );
    }
    return tx.recommendation.findUniqueOrThrow({
      where: { id: created.id },
      include: withEvidence,
    });
  });
}

/**
 * Accept, reject or withdraw a recommendation. Accepting or rejecting it is
 * the same decision on its opportunity, recorded there in the same
 * transaction; withdrawing leaves the opportunity open for another one.
 */
export async function decideRecommendation(args: {
  companyId: string;
  recommendationId: string;
  decision: 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN';
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
    // Compare-and-swap: only an open recommendation can be decided, once.
    const swapped = await tx.recommendation.updateMany({
      where: { id: current.id, status: 'PROPOSED' },
      data: {
        status: args.decision,
        decidedAt: now,
        decidedById: args.actorId,
        decisionNote: args.note ?? null,
      },
    });
    if (swapped.count === 0) {
      throw new OpportunityError(
        `This recommendation is already ${current.status.toLowerCase()}.`,
        409,
      );
    }

    const to = RECOMMENDATION_TO_OPPORTUNITY[args.decision];
    const opp = current.opportunity;
    if (
      to &&
      opp &&
      ['DETECTED', 'REVIEWED', 'RECOMMENDED'].includes(opp.status)
    ) {
      await transitionOpportunity(
        {
          companyId: args.companyId,
          opportunityId: opp.id,
          to,
          actorId: args.actorId,
          note: args.note ?? `Recommendation ${args.decision.toLowerCase()}.`,
          now,
        },
        tx,
      );
    }
    return tx.recommendation.findUniqueOrThrow({
      where: { id: current.id },
      include: withEvidence,
    });
  });
}

/** A workspace's recommendations, newest first, optionally for one opportunity. */
export async function listRecommendations(
  companyId: string,
  options: { opportunityId?: string; limit?: number } = {},
) {
  return db.recommendation.findMany({
    where: {
      companyId,
      ...(options.opportunityId
        ? { opportunityId: options.opportunityId }
        : {}),
    },
    include: withEvidence,
    orderBy: { createdAt: 'desc' },
    take: options.limit ?? 50,
  });
}
