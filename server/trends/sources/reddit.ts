import { getJson, httpRequest } from '@/lib/http';
import { logger } from '@/lib/logger';
import type { TrendFetchContext, TrendItem, TrendSource } from '@/server/trends/types';

/**
 * Reddit connector — official Reddit API, read-only, app-only ("client
 * credentials") OAuth. No user login, no scraping, no unofficial endpoints.
 *
 * Rate limit: Reddit allows 100 queries/minute per OAuth client ID, averaged
 * over a 10-minute window (https://support.reddithelp.com/hc/en-us/articles/16160319875092).
 * We stay well under it: one token fetch (cached until expiry) plus one listing
 * request per configured subreddit, bounded by MAX_SUBREDDITS.
 */
const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const OAUTH_BASE = 'https://oauth.reddit.com';
const MAX_SUBREDDITS = 8;
const POSTS_PER_SUB = 25;

interface RedditListing {
  data?: {
    children?: Array<{
      data: {
        id: string;
        title: string;
        permalink: string;
        url: string;
        score: number;
        num_comments: number;
        author: string;
        created_utc: number;
        selftext?: string;
        subreddit_name_prefixed?: string;
      };
    }>;
  };
}

// Module-level token cache (app-only token is shared across companies).
let cachedToken: { value: string; expiresAt: number } | null = null;

function credentials() {
  return {
    clientId: process.env.REDDIT_CLIENT_ID,
    clientSecret: process.env.REDDIT_CLIENT_SECRET,
    userAgent:
      process.env.REDDIT_USER_AGENT ?? 'botella-aura/0.1 (trend intelligence)',
  };
}

export class RedditSource implements TrendSource {
  readonly id = 'reddit' as const;
  readonly label = 'Reddit';

  isConfigured(ctx: TrendFetchContext): boolean {
    const { clientId, clientSecret } = credentials();
    return Boolean(clientId && clientSecret && ctx.subreddits.length > 0);
  }

  private async getToken(): Promise<string | null> {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
      return cachedToken.value;
    }
    const { clientId, clientSecret, userAgent } = credentials();
    if (!clientId || !clientSecret) return null;

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    try {
      const res = await httpRequest(TOKEN_URL, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': userAgent,
        },
        body: 'grant_type=client_credentials',
        timeoutMs: 8000,
      });
      if (!res.ok) {
        logger.warn('Reddit: token request failed', { status: res.status });
        return null;
      }
      const json = (await res.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      if (!json.access_token) return null;
      cachedToken = {
        value: json.access_token,
        expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      };
      return cachedToken.value;
    } catch (err) {
      logger.warn('Reddit: token error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async fetchTrendItems(ctx: TrendFetchContext): Promise<TrendItem[]> {
    const token = await this.getToken();
    if (!token) return [];
    const { userAgent } = credentials();
    const keywords = ctx.keywords.map((k) => k.toLowerCase()).filter(Boolean);
    const subs = ctx.subreddits
      .map((s) => s.replace(/^r\//i, '').trim())
      .filter(Boolean)
      .slice(0, MAX_SUBREDDITS);

    const items: TrendItem[] = [];
    for (const sub of subs) {
      try {
        const listing = await getJson<RedditListing>(
          `${OAUTH_BASE}/r/${encodeURIComponent(sub)}/hot?limit=${POSTS_PER_SUB}&raw_json=1`,
          {
            headers: {
              authorization: `Bearer ${token}`,
              'user-agent': userAgent,
            },
            timeoutMs: 8000,
          },
        );
        for (const child of listing.data?.children ?? []) {
          const p = child.data;
          // If keywords are configured, require a match; otherwise take the
          // subreddit's hot posts as-is (the subreddit itself is the signal).
          const haystack = `${p.title} ${p.selftext ?? ''}`.toLowerCase();
          const matched =
            keywords.length > 0
              ? keywords.filter((k) => haystack.includes(k))
              : [];
          if (keywords.length > 0 && matched.length === 0) continue;

          items.push({
            id: `reddit:${p.id}`,
            source: 'reddit',
            sourceLabel: p.subreddit_name_prefixed ?? `r/${sub}`,
            title: p.title,
            url: `https://www.reddit.com${p.permalink}`,
            summary: p.selftext?.slice(0, 280) || undefined,
            author: p.author,
            publishedAt: new Date(p.created_utc * 1000).toISOString(),
            engagement: { points: p.score, comments: p.num_comments },
            matchedKeywords: matched,
          });
        }
      } catch (err) {
        logger.warn('Reddit: subreddit fetch failed', {
          sub,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return items;
  }
}
