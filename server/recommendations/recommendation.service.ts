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
import { LOW_CONFIDENCE_BLOCKER, executability } from '@/lib/recommendation-rules';
import { engineContext } from '@/lib/recommendation-engine';
import {
  ACCEPTED_RECOMMENDATION_STATUSES,
  ACTION_FOR_STATUS,
  EDITABLE_FIELDS,
  OPEN_RECOMMENDATION_STATUSES,
  diffEdit,
  recommendationOutcome,
  type EditableField,
  type EventSource,
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
import { getContextSnapshot } from '@/server/business-context/snapshot.service';
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
  /** Guardrail outcome (lib/recommendation-rules.ts): advice vs. executable. */
  guardrails?: { executable: boolean; blockers: string[]; flags: string[] };
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
        ...(args.guardrails ?? {}),
        companyId: args.companyId,
        handoff: handoff as unknown as Prisma.InputJsonObject,
        createdBy: args.createdBy.slice(0, 100),
        createdAt: now,
        statusChangedAt: now,
        evidence: { create: evidence },
        events: {
          create: {
            fromStatus: null,
            toStatus: 'GENERATED',
            action: 'generate',
            source: args.createdBy.startsWith('user:') ? 'user' : 'engine',
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

const label = (status: string) => status.toLowerCase().replace('_', ' ');

/**
 * Move a recommendation through its lifecycle (lib/recommendations.ts),
 * recording what was done, by whom, from where, when, and with what detail.
 *
 * DUPLICATE TRANSITIONS are prevented three ways:
 *   · repeating the move it is already in (a double click, a retried
 *     request) changes nothing and records nothing — `changed: false`;
 *   · `expectedStatus` — the status the person was looking at — must still
 *     be current, so an action taken on a stale screen is refused, not
 *     applied to something that has since moved on;
 *   · compare-and-swap on the status, so two simultaneous decisions cannot
 *     both win.
 *
 * Accepting, editing or rejecting is the same decision on its opportunity,
 * in the same transaction.
 */
export async function transitionRecommendation(args: {
  companyId: string;
  recommendationId: string;
  to: RecommendationStatus;
  actorId: string | null;
  note?: string;
  now?: Date;
  /** Who did it; a person when there is an actor, the system otherwise. */
  source?: EventSource;
  /** The status the caller last saw. */
  expectedStatus?: RecommendationStatus;
  /** Detail stored on the history entry. */
  metadata?: Record<string, unknown>;
}) {
  const now = args.now ?? new Date();
  const source: EventSource = args.source ?? (args.actorId ? 'user' : 'system');
  return db.$transaction(async (tx) => {
    const current = await tx.recommendation.findFirst({
      where: { id: args.recommendationId, companyId: args.companyId },
      include: { opportunity: { select: { id: true, status: true } } },
    });
    if (!current) throw new OpportunityError('Recommendation not found.', 404);
    const unchanged = async () =>
      Object.assign(
        await tx.recommendation.findUniqueOrThrow({
          where: { id: current.id },
          include: withDetail,
        }),
        { changed: false },
      );

    // Already there: a repeat, not a new action.
    if (current.status === args.to && args.to !== 'EDITED') return unchanged();
    if (args.expectedStatus && current.status !== args.expectedStatus) {
      throw new OpportunityError(
        `This recommendation changed since you opened it — it is now ${label(current.status)}. Reload to see it.`,
        409,
      );
    }
    if (!canTransitionRecommendation(current.status, args.to)) {
      throw new OpportunityError(
        `A recommendation that is ${label(current.status)} cannot be marked ${label(args.to)}.`,
        409,
      );
    }
    // Accepting (as is or edited) is the review a low-confidence
    // recommendation needs; any other blocker (an unused channel, an
    // unavailable integration) stays.
    const reviewed = ACCEPTED_RECOMMENDATION_STATUSES.includes(args.to);
    const blockers = reviewed
      ? current.blockers.filter((b) => b !== LOW_CONFIDENCE_BLOCKER)
      : current.blockers;
    // Advice is not a task: nothing blocked can be started or completed.
    if ((args.to === 'IN_PROGRESS' || args.to === 'COMPLETED') && blockers.length) {
      throw new OpportunityError(
        `This recommendation cannot be acted on yet: ${blockers.join(' ')}`,
        409,
      );
    }

    const stamp: Prisma.RecommendationUpdateManyMutationInput = {
      status: args.to,
      statusChangedAt: now,
    };
    if (['ACCEPTED', 'EDITED', 'SKIPPED', 'REJECTED', 'WITHDRAWN'].includes(args.to)) {
      Object.assign(stamp, {
        decidedAt: now,
        decidedById: args.actorId,
        decisionNote: args.note ?? null,
      });
    }
    if (reviewed && blockers.length !== current.blockers.length) {
      stamp.blockers = blockers;
      stamp.executable = blockers.length === 0;
    }
    if (args.to === 'PRESENTED' && !current.presentedAt) stamp.presentedAt = now;
    if (args.to === 'EDITED') stamp.editedAt = now;
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
        action: ACTION_FOR_STATUS[args.to],
        source,
        actorId: args.actorId,
        note: args.note ?? null,
        metadata: (args.metadata ?? {}) as Prisma.InputJsonObject,
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
          note: args.note ?? `Recommendation ${label(args.to)}.`,
          now,
        },
        tx,
      );
    }
    return Object.assign(
      await tx.recommendation.findUniqueOrThrow({
        where: { id: current.id },
        include: withDetail,
      }),
      { changed: true },
    );
  });
}

/** Accept, skip, reject or withdraw — the decisions on a recommendation. */
export function decideRecommendation(args: {
  companyId: string;
  recommendationId: string;
  decision: 'ACCEPTED' | 'SKIPPED' | 'REJECTED' | 'WITHDRAWN';
  actorId: string | null;
  note?: string;
  now?: Date;
  expectedStatus?: RecommendationStatus;
}) {
  const { decision, ...rest } = args;
  return transitionRecommendation({ ...rest, to: decision });
}

/**
 * PRESENTED: these recommendations were shown to a person. Idempotent — only
 * ones never shown before move (and are recorded, with where and at what
 * rank); showing one again changes nothing.
 */
export async function presentRecommendations(args: {
  companyId: string;
  recommendationIds: string[];
  actorId: string | null;
  /** Where they were shown, and each one's position there. */
  surface?: string;
  positions?: Record<string, { rank?: number; score?: number; band?: string }>;
  now?: Date;
}): Promise<{ presented: string[]; alreadyPresented: string[] }> {
  const now = args.now ?? new Date();
  const ids = [...new Set(args.recommendationIds)].slice(0, 100);
  const rows = await db.recommendation.findMany({
    where: { companyId: args.companyId, id: { in: ids } },
    select: { id: true, status: true },
  });
  const presented: string[] = [];
  const alreadyPresented: string[] = [];
  for (const r of rows) {
    if (r.status !== 'GENERATED') {
      alreadyPresented.push(r.id);
      continue;
    }
    try {
      const result = await transitionRecommendation({
        companyId: args.companyId,
        recommendationId: r.id,
        to: 'PRESENTED',
        actorId: args.actorId,
        source: 'user',
        now,
        metadata: {
          ...(args.surface ? { surface: args.surface } : {}),
          ...(args.positions?.[r.id] ?? {}),
        },
      });
      (result.changed ? presented : alreadyPresented).push(r.id);
    } catch {
      // Decided or presented a moment ago by someone else.
      alreadyPresented.push(r.id);
    }
  }
  return { presented, alreadyPresented };
}

/**
 * EDITED: a person changed the recommendation — and by doing so accepted it,
 * with changes. Each changed field is recorded from → to in its history, so
 * the original is never lost. Editing again records the new changes; an edit
 * that changes nothing changes nothing (no history entry). Guardrails are
 * re-applied: a channel the business does not use still blocks execution.
 */
export async function editRecommendation(args: {
  companyId: string;
  recommendationId: string;
  changes: Partial<Record<EditableField, unknown>>;
  actorId: string | null;
  note?: string;
  expectedStatus?: RecommendationStatus;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const current = await db.recommendation.findFirst({
    where: { id: args.recommendationId, companyId: args.companyId },
  });
  if (!current) throw new OpportunityError('Recommendation not found.', 404);
  if (args.expectedStatus && current.status !== args.expectedStatus) {
    throw new OpportunityError(
      `This recommendation changed since you opened it — it is now ${label(current.status)}. Reload to see it.`,
      409,
    );
  }
  if (!canTransitionRecommendation(current.status, 'EDITED')) {
    throw new OpportunityError(
      `A recommendation that is ${label(current.status)} cannot be edited.`,
      409,
    );
  }

  const before = Object.fromEntries(
    EDITABLE_FIELDS.map((f) => [f, current[f]]),
  ) as Record<EditableField, unknown>;
  // Validated as a whole recommendation, so an edit cannot leave it invalid.
  const merged = recommendationContentSchema.parse({
    type: current.type,
    ...before,
    details: current.details ?? {},
    ...args.changes,
  });
  const after = Object.fromEntries(
    EDITABLE_FIELDS.filter((f) => f in args.changes).map((f) => [f, merged[f]]),
  ) as Partial<Record<EditableField, unknown>>;
  const changes = diffEdit(before, after);
  if (Object.keys(changes).length === 0) {
    const same = await getRecommendation(args.companyId, current.id);
    return Object.assign(same!, { changed: false });
  }

  // Re-apply the channel guardrail; low confidence is cleared by the edit
  // itself (a person reviewed it).
  const snap = await getContextSnapshot(args.companyId, {
    view: 'recommendation',
    now,
  });
  const ctx = snap ? engineContext(snap.snapshot) : { publishesOn: [], connected: [] };
  const guard = executability({
    type: merged.type,
    channel: merged.channel ?? null,
    confidence: 'MEDIUM',
    ctx: { publishesOn: ctx.publishesOn, connected: ctx.connected },
  });

  await db.recommendation.update({
    where: { id: current.id },
    data: {
      ...(after as Prisma.RecommendationUpdateInput),
      blockers: guard.blockers,
      executable: guard.executable,
    },
  });
  // The status move (and its history entry, with the field changes) goes
  // through the same transition as every other action.
  return transitionRecommendation({
    companyId: args.companyId,
    recommendationId: current.id,
    to: 'EDITED',
    actorId: args.actorId,
    note: args.note,
    now,
    metadata: { changes },
  });
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
    where: {
      companyId,
      status: { in: OPEN_RECOMMENDATION_STATUSES },
      relevantUntil: { lte: now },
    },
    select: { id: true },
  });
  let expired = 0;
  for (const r of due) {
    try {
      const result = await transitionRecommendation({
        companyId,
        recommendationId: r.id,
        to: 'EXPIRED',
        actorId: null,
        source: 'system',
        note: 'Its relevance window passed before a decision.',
        now,
      });
      if (result.changed) expired += 1;
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

/**
 * The full history of one recommendation, oldest first, with who did each
 * thing named. `outcome` is how the business answered it — what Aura learns
 * from: accepted, edited (accepted with changes), skipped, rejected, or
 * undecided.
 */
export async function getRecommendationHistory(
  companyId: string,
  recommendationId: string,
) {
  const r = await db.recommendation.findFirst({
    where: { id: recommendationId, companyId },
    select: {
      id: true,
      status: true,
      createdAt: true,
      presentedAt: true,
      decidedAt: true,
      decidedById: true,
      editedAt: true,
      startedAt: true,
      completedAt: true,
      expiredAt: true,
      events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  });
  if (!r) return null;
  const actorIds = [
    ...new Set(r.events.map((e) => e.actorId).filter((x): x is string => !!x)),
  ];
  const actors = actorIds.length
    ? await db.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const nameOf = new Map(actors.map((u) => [u.id, u.name || u.email]));
  const { events, ...timestamps } = r;
  return {
    recommendationId: r.id,
    status: r.status,
    outcome: recommendationOutcome(events.map((e) => e.toStatus)),
    timestamps,
    events: events.map((e) => ({
      ...e,
      actorName: e.actorId ? (nameOf.get(e.actorId) ?? null) : null,
    })),
  };
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
