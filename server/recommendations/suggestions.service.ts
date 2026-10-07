import { db } from '@/lib/db';
import { toSuggestion, type SuggestionView } from '@/lib/aura-suggests';
import { OPEN_RECOMMENDATION_STATUSES } from '@/lib/recommendations';
import { surfaceRecommendations } from './ranking.service';

/**
 * "Aura Suggests": the workspace's recommendations in the order to surface
 * them (ranking.service.ts), each as a person reads it (lib/aura-suggests.ts).
 *
 *   suggestions  still waiting for an answer, best first
 *   accepted     already a yes (as is or edited), not yet started — so the
 *                next step stays one click away
 *
 * Deferred ("Not now") ones are left out until they come back.
 */
export async function getSuggestions(
  companyId: string,
  options: { now?: Date; limit?: number } = {},
): Promise<{ suggestions: SuggestionView[]; accepted: SuggestionView[] }> {
  const now = options.now ?? new Date();
  const ranked = await surfaceRecommendations(companyId, { now });
  if (ranked.length === 0) return { suggestions: [], accepted: [] };

  const rows = await db.recommendation.findMany({
    where: { companyId, id: { in: ranked.map((r) => r.id) } },
    include: {
      evidence: {
        include: { signal: { select: { expiresAt: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const views = ranked.flatMap((x) => {
    const r = byId.get(x.id);
    if (!r) return [];
    return [
      toSuggestion(
        {
          ...r,
          evidence: r.evidence.map((e) => ({
            id: e.id,
            kind: e.kind,
            label: e.label,
            detail: e.detail,
            url: e.url,
            observedAt: e.observedAt ?? e.createdAt,
            // Current while its signal is; older copies with no link count
            // as current, as in the ranking.
            current:
              !e.signalId ||
              Boolean(
                e.signal &&
                (e.signal.expiresAt === null || e.signal.expiresAt > now),
              ),
          })),
        },
        x,
        now,
      ),
    ];
  });
  const limit = options.limit ?? 20;
  return {
    suggestions: views
      .filter((v) => OPEN_RECOMMENDATION_STATUSES.includes(v.status))
      .slice(0, limit),
    accepted: views.filter((v) => v.stage === 'accepted').slice(0, limit),
  };
}
