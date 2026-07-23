import { XMLParser } from 'fast-xml-parser';
import { getText } from '@/lib/http';
import { logger } from '@/lib/logger';
import type { TrendFetchContext, TrendItem, TrendSource } from '@/server/trends/types';

/**
 * News connector — RSS ingestion only (NO scraping). Two inputs:
 *   1. Google News RSS search per configured keyword (public, keyless).
 *   2. Any extra RSS feed URLs the company added in its trend config.
 *
 * Google News RSS is a public endpoint; we keep volume low (one request per
 * keyword, bounded by MAX_KEYWORDS) and parse pure XML — never HTML scraping.
 */
const MAX_KEYWORDS = 8;
const MAX_FEEDS = 6;
const MAX_ITEMS_PER_FEED = 15;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

interface RssItem {
  title?: string | { '#text'?: string };
  link?: string | { '@_href'?: string; '#text'?: string };
  pubDate?: string;
  published?: string;
  updated?: string;
  description?: string;
  guid?: string | { '#text'?: string };
  source?: string | { '#text'?: string };
}

function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && '#text' in v) {
    return String((v as { '#text'?: unknown })['#text'] ?? '');
  }
  return '';
}

function link(item: RssItem): string {
  if (typeof item.link === 'string') return item.link;
  if (item.link && typeof item.link === 'object') {
    return item.link['@_href'] ?? item.link['#text'] ?? '';
  }
  return '';
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function googleNewsUrl(keyword: string): string {
  const q = encodeURIComponent(keyword);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

export class NewsSource implements TrendSource {
  readonly id = 'news' as const;
  readonly label = 'Google News';

  isConfigured(ctx: TrendFetchContext): boolean {
    // Keyless. Runs whenever there are keywords or explicit feeds to read.
    return ctx.keywords.length > 0 || ctx.rssFeeds.length > 0;
  }

  async fetchTrendItems(ctx: TrendFetchContext): Promise<TrendItem[]> {
    const keywords = ctx.keywords.map((k) => k.toLowerCase()).filter(Boolean);
    const feeds: Array<{ url: string; label: string; keyword?: string }> = [
      ...ctx.keywords.slice(0, MAX_KEYWORDS).map((k) => ({
        url: googleNewsUrl(k),
        label: 'Google News',
        keyword: k.toLowerCase(),
      })),
      ...ctx.rssFeeds.slice(0, MAX_FEEDS).map((url) => ({
        url,
        label: 'RSS',
      })),
    ];

    const results = await Promise.allSettled(
      feeds.map((f) => this.readFeed(f.url, f.label, f.keyword, keywords)),
    );
    const items: TrendItem[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const item of r.value) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }
    }
    return items;
  }

  private async readFeed(
    url: string,
    label: string,
    keyword: string | undefined,
    allKeywords: string[],
  ): Promise<TrendItem[]> {
    let xml: string;
    try {
      xml = await getText(url, {
        timeoutMs: 8000,
        headers: { 'user-agent': 'botella-aura/0.1 (+trend-intelligence)' },
      });
    } catch (err) {
      logger.warn('News: feed fetch failed', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    let parsed: { rss?: { channel?: { item?: RssItem | RssItem[] } }; feed?: { entry?: RssItem | RssItem[] } };
    try {
      parsed = parser.parse(xml);
    } catch {
      return [];
    }

    // Support both RSS (<rss><channel><item>) and Atom (<feed><entry>).
    const rawItems = [
      ...toArray(parsed.rss?.channel?.item),
      ...toArray(parsed.feed?.entry),
    ].slice(0, MAX_ITEMS_PER_FEED);

    const out: TrendItem[] = [];
    for (const raw of rawItems) {
      const title = text(raw.title).trim();
      const href = link(raw);
      if (!title || !href) continue;

      const haystack = `${title} ${raw.description ?? ''}`.toLowerCase();
      const matched = allKeywords.filter((k) => haystack.includes(k));
      // For a keyword-specific Google News feed, the query already implies the
      // match; record the driving keyword so relevance scoring credits it.
      if (keyword && !matched.includes(keyword)) matched.push(keyword);

      const publishedRaw = raw.pubDate ?? raw.published ?? raw.updated;
      const publishedAt = publishedRaw
        ? new Date(publishedRaw).toISOString()
        : new Date().toISOString();

      const guid = text(raw.guid) || href;
      out.push({
        id: `news:${hashId(guid)}`,
        source: 'news',
        sourceLabel: text(raw.source) || label,
        title,
        url: href,
        author: undefined,
        publishedAt,
        engagement: {}, // RSS exposes no engagement metric
        matchedKeywords: matched,
      });
    }
    return out;
  }
}

/** Small stable id from a URL/guid (avoids storing the full string as a key). */
function hashId(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}
