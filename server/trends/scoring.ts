import type {
  ScoredTrendItem,
  TrendFetchContext,
  TrendItem,
} from '@/server/trends/types';

/**
 * Trend scoring — a PURE function (no I/O), so it's trivially unit-testable
 * with fixture data. Each item gets a 0–100 score combining three signals:
 *
 *   • recency    — exponential time decay (fresh items rank higher)
 *   • engagement — log-scaled upvotes/points + comments (where a source has them)
 *   • relevance  — keyword-match strength + competitor-mention boost
 *
 * The weights and half-life are the two knobs future sprints will tune; they're
 * named constants here. `now` is injected so scoring is deterministic in tests.
 */
export const SCORING = {
  weights: { recency: 0.35, engagement: 0.3, relevance: 0.35 },
  recencyHalfLifeHours: 24,
  // Engagement above this (points + 2×comments) is treated as "maxed out".
  engagementSaturation: 500,
} as const;

/** Exponential decay in [0,1]; 1.0 at age 0, 0.5 at one half-life. */
function recencyScore(publishedAt: string, now: number): number {
  const ageMs = now - new Date(publishedAt).getTime();
  if (!Number.isFinite(ageMs)) return 0;
  const ageHours = Math.max(0, ageMs / 3_600_000);
  return 0.5 ** (ageHours / SCORING.recencyHalfLifeHours);
}

/** Log-scaled engagement in [0,1]. Sources with no metrics score a neutral 0. */
function engagementScore(item: TrendItem): number {
  const points = item.engagement.points ?? 0;
  const comments = item.engagement.comments ?? 0;
  const raw = points + 2 * comments;
  if (raw <= 0) return 0;
  // log1p scaling so a few hundred points ~ near saturation without domination.
  return Math.min(1, Math.log1p(raw) / Math.log1p(SCORING.engagementSaturation));
}

/** Keyword-match + competitor-mention relevance in [0,1]. */
function relevanceScore(item: TrendItem, ctx: TrendFetchContext): number {
  const matches = item.matchedKeywords.length;
  // Diminishing returns after ~3 distinct keyword matches.
  let score = Math.min(1, matches / 3);

  const haystack = `${item.title} ${item.summary ?? ''}`.toLowerCase();
  const competitorHit = ctx.competitorNames.some(
    (name) => name && haystack.includes(name.toLowerCase()),
  );
  if (competitorHit) score = Math.min(1, score + 0.25); // competitor news is high-signal

  // A title-level keyword hit is stronger than a body-only hit.
  const titleHit = item.matchedKeywords.some((k) =>
    item.title.toLowerCase().includes(k),
  );
  if (titleHit) score = Math.min(1, score + 0.1);

  return score;
}

/** Score a single item, returning the value + per-signal breakdown. */
export function scoreItem(
  item: TrendItem,
  ctx: TrendFetchContext,
  now: number = Date.now(),
): ScoredTrendItem {
  const recency = recencyScore(item.publishedAt, now);
  const engagement = engagementScore(item);
  const relevance = relevanceScore(item, ctx);
  const { weights } = SCORING;
  const composite =
    weights.recency * recency +
    weights.engagement * engagement +
    weights.relevance * relevance;

  return {
    ...item,
    score: Math.round(composite * 1000) / 10, // 0–100, one decimal
    scoreBreakdown: {
      recency: Math.round(recency * 100) / 100,
      engagement: Math.round(engagement * 100) / 100,
      relevance: Math.round(relevance * 100) / 100,
    },
  };
}

/** Remove duplicates by id and by normalized title (cross-source dupes). */
export function dedupe(items: TrendItem[]): TrendItem[] {
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  const out: TrendItem[] = [];
  for (const item of items) {
    const titleKey = item.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seenIds.has(item.id) || seenTitles.has(titleKey)) continue;
    seenIds.add(item.id);
    seenTitles.add(titleKey);
    out.push(item);
  }
  return out;
}

/**
 * Dedupe, score, and return the top `limit` items in descending score order.
 * Ties break by recency (newer first) for stable, sensible ordering.
 */
export function scoreAndRank(
  items: TrendItem[],
  ctx: TrendFetchContext,
  options: { limit?: number; now?: number } = {},
): ScoredTrendItem[] {
  const { limit = 8, now = Date.now() } = options;
  const scored = dedupe(items).map((item) => scoreItem(item, ctx, now));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );
  });
  return scored.slice(0, limit);
}
