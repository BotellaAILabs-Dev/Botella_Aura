import { getJson } from '@/lib/http';
import { logger } from '@/lib/logger';
import type { TrendFetchContext, TrendItem, TrendSource } from '@/server/trends/types';

/**
 * Hacker News connector — official Firebase API (https://github.com/HackerNews/API).
 *
 * No auth required, no documented hard rate limit, but we stay polite: one call
 * for the top-story index, then a bounded number of item lookups. We fetch the
 * top ~120 stories and keep those whose title matches a configured keyword.
 */
const HN_BASE = 'https://hacker-news.firebaseio.com/v0';
const MAX_STORIES_SCANNED = 120; // bound the item lookups (polite + fast)
const CONCURRENCY = 12;

interface HnItem {
  id: number;
  title?: string;
  url?: string;
  score?: number;
  descendants?: number; // comment count
  by?: string;
  time?: number; // unix seconds
  type?: string;
}

export class HackerNewsSource implements TrendSource {
  readonly id = 'hackernews' as const;
  readonly label = 'Hacker News';

  isConfigured(): boolean {
    return true; // keyless public API
  }

  async fetchTrendItems(ctx: TrendFetchContext): Promise<TrendItem[]> {
    const keywords = ctx.keywords.map((k) => k.toLowerCase()).filter(Boolean);
    if (keywords.length === 0) return [];

    let ids: number[];
    try {
      ids = await getJson<number[]>(`${HN_BASE}/topstories.json`, {
        timeoutMs: 8000,
      });
    } catch (err) {
      logger.warn('HackerNews: failed to load top stories', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    const scan = ids.slice(0, MAX_STORIES_SCANNED);
    const items: TrendItem[] = [];

    // Fetch item details in small concurrent batches.
    for (let i = 0; i < scan.length; i += CONCURRENCY) {
      const batch = scan.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((id) =>
          getJson<HnItem>(`${HN_BASE}/item/${id}.json`, { timeoutMs: 6000 }),
        ),
      );
      for (const r of results) {
        if (r.status !== 'fulfilled' || !r.value?.title) continue;
        const hn = r.value;
        const haystack = hn.title!.toLowerCase();
        const matched = keywords.filter((k) => haystack.includes(k));
        if (matched.length === 0) continue;

        items.push({
          id: `hackernews:${hn.id}`,
          source: 'hackernews',
          sourceLabel: 'Hacker News',
          title: hn.title!,
          url: hn.url ?? `https://news.ycombinator.com/item?id=${hn.id}`,
          author: hn.by,
          publishedAt: new Date((hn.time ?? 0) * 1000).toISOString(),
          engagement: { points: hn.score, comments: hn.descendants },
          matchedKeywords: matched,
        });
      }
    }

    return items;
  }
}
