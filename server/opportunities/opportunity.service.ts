import { createHash } from 'node:crypto';
import type { Opportunity, OpportunitySignal, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import type { BusinessContext } from '@/lib/business-context';
import {
  ACTIVE_STATUSES,
  canTransition,
  dedupeKeyFor,
  defaultRelevantUntil,
  deriveConfidence,
  derivePriority,
  opportunityInputSchema,
  signalKey,
  type OpportunityInput,
  type OpportunityStatus,
  type SignalInput,
} from '@/lib/opportunities';
import {
  ACTION_FOR_STATUS,
  OPEN_RECOMMENDATION_STATUSES,
  OPPORTUNITY_TO_RECOMMENDATION,
  type RecommendationStatus,
} from '@/lib/recommendations';
import { getBusinessContext } from '@/server/business-context/business-context.service';

/**
 * Storing opportunities, and moving them through their lifecycle.
 *
 * recordOpportunity is the one way a detector (the advisor today; trends,
 * competitors, memory and analytics later) saves what it found. It is
 * idempotent by `dedupeKey`: detecting the same opportunity again adds the new
 * evidence to it instead of creating a duplicate.
 */

export class OpportunityError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'OpportunityError';
  }
}

export type RecordOutcome = 'created' | 'updated' | 'reopened' | 'skipped';

export type OpportunityWithSignals = Opportunity & {
  signals: OpportunitySignal[];
};

function fingerprint(s: SignalInput): string {
  return createHash('sha256').update(signalKey(s)).digest('hex').slice(0, 32);
}

/**
 * Context fields the opportunity relies on that the business has not
 * confirmed, or that are out of date — which caps its confidence.
 */
export function shakyContextFields(
  ctx: BusinessContext | null,
  fields: string[],
): string[] {
  if (!ctx) return fields;
  return fields.filter((f) => {
    const fact = ctx.meta.facts[f];
    return !fact || !fact.trusted || fact.freshness === 'stale';
  });
}

export async function recordOpportunity(
  companyId: string,
  raw: OpportunityInput,
  options: {
    now?: Date;
    /** An already-loaded context, so a detector recording many does one read. */
    context?: BusinessContext | null;
    /** The snapshot fingerprint the detector worked from, when it used one. */
    contextFingerprint?: string;
  } = {},
): Promise<{
  opportunity: OpportunityWithSignals;
  outcome: RecordOutcome;
  reason?: string;
}> {
  const input = opportunityInputSchema.parse(raw);
  const now = options.now ?? new Date();
  const ctx =
    options.context !== undefined
      ? options.context
      : await getBusinessContext(companyId, { sections: [] });
  const shaky = shakyContextFields(ctx, input.contextFields);
  const dedupeKey = input.dedupeKey ?? dedupeKeyFor(input.type, input.title);
  const relevantUntil =
    input.relevantUntil !== undefined
      ? input.relevantUntil
      : defaultRelevantUntil(input.type, now);

  /** Confidence and priority over a set of signals. */
  const assess = (signals: SignalInput[], until: Date | null) => {
    const { confidence, reason } = deriveConfidence({
      signals,
      claimed: input.confidence,
      shakyContext: shaky,
    });
    const { priority, score } = derivePriority({
      impact: input.impact,
      effort: input.effort,
      confidence,
      relevantUntil: until,
      now,
    });
    return {
      confidence,
      confidenceReason: reason,
      priority,
      priorityScore: score,
    };
  };

  const signalRows = (opportunityId: string) =>
    input.signals.map((s) => ({
      opportunityId,
      kind: s.kind,
      refId: s.refId ?? null,
      label: s.label,
      detail: s.detail,
      url: s.url ?? null,
      observedAt: s.observedAt ?? null,
      signalId: s.signalId ?? null,
      fingerprint: fingerprint(s),
    }));

  return db.$transaction(async (tx) => {
    const existing = await tx.opportunity.findUnique({
      where: { companyId_dedupeKey: { companyId, dedupeKey } },
      include: { signals: true },
    });

    // --- New ---------------------------------------------------------------
    if (!existing) {
      const created = await tx.opportunity.create({
        data: {
          companyId,
          type: input.type,
          title: input.title,
          summary: input.summary,
          rationale: input.rationale ?? null,
          angle: input.angle ?? null,
          details: input.details as Prisma.InputJsonObject,
          source: input.source,
          detectedBy: input.detectedBy,
          dedupeKey,
          detectedAt: now,
          lastSeenAt: now,
          statusChangedAt: now,
          relevantUntil,
          contextRevision: ctx?.meta.revision ?? null,
          contextFingerprint: options.contextFingerprint ?? null,
          contextFields: input.contextFields,
          impact: input.impact,
          effort: input.effort,
          ...assess(input.signals, relevantUntil),
        },
      });
      await tx.opportunitySignal.createMany({
        data: signalRows(created.id),
        skipDuplicates: true,
      });
      await tx.opportunityEvent.create({
        data: {
          opportunityId: created.id,
          fromStatus: null,
          toStatus: 'DETECTED',
          note: `Detected by ${input.source.toLowerCase()} (${input.detectedBy}).`,
          createdAt: now,
        },
      });
      const opportunity = await tx.opportunity.findUniqueOrThrow({
        where: { id: created.id },
        include: { signals: true },
      });
      return { opportunity, outcome: 'created' as const };
    }

    // --- A person already decided: leave it alone ---------------------------
    if (existing.status === 'REJECTED' || existing.status === 'ACCEPTED') {
      return {
        opportunity: existing,
        outcome: 'skipped' as const,
        reason: `Already ${existing.status.toLowerCase()} — a re-detection does not override that decision.`,
      };
    }

    // --- Seen again: add the new evidence, and reopen if it had expired ------
    await tx.opportunitySignal.createMany({
      data: signalRows(existing.id),
      skipDuplicates: true,
    });
    const allSignals = await tx.opportunitySignal.findMany({
      where: { opportunityId: existing.id },
    });
    const reopening = existing.status === 'EXPIRED';
    const until =
      relevantUntil && existing.relevantUntil && !reopening
        ? new Date(
            Math.max(relevantUntil.getTime(), existing.relevantUntil.getTime()),
          )
        : relevantUntil;

    await tx.opportunity.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: now,
        relevantUntil: until,
        // The latest detector's judgement, matching the priority it produces.
        impact: input.impact,
        effort: input.effort,
        contextRevision: ctx?.meta.revision ?? existing.contextRevision,
        ...(options.contextFingerprint
          ? { contextFingerprint: options.contextFingerprint }
          : {}),
        ...assess(
          allSignals.map((s) => ({
            kind: s.kind,
            refId: s.refId,
            label: s.label,
            detail: s.detail,
          })),
          until,
        ),
        ...(reopening
          ? {
              status: 'DETECTED' as const,
              statusChangedAt: now,
              expiredAt: null,
            }
          : {}),
      },
    });
    if (reopening) {
      await tx.opportunityEvent.create({
        data: {
          opportunityId: existing.id,
          fromStatus: 'EXPIRED',
          toStatus: 'DETECTED',
          note: 'Detected again with fresh evidence.',
          createdAt: now,
        },
      });
    }
    const opportunity = await tx.opportunity.findUniqueOrThrow({
      where: { id: existing.id },
      include: { signals: true },
    });
    return {
      opportunity,
      outcome: reopening ? ('reopened' as const) : ('updated' as const),
    };
  });
}

/**
 * Move an opportunity to a new status, recording who and why.
 *
 * Compare-and-swap on the current status, so two people acting on the same
 * opportunity at once cannot both "win" — the second gets a 409 and sees the
 * first person's decision.
 *
 * Pass `tx` to make the move part of a larger transaction (creating a
 * recommendation moves its opportunity in the same commit).
 */
export async function transitionOpportunity(
  args: {
    companyId: string;
    opportunityId: string;
    to: OpportunityStatus;
    actorId: string | null;
    note?: string;
    now?: Date;
  },
  tx?: Prisma.TransactionClient,
): Promise<Opportunity> {
  const now = args.now ?? new Date();
  const client = tx ?? db;
  const current = await client.opportunity.findFirst({
    where: { id: args.opportunityId, companyId: args.companyId },
  });
  if (!current) throw new OpportunityError('Opportunity not found.', 404);
  if (!canTransition(current.status, args.to)) {
    throw new OpportunityError(
      `An opportunity that is ${current.status.toLowerCase()} cannot be marked ${args.to.toLowerCase()}.`,
      409,
    );
  }

  const stamp: Prisma.OpportunityUpdateManyMutationInput = {
    status: args.to,
    statusChangedAt: now,
  };
  if (args.to === 'REVIEWED') {
    stamp.reviewedAt = now;
    if (current.status === 'REJECTED') {
      // Reopened: the earlier decision no longer stands.
      Object.assign(stamp, {
        decidedAt: null,
        decidedById: null,
        decisionNote: null,
      });
    }
  }
  if (args.to === 'RECOMMENDED') stamp.recommendedAt = now;
  if (args.to === 'ACCEPTED' || args.to === 'REJECTED') {
    Object.assign(stamp, {
      decidedAt: now,
      decidedById: args.actorId,
      decisionNote: args.note ?? null,
    });
  }
  if (args.to === 'EXPIRED') stamp.expiredAt = now;

  const apply = async (tx: Prisma.TransactionClient) => {
    const swapped = await tx.opportunity.updateMany({
      where: { id: current.id, status: current.status },
      data: stamp,
    });
    if (swapped.count === 0) {
      throw new OpportunityError(
        'Someone else updated this opportunity first. Reload to see its status.',
        409,
      );
    }
    await tx.opportunityEvent.create({
      data: {
        opportunityId: current.id,
        fromStatus: current.status,
        toStatus: args.to,
        actorId: args.actorId,
        note: args.note ?? null,
        createdAt: now,
      },
    });
    // A decision on the opportunity is the decision on its open
    // recommendation too (lib/recommendations.ts STATUS SYNC).
    const mirrored = OPPORTUNITY_TO_RECOMMENDATION[args.to];
    if (mirrored) {
      await mirrorOntoRecommendations(tx, {
        opportunityId: current.id,
        to: mirrored,
        actorId: args.actorId,
        note: args.note ?? 'Decided on the opportunity.',
        now,
      });
    }
    return tx.opportunity.findUniqueOrThrow({ where: { id: current.id } });
  };
  return tx ? apply(tx) : db.$transaction(apply);
}

/**
 * Carry an opportunity's decision onto its recommendation still waiting for
 * one, with the same history a direct decision would leave.
 */
async function mirrorOntoRecommendations(
  tx: Prisma.TransactionClient,
  args: {
    opportunityId: string;
    to: RecommendationStatus;
    actorId: string | null;
    note: string;
    now: Date;
  },
) {
  const open = await tx.recommendation.findMany({
    where: {
      opportunityId: args.opportunityId,
      status: { in: OPEN_RECOMMENDATION_STATUSES },
    },
    select: { id: true, status: true },
  });
  for (const r of open) {
    const swapped = await tx.recommendation.updateMany({
      where: { id: r.id, status: r.status },
      data: {
        status: args.to,
        statusChangedAt: args.now,
        ...(args.to === 'EXPIRED'
          ? { expiredAt: args.now }
          : {
              decidedAt: args.now,
              decidedById: args.actorId,
              decisionNote: args.note,
            }),
      },
    });
    if (swapped.count === 0) continue;
    await tx.recommendationEvent.create({
      data: {
        recommendationId: r.id,
        fromStatus: r.status,
        toStatus: args.to,
        action: ACTION_FOR_STATUS[args.to],
        source: 'opportunity',
        actorId: args.actorId,
        note: args.note,
        createdAt: args.now,
      },
    });
  }
}

/** Expire every open opportunity whose relevance window has passed. */
export async function expireOpportunities(
  companyId: string,
  now: Date = new Date(),
): Promise<number> {
  const due = await db.opportunity.findMany({
    where: {
      companyId,
      status: { in: ACTIVE_STATUSES },
      relevantUntil: { lte: now },
    },
    select: { id: true, status: true },
  });
  if (!due.length) return 0;
  return db.$transaction(async (tx) => {
    let expired = 0;
    for (const o of due) {
      // Same compare-and-swap: one decided a moment ago is not expired.
      const r = await tx.opportunity.updateMany({
        where: { id: o.id, status: o.status },
        data: { status: 'EXPIRED', statusChangedAt: now, expiredAt: now },
      });
      if (r.count === 0) continue;
      expired += 1;
      await tx.opportunityEvent.create({
        data: {
          opportunityId: o.id,
          fromStatus: o.status,
          toStatus: 'EXPIRED',
          note: 'Its relevance window passed before anyone acted on it.',
          createdAt: now,
        },
      });
      await mirrorOntoRecommendations(tx, {
        opportunityId: o.id,
        to: 'EXPIRED',
        actorId: null,
        note: 'Its opportunity expired before a decision.',
        now,
      });
    }
    return expired;
  });
}

/** Opportunities for a workspace, open ones first by priority. Expires stale ones first. */
export async function listOpportunities(
  companyId: string,
  options: { status?: OpportunityStatus[]; limit?: number; now?: Date } = {},
) {
  await expireOpportunities(companyId, options.now);
  const rows = await db.opportunity.findMany({
    where: {
      companyId,
      ...(options.status ? { status: { in: options.status } } : {}),
    },
    include: {
      signals: { orderBy: { createdAt: 'asc' } },
      _count: { select: { events: true } },
    },
    orderBy: [{ priorityScore: 'desc' }, { detectedAt: 'desc' }],
    take: options.limit ?? 50,
  });
  const active = (s: OpportunityStatus) =>
    ACTIVE_STATUSES.includes(s) ? 0 : 1;
  return rows.sort((a, b) => active(a.status) - active(b.status));
}

/**
 * Every opportunity for the Opportunities view: evidence with the normalised
 * signal it came through (so it can be traced to its source), and its full
 * lifecycle history. Expired ones are expired first, so the view never shows
 * an open opportunity whose moment has passed.
 */
export async function listOpportunitiesForView(
  companyId: string,
  options: { now?: Date; limit?: number } = {},
) {
  await expireOpportunities(companyId, options.now);
  return db.opportunity.findMany({
    where: { companyId },
    include: {
      signals: {
        orderBy: { createdAt: 'asc' },
        include: {
          signal: {
            select: {
              source: true,
              reliability: true,
              reliabilityReason: true,
              occurrences: true,
              expiresAt: true,
            },
          },
        },
      },
      events: { orderBy: { createdAt: 'asc' } },
    },
    orderBy: [{ detectedAt: 'desc' }],
    take: options.limit ?? 200,
  });
}

/** One opportunity with its evidence, full lifecycle history and recommendations. */
export async function getOpportunity(companyId: string, opportunityId: string) {
  return db.opportunity.findFirst({
    where: { id: opportunityId, companyId },
    include: {
      signals: { orderBy: { createdAt: 'asc' } },
      events: { orderBy: { createdAt: 'asc' } },
      recommendations: {
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, title: true, createdAt: true },
      },
    },
  });
}

/** Opportunities a given underlying record supports — signal → opportunity. */
export async function opportunitiesForSignal(
  companyId: string,
  kind: SignalInput['kind'],
  refId: string,
) {
  return db.opportunity.findMany({
    where: { companyId, signals: { some: { kind, refId } } },
    orderBy: { detectedAt: 'desc' },
  });
}

/**
 * Whether this opportunity is the workspace's. Another business's id answers
 * exactly like one that does not exist (docs/DATA-ACCESS-SECURITY.md).
 */
export async function opportunityBelongsTo(
  companyId: string,
  opportunityId: string,
): Promise<boolean> {
  const found = await db.opportunity.findFirst({
    where: { id: opportunityId, companyId },
    select: { id: true },
  });
  return found !== null;
}
