import { XMLParser } from 'fast-xml-parser';
import { getText } from '@/lib/http';
import { logger } from '@/lib/logger';
import type { TrendFetchContext, TrendItem, TrendSource } from '@/server/trends/types';

/**
 * News connector — REAL-TIME, KEYLESS RSS ingestion (NOT HTML scraping).
 *
 * On every refresh it pulls fresh items from public news feeds the publishers
 * offer for consumption — no API keys, no scraping, ToS-compliant:
 *   1. Google News RSS search per keyword, restricted to the last N days via the
 *      documented `when:Nd` search operator (so results are genuinely new).
 *   2. Bing News RSS search per keyword (secondary; best-effort).
 *   3. Any extra RSS/Atom feed URLs the company configured.
 *
 * Freshness guarantees:
 *   - `cache: 'no-store'` on every fetch (bypass Next.js/undici fetch cache).
 *   - A hard recency window (FRESHNESS_DAYS) drops anything older.
 *   - Cache-busting timestamp on providers that tolerate extra params.
 */
const FRESHNESS_DAYS = 4; // only surface news from the last few days
const MAX_KEYWORDS = 10;
const MAX_FEEDS = 8;
const MAX_ITEMS_PER_FEED = 20;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

interface RssItem {
  title?: string | { '#text'?: string };
  link?: string | { '@_href'?: string; '#text'?: string } | Array<{ '@_href'?: string; '@_rel'?: string }>;
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
  if (Array.isArray(item.link)) {
    const alt = item.link.find((l) => l['@_rel'] === 'alternate') ?? item.link[0];
    return alt?.['@_href'] ?? '';
  }
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
  // `when:Nd` restricts Google News search to the last N days → fresh results.
  const q = encodeURIComponent(`${keyword} when:${FRESHNESS_DAYS}d`);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

function bingNewsUrl(keyword: string, cacheBust: number): string {
  const q = encodeURIComponent(keyword);
  return `https://www.bing.com/news/search?q=${q}&format=rss&cc=us&_cb=${cacheBust}`;
}

export class NewsSource implements TrendSource {
  readonly id = 'news' as const;
  readonly label = 'News';

  isConfigured(ctx: TrendFetchContext): boolean {
    return ctx.keywords.length > 0 || ctx.rssFeeds.length > 0;
  }

  async fetchTrendItems(ctx: TrendFetchContext): Promise<TrendItem[]> {
    const now = Date.now();
    const keywords = ctx.keywords.map((k) => k.toLowerCase()).filter(Boolean);
    const kws = ctx.keywords.slice(0, MAX_KEYWORDS);

    const feeds: Array<{ url: string; label: string; keyword?: string }> = [
      // Google News per keyword (freshness-restricted) + Bing per keyword.
      ...kws.map((k) => ({ url: googleNewsUrl(k), label: 'Google News', keyword: k.toLowerCase() })),
      ...kws.map((k) => ({ url: bingNewsUrl(k, now), label: 'Bing News', keyword: k.toLowerCase() })),
      // Company-configured RSS/Atom feeds.
      ...ctx.rssFeeds.slice(0, MAX_FEEDS).map((url) => ({ url, label: 'RSS' })),
    ];

    const results = await Promise.allSettled(
      feeds.map((f) => this.readFeed(f.url, f.label, f.keyword, keywords, now)),
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
    now: number,
  ): Promise<TrendItem[]> {
    let xml: string;
    try {
      xml = await getText(url, {
        timeoutMs: 9000,
        retries: 1,
        cache: 'no-store', // always fetch live — no stale cache on refresh
        headers: {
          'user-agent': 'BotellaAura/0.1 (+trend-intelligence; RSS reader)',
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
        },
      });
    } catch (err) {
      logger.info('News: feed fetch failed', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    let parsed: {
      rss?: { channel?: { item?: RssItem | RssItem[] } };
      feed?: { entry?: RssItem | RssItem[] };
    };
    try {
      parsed = parser.parse(xml);
    } catch {
      return [];
    }

    const rawItems = [
      ...toArray(parsed.rss?.channel?.item),
      ...toArray(parsed.feed?.entry),
    ].slice(0, MAX_ITEMS_PER_FEED);

    const cutoff = now - FRESHNESS_DAYS * 86_400_000;
    const out: TrendItem[] = [];
    for (const raw of rawItems) {
      const title = text(raw.title).trim();
      const href = link(raw);
      if (!title || !href) continue;

      const publishedRaw = raw.pubDate ?? raw.published ?? raw.updated;
      const publishedMs = publishedRaw ? Date.parse(publishedRaw) : NaN;
      // Hard recency window — only "new" news. Undated items are kept (feed order).
      if (Number.isFinite(publishedMs) && publishedMs < cutoff) continue;
      const publishedAt = Number.isFinite(publishedMs)
        ? new Date(publishedMs).toISOString()
        : new Date(now).toISOString();

      const haystack = `${title} ${text(raw.description)}`.toLowerCase();
      const matched = allKeywords.filter((k) => haystack.includes(k));
      if (keyword && !matched.includes(keyword)) matched.push(keyword);

      const guid = text(raw.guid) || href;
      out.push({
        id: `news:${hashId(guid)}`,
        source: 'news',
        sourceLabel: text(raw.source) || label,
        title,
        url: href,
        publishedAt,
        engagement: {}, // RSS exposes no engagement metric
        matchedKeywords: matched,
      });
    }
    return out;
  }
}

/** Small stable id from a URL/guid. */
function hashId(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}
