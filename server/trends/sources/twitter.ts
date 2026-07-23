import { getJson } from '@/lib/http';
import { logger } from '@/lib/logger';
import type { TrendFetchContext, TrendItem, TrendSource } from '@/server/trends/types';

/**
 * X / Twitter connector — OFFICIAL API v2 recent-search only, behind a feature
 * flag. If TWITTER_BEARER_TOKEN is absent, `isConfigured` returns false: the
 * orchestrator skips this source and the UI shows a clear "not connected"
 * state. We NEVER scrape or fabricate tweets (NON-NEGOTIABLE #5).
 *
 * Rate limits vary sharply by API access tier; recent-search on lower tiers is
 * very limited. We issue ONE combined-query request per digest to conserve
 * quota, and comment this so future engineers don't fan out per keyword.
 */
const SEARCH_URL = 'https://api.twitter.com/2/tweets/search/recent';
const MAX_KEYWORDS_IN_QUERY = 5;

interface TwitterSearchResponse {
  data?: Array<{
    id: string;
    text: string;
    created_at?: string;
    author_id?: string;
    public_metrics?: {
      like_count?: number;
      reply_count?: number;
      retweet_count?: number;
      quote_count?: number;
    };
  }>;
}

export class TwitterSource implements TrendSource {
  readonly id = 'twitter' as const;
  readonly label = 'X / Twitter';

  isConfigured(ctx: TrendFetchContext): boolean {
    return Boolean(process.env.TWITTER_BEARER_TOKEN) && ctx.keywords.length > 0;
  }

  async fetchTrendItems(ctx: TrendFetchContext): Promise<TrendItem[]> {
    const token = process.env.TWITTER_BEARER_TOKEN;
    if (!token) return [];

    // Build ONE query: (kw1 OR kw2 ...) -is:retweet lang:en. One request/digest.
    const terms = ctx.keywords
      .slice(0, MAX_KEYWORDS_IN_QUERY)
      .map((k) => (k.includes(' ') ? `"${k}"` : k));
    if (terms.length === 0) return [];
    const query = `(${terms.join(' OR ')}) -is:retweet lang:en`;

    const url =
      `${SEARCH_URL}?query=${encodeURIComponent(query)}` +
      `&max_results=25&tweet.fields=public_metrics,created_at,author_id`;

    try {
      const res = await getJson<TwitterSearchResponse>(url, {
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: 8000,
      });
      const lowerKeywords = ctx.keywords.map((k) => k.toLowerCase());
      return (res.data ?? []).map((t) => {
        const m = t.public_metrics ?? {};
        const haystack = t.text.toLowerCase();
        return {
          id: `twitter:${t.id}`,
          source: 'twitter' as const,
          sourceLabel: 'X / Twitter',
          title: t.text.slice(0, 200),
          url: `https://x.com/i/web/status/${t.id}`,
          author: t.author_id,
          publishedAt: t.created_at ?? new Date().toISOString(),
          engagement: {
            points: (m.like_count ?? 0) + (m.retweet_count ?? 0),
            comments: m.reply_count,
          },
          matchedKeywords: lowerKeywords.filter((k) => haystack.includes(k)),
        };
      });
    } catch (err) {
      logger.warn('Twitter: recent search failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}
