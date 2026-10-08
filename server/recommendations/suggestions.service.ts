import { db } from '@/lib/db';
import { toSuggestion, type SuggestionView } from '@/lib/aura-suggests';
import { OPEN_RECOMMENDATION_STATUSES } from '@/lib/recommendations';
import { surfaceRecommendations } from './ranking.service';
import { qualityFor } from './quality.service';
import { heldBackReason } from '@/lib/recommendation-quality';

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
): Promise<{
  suggestions: SuggestionView[];
  accepted: SuggestionView[];
  /** Waiting suggestions that failed a quality check: not shown, with why. */
  heldBack: { id: string; title: string; reason: string; problems: string[] }[];
}> {
  const now = options.now ?? new Date();
  const ranked = await surfaceRecommendations(companyId, { now });
  if (ranked.length === 0)
    return { suggestions: [], accepted: [], heldBack: [] };

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
  // Quality checks run here — before anything is presented. A waiting
  // suggestion that fails one is held back, not shown as trusted; one with
  // warnings is shown marked "needs review" with what to check.
  const quality = await qualityFor(
    companyId,
    views.map((v) => v.id),
    now,
  );
  const heldBack: {
    id: string;
    title: string;
    reason: string;
    problems: string[];
  }[] = [];
  const shown: SuggestionView[] = [];
  for (const v of views) {
    const q = quality.get(v.id);
    const open = OPEN_RECOMMENDATION_STATUSES.includes(v.status);
    if (q?.verdict === 'blocked' && open) {
      heldBack.push({
        id: v.id,
        title: v.what,
        reason: heldBackReason(q),
        problems: q.problems,
      });
      continue;
    }
    shown.push(
      q
        ? {
            ...v,
            quality: {
              verdict: q.verdict === 'trusted' ? 'trusted' : 'needs_review',
              warnings:
                q.verdict === 'trusted' ? [] : [...q.problems, ...q.warnings],
            },
          }
        : v,
    );
  }
  const limit = options.limit ?? 20;
  return {
    suggestions: shown
      .filter((v) => OPEN_RECOMMENDATION_STATUSES.includes(v.status))
      .slice(0, limit),
    accepted: shown.filter((v) => v.stage === 'accepted').slice(0, limit),
    heldBack,
  };
}
