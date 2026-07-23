import { XMLParser } from 'fast-xml-parser';
import { getJson, getText, httpRequest } from '@/lib/http';
import { logger } from '@/lib/logger';
import type { TrendFetchContext, TrendItem, TrendSource } from '@/server/trends/types';

/**
 * Reddit connector — read-only, official + keyless-RSS. No user login, no
 * scraping of HTML, no unofficial endpoints.
 *
 *   • With REDDIT_CLIENT_ID/SECRET set → the official app-only OAuth API
 *     (richer: real upvote/comment counts). Rate limit: 100 queries/min per
 *     client ID over a 10-min window; we stay well under it.
 *   • Without keys → Reddit's PUBLIC per-subreddit `.rss` feeds (Atom). Keyless
 *     and real-time; engagement counts aren't exposed in RSS. Best-effort
 *     (Reddit may rate-limit some IPs) — degrades to empty gracefully.
 */
const RSS_LIMIT = 25;
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
    // Keyless RSS works whenever subreddits are configured; OAuth is an upgrade.
    return ctx.subreddits.length > 0;
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
    // No API keys → fall back to Reddit's public RSS feeds (keyless, real-time).
    if (!token) return this.fetchViaRss(ctx);
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

  /**
   * Keyless path: parse Reddit's public per-subreddit `.rss` (Atom) feeds.
   * Real-time and no API keys; engagement counts aren't in RSS. Best-effort.
   */
  private async fetchViaRss(ctx: TrendFetchContext): Promise<TrendItem[]> {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const keywords = ctx.keywords.map((k) => k.toLowerCase()).filter(Boolean);
    const subs = ctx.subreddits
      .map((s) => s.replace(/^r\//i, '').trim())
      .filter(Boolean)
      .slice(0, MAX_SUBREDDITS);

    const results = await Promise.allSettled(
      subs.map(async (sub) => {
        const xml = await getText(
          `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot/.rss?limit=${RSS_LIMIT}`,
          {
            timeoutMs: 8000,
            retries: 1,
            cache: 'no-store',
            headers: {
              'user-agent': 'BotellaAura/0.1 (+trend-intelligence; RSS reader)',
              accept: 'application/atom+xml, application/rss+xml, text/xml',
            },
          },
        );
        const parsed = parser.parse(xml) as {
          feed?: { entry?: RedditRssEntry | RedditRssEntry[] };
        };
        const entries = parsed.feed?.entry
          ? Array.isArray(parsed.feed.entry)
            ? parsed.feed.entry
            : [parsed.feed.entry]
          : [];
        return entries
          .map((e) => this.rssEntryToItem(e, sub, keywords))
          .filter((i): i is TrendItem => i !== null);
      }),
    );

    const items: TrendItem[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      if (r.status !== 'fulfilled') {
        logger.info('Reddit RSS: subreddit fetch failed (best-effort)');
        continue;
      }
      for (const item of r.value) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }
    }
    return items;
  }

  private rssEntryToItem(
    entry: RedditRssEntry,
    sub: string,
    keywords: string[],
  ): TrendItem | null {
    const title = typeof entry.title === 'string' ? entry.title : entry.title?.['#text'];
    if (!title) return null;
    const href = Array.isArray(entry.link)
      ? (entry.link.find((l) => l['@_rel'] === 'alternate') ?? entry.link[0])?.['@_href']
      : entry.link?.['@_href'];
    if (!href) return null;

    const haystack = title.toLowerCase();
    const matched = keywords.length > 0 ? keywords.filter((k) => haystack.includes(k)) : [];
    if (keywords.length > 0 && matched.length === 0) return null;

    const id = entry.id ?? href;
    return {
      id: `reddit:${id.split('/').pop() ?? id}`,
      source: 'reddit',
      sourceLabel: `r/${sub}`,
      title,
      url: href,
      author: entry.author?.name,
      publishedAt: entry.updated ?? entry.published ?? new Date().toISOString(),
      engagement: {}, // not exposed in RSS
      matchedKeywords: matched,
    };
  }
}

interface RedditRssEntry {
  id?: string;
  title?: string | { '#text'?: string };
  link?: { '@_href'?: string } | Array<{ '@_href'?: string; '@_rel'?: string }>;
  updated?: string;
  published?: string;
  author?: { name?: string };
}
