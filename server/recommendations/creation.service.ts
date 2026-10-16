import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { routeRecommendation, type AuraModuleId } from '@/lib/aura-modules';
import type { ContextHandoff } from '@/lib/recommendation-context-handoff';
import {
  creationPlan,
  creationProvenance,
  type CreationPlan,
  type CreationProvenance,
} from '@/lib/recommendation-creation';
import type {
  RecommendationStatus,
  RecommendationType,
} from '@/lib/recommendations';
import { OpportunityError } from '@/server/opportunities/opportunity.service';
import { getContextHandoff } from '@/server/recommendations/context-handoff.service';
import { linkRecommendation } from '@/server/recommendations/context.service';
import {
  decideRecommendation,
  transitionRecommendation,
} from '@/server/recommendations/recommendation.service';

/**
 * Recommendation → creation, on the server (lib/recommendation-creation.ts
 * holds the rules). Three steps every creation workflow shares:
 *
 *   getCreation     what creating from it means, with its full Context Handoff
 *   startCreation   say yes on the way if it is still open; refuse — with the
 *                   reason and where to fix it — when it cannot be created from
 *   recordCreation  link what was made to it and mark it in progress
 *
 * Every lookup is scoped to the workspace: another workspace's recommendation
 * is simply not found.
 */

export interface Creation {
  plan: CreationPlan;
  handoff: ContextHandoff;
  /** What anything created from it keeps (null when it cannot be created from). */
  provenance: CreationProvenance | null;
  /** The other modules it is carried out in (routeRecommendation). */
  related: AuraModuleId[];
}

export async function getCreation(
  companyId: string,
  recommendationId: string,
  module?: AuraModuleId,
): Promise<Creation | null> {
  const r = await db.recommendation.findFirst({
    where: { id: recommendationId, companyId },
  });
  if (!r) return null;
  const handoff = await getContextHandoff(companyId, r.id);
  if (!handoff) return null;
  const routable = {
    ...r,
    type: r.type as RecommendationType,
    status: r.status as RecommendationStatus,
  };
  const plan = creationPlan(routable, { ...(module ? { module } : {}), handoff });
  return {
    plan,
    handoff,
    provenance: plan.canCreate ? creationProvenance(handoff) : null,
    related: routeRecommendation(routable).related.map((d) => d.module),
  };
}

/**
 * Get ready to create: everything the workflow needs, with the suggestion
 * said yes to if it was still open. Throws a 409 with the plain reason when
 * it cannot be created from (and 404 when it is not this workspace's).
 */
export async function startCreation(args: {
  companyId: string;
  recommendationId: string;
  actorId: string;
  module?: AuraModuleId;
}): Promise<Creation> {
  const first = await getCreation(
    args.companyId,
    args.recommendationId,
    args.module,
  );
  if (!first) throw new OpportunityError('Recommendation not found.', 404);
  if (!first.plan.canCreate) {
    throw new OpportunityError(
      first.plan.message ?? 'There is nothing to create from this suggestion.',
      409,
    );
  }
  if (!first.plan.acceptsOnCreate) return first;

  await decideRecommendation({
    companyId: args.companyId,
    recommendationId: args.recommendationId,
    decision: 'ACCEPTED',
    actorId: args.actorId,
    note: `Said yes by creating from it in ${first.plan.moduleLabel}.`,
  });
  const accepted = await getCreation(
    args.companyId,
    args.recommendationId,
    args.module,
  );
  if (!accepted) throw new OpportunityError('Recommendation not found.', 404);
  return accepted;
}

/**
 * Something was created from the recommendation: the history records what and
 * where, and an accepted suggestion moves to in progress — work has started.
 * Creating a second piece from it is recorded the same way; it stays in
 * progress.
 */
export async function recordCreation(args: {
  companyId: string;
  recommendationId: string;
  module: AuraModuleId;
  created: { type: string; id: string; label: string | null };
  actorId: string | null;
}): Promise<void> {
  const linked = await linkRecommendation(args);
  if (!linked) return;
  const r = await db.recommendation.findFirst({
    where: { id: args.recommendationId, companyId: args.companyId },
    select: { status: true },
  });
  if (r?.status !== 'ACCEPTED' && r?.status !== 'EDITED') return;
  try {
    await transitionRecommendation({
      companyId: args.companyId,
      recommendationId: args.recommendationId,
      to: 'IN_PROGRESS',
      actorId: args.actorId,
      expectedStatus: r.status,
      note: `${args.created.label ?? args.created.type} created.`,
      metadata: { module: args.module, created: args.created },
    });
  } catch (err) {
    // The piece exists and is linked either way; a status race is not worth
    // failing the person's creation over.
    logger.warn('creation: could not mark the recommendation in progress', {
      recommendationId: args.recommendationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
