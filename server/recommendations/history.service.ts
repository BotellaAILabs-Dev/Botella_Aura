import { db } from '@/lib/db';
import { OPPORTUNITY_TYPE_INFO } from '@/lib/opportunities';
import {
  historyCounts,
  historyOutcome,
  learningCandidates,
  repeatHold,
  toHistoryEntry,
  type HistoryEntry,
  type HistoryOutcome,
  type LearningCandidate,
} from '@/lib/recommendation-history';
import { OPEN_RECOMMENDATION_STATUSES } from '@/lib/recommendations';

/**
 * Recommendation history (lib/recommendation-history.ts), from the
 * recommendations and their lifecycle events — newest decision first.
 */
export async function listRecommendationHistory(
  companyId: string,
  options: { outcome?: HistoryOutcome; limit?: number; now?: Date } = {},
): Promise<{
  entries: HistoryEntry[];
  counts: Record<HistoryOutcome | 'all', number>;
  learning: LearningCandidate[];
}> {
  const now = options.now ?? new Date();
  const rows = await db.recommendation.findMany({
    where: { companyId, status: { notIn: OPEN_RECOMMENDATION_STATUSES } },
    orderBy: [{ statusChangedAt: 'desc' }, { id: 'asc' }],
    take: 500,
    include: {
      opportunity: {
        select: { id: true, title: true, type: true, status: true },
      },
      events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  });
  const actorIds = [
    ...new Set(
      rows
        .flatMap((r) => r.events.map((e) => e.actorId))
        .filter((x): x is string => !!x),
    ),
  ];
  const people = actorIds.length
    ? await db.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const nameOf = new Map(
    people.map((u) => [u.id, u.name?.split(' ')[0] || u.email.split('@')[0]!]),
  );

  const all = rows.flatMap((r) => {
    const entry = toHistoryEntry(
      {
        ...r,
        opportunity: {
          id: r.opportunity.id,
          title: r.opportunity.title,
          typeLabel: OPPORTUNITY_TYPE_INFO[r.opportunity.type].label,
          status: r.opportunity.status,
        },
        events: r.events.map((e) => ({
          action: e.action,
          toStatus: e.toStatus,
          actorName: e.actorId ? (nameOf.get(e.actorId) ?? null) : null,
          source: e.source,
          createdAt: e.createdAt,
          metadata: e.metadata,
        })),
      },
      now,
    );
    return entry ? [{ entry, row: r }] : [];
  });

  const shown = options.outcome
    ? all.filter((x) => x.entry.outcome === options.outcome)
    : all;
  return {
    entries: shown.slice(0, options.limit ?? 100).map((x) => x.entry),
    counts: historyCounts(all.map((x) => x.entry)),
    learning: learningCandidates(
      all.map((x) => ({
        id: x.row.id,
        outcome: x.entry.outcome,
        channel: x.row.channel,
        details: x.row.details,
      })),
    ),
  };
}

/**
 * For each opportunity, whether its last answered suggestion holds it back
 * from being suggested again yet (repeatHold). Opportunities never suggested
 * are not in the map.
 */
export async function repeatHolds(
  companyId: string,
  opportunityIds: string[],
  now: Date = new Date(),
): Promise<Map<string, { held: boolean; text: string | null }>> {
  if (!opportunityIds.length) return new Map();
  const rows = await db.recommendation.findMany({
    where: {
      companyId,
      opportunityId: { in: opportunityIds },
      status: { notIn: OPEN_RECOMMENDATION_STATUSES },
    },
    orderBy: [{ statusChangedAt: 'desc' }],
    select: {
      opportunityId: true,
      status: true,
      decidedAt: true,
      expiredAt: true,
      events: { select: { toStatus: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  const out = new Map<string, { held: boolean; text: string | null }>();
  for (const r of rows) {
    if (out.has(r.opportunityId)) continue; // the latest one decides
    const outcome = historyOutcome(
      r.status,
      r.events.map((e) => e.toStatus),
    );
    if (!outcome) continue;
    const h = repeatHold(
      { outcome, decidedAt: r.decidedAt ?? r.expiredAt },
      now,
    );
    out.set(r.opportunityId, { held: h.held, text: h.text });
  }
  return out;
}
