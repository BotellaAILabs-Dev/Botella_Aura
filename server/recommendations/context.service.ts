import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import {
  AURA_MODULES,
  moduleHandoff,
  type AuraModuleId,
  type ModuleHandoffs,
} from '@/lib/aura-modules';
import {
  toRecommendationContext,
  type RecommendationContext,
} from '@/lib/recommendation-context';

/**
 * Recommendation context across modules (lib/recommendation-context.ts).
 *
 *   getRecommendationContext   what a module (and the context bar) shows for
 *                              `?rec=<id>` — scoped to the workspace
 *   linkRecommendation         a module picked the recommendation up and made
 *                              something from it: recorded on the thing made
 *                              by the module, and here in the recommendation's
 *                              history (action "link"), so either side leads
 *                              back to the other. The status does not change:
 *                              carrying it out is the execution sprint's job.
 */

export async function getRecommendationContext(
  companyId: string,
  recommendationId: string,
): Promise<RecommendationContext | null> {
  const r = await db.recommendation.findFirst({
    where: { id: recommendationId, companyId },
    include: {
      evidence: { orderBy: { createdAt: 'asc' }, select: { label: true } },
    },
  });
  return r ? toRecommendationContext(r) : null;
}

/** A recommendation's id, if it is this workspace's — never trust one from a client as-is. */
export async function ownRecommendation(
  companyId: string,
  recommendationId: string | null | undefined,
): Promise<{ id: string; title: string } | null> {
  if (!recommendationId) return null;
  return db.recommendation.findFirst({
    where: { id: recommendationId, companyId },
    select: { id: true, title: true },
  });
}

export async function linkRecommendation(args: {
  companyId: string;
  recommendationId: string;
  module: AuraModuleId;
  /** What the module made, e.g. { type: 'content-draft', id, label }. */
  created: { type: string; id: string; label: string | null };
  actorId: string | null;
  now?: Date;
}): Promise<boolean> {
  const r = await db.recommendation.findFirst({
    where: { id: args.recommendationId, companyId: args.companyId },
    select: { id: true, status: true },
  });
  if (!r) return false;
  await db.recommendationEvent.create({
    data: {
      recommendationId: r.id,
      fromStatus: r.status,
      toStatus: r.status,
      action: 'link',
      source: args.actorId ? 'user' : 'system',
      actorId: args.actorId,
      note: `${AURA_MODULES[args.module].label}: ${args.created.label ?? args.created.type} created from this suggestion.`,
      metadata: {
        module: args.module,
        created: args.created,
      } as Prisma.InputJsonObject,
      createdAt: args.now ?? new Date(),
    },
  });
  return true;
}

/**
 * What one module receives from a recommendation (lib/aura-modules.ts) — the
 * contract a creation or execution workflow consumes. Null when the
 * recommendation is not this workspace's.
 */
export async function getRecommendationHandoff<M extends AuraModuleId>(
  companyId: string,
  recommendationId: string,
  module: M,
): Promise<{ id: string; title: string; handoff: ModuleHandoffs[M] } | null> {
  const r = await db.recommendation.findFirst({
    where: { id: recommendationId, companyId },
  });
  return r
    ? { id: r.id, title: r.title, handoff: moduleHandoff(module, r) }
    : null;
}
