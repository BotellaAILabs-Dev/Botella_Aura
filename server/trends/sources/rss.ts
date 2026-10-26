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

/**
 * Publisher feeds that apply to any business, whatever it sells.
 *
 * This list used to be TechCrunch, The Verge, Ars Technica, VentureBeat and
 * Wired — a technology-press reading list, ingested for every workspace on the
 * platform. For a bourbon brand, a restaurant or a clinic, every item from
 * them is noise, and with no keywords configured they were the "general
 * coverage" the digest fell back on. That is the "sources were not sufficiently
 * verified" and "trends were not appropriately localized" finding.
 *
 * What is left is the two feeds that are about MARKETING — which is what this
 * product is for, whoever the customer is. Industry press now comes from
 * INDUSTRY_FEEDS, matched to the business, and anything regional comes from
 * the geo-aware Google News headlines built per request.
 *
 * All are public RSS/Atom the publisher offers for consumption (not scraping).
 */
export const CURATED_FEEDS: Array<{ url: string; label: string }> = [
  { url: 'https://www.marketingdive.com/feeds/news/', label: 'Marketing Dive' },
  { url: 'https://feeds.feedburner.com/entrepreneur/latest', label: 'Entrepreneur' },
];

/**
 * Industry press, used only when the business is actually in that industry.
 *
 * Matched against the company's own industry and keywords. A business that
 * matches nothing gets no industry feed at all — which is correct. Returning a
 * technology feed to a distillery is worse than returning nothing, because it
 * fills the digest with plausible-looking items that are irrelevant, and those
 * are what became off-topic posts.
 */
const INDUSTRY_FEEDS: Array<{
  match: RegExp;
  feeds: Array<{ url: string; label: string }>;
}> = [
  {
    match: /\b(tech|software|saas|startup|developer|it services|cloud|ai|fintech)\b/i,
    feeds: [
      { url: 'https://techcrunch.com/feed/', label: 'TechCrunch' },
      { url: 'https://www.theverge.com/rss/index.xml', label: 'The Verge' },
    ],
  },
  {
    match: /\b(food|drink|beverage|restaurant|cafe|bar|brewer\w*|distiller\w*|winer\w*|spirits|bourbon|whisk\w*|hospitality|catering)\b/i,
    feeds: [
      { url: 'https://www.fooddive.com/feeds/news/', label: 'Food Dive' },
      { url: 'https://www.restaurantdive.com/feeds/news/', label: 'Restaurant Dive' },
    ],
  },
  {
    match: /\b(retail|ecommerce|e-commerce|shop|store|dtc|consumer goods|fashion|apparel)\b/i,
    feeds: [{ url: 'https://www.retaildive.com/feeds/news/', label: 'Retail Dive' }],
  },
  {
    match: /\b(health|healthcare|clinic|medical|dental|wellness|pharma|fitness)\b/i,
    feeds: [{ url: 'https://www.healthcaredive.com/feeds/news/', label: 'Healthcare Dive' }],
  },
  {
    match: /\b(property|real estate|construction|architect\w*|builder|contractor)\b/i,
    feeds: [{ url: 'https://www.constructiondive.com/feeds/news/', label: 'Construction Dive' }],
  },
  {
    match: /\b(bank|finance|financial|insurance|lending|accounting|wealth)\b/i,
    feeds: [{ url: 'https://www.bankingdive.com/feeds/news/', label: 'Banking Dive' }],
  },
  {
    match: /\b(travel|tourism|hotel|resort|airline|holiday)\b/i,
    feeds: [{ url: 'https://www.hotelmanagement.net/rss.xml', label: 'Hotel Management' }],
  },
  {
    match: /\b(education|school|university|college|training|edtech|course)\b/i,
    feeds: [{ url: 'https://www.educationdive.com/feeds/news/', label: 'Education Dive' }],
  },
];

/** Industry press for this business, or nothing when none applies. */
export function industryFeeds(ctx: TrendFetchContext): Array<{ url: string; label: string }> {
  const about = [ctx.industry ?? '', ...ctx.keywords].join(' ');
  if (!about.trim()) return [];
  const out: Array<{ url: string; label: string }> = [];
  for (const entry of INDUSTRY_FEEDS) {
    if (entry.match.test(about)) out.push(...entry.feeds);
  }
  // Two industries can both match ("craft brewery software"); keep both, but
  // not more than a digest can use.
  return out.slice(0, 4);
}

/**
 * Google News top headlines for a topic, in the workspace's own locale.
 *
 * These two were previously hardcoded to `hl=en-US&gl=US&ceid=US:en`, so a
 * business anywhere outside the United States was shown US headlines no matter
 * what country it had configured — while the per-keyword searches right beside
 * them were correctly localised. That is the localization gap the review
 * raised, and it was a literal string, not a design decision.
 */
export function googleTopicUrl(topic: 'BUSINESS' | 'NATION', geo: GeoOpts): string {
  const hl = `${geo.language}-${geo.country}`;
  return `https://news.google.com/rss/headlines/section/topic/${topic}?hl=${hl}&gl=${geo.country}&ceid=${geo.country}:${geo.language}`;
}

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

export interface GeoOpts {
  country: string; // ISO code, e.g. "US"
  language: string; // e.g. "en"
  location: string; // "City Region" hint appended to the query (may be empty)
  days: number;
}

function googleNewsUrl(keyword: string, geo: GeoOpts): string {
  // `when:Nd` restricts Google News search to the last N days → fresh results.
  // Location terms narrow to a city/region; hl/gl/ceid set the country locale.
  const query = [keyword, geo.location, `when:${geo.days}d`]
    .filter(Boolean)
    .join(' ');
  const q = encodeURIComponent(query);
  const hl = `${geo.language}-${geo.country}`;
  return `https://news.google.com/rss/search?q=${q}&hl=${hl}&gl=${geo.country}&ceid=${geo.country}:${geo.language}`;
}

function bingNewsUrl(keyword: string, geo: GeoOpts, cacheBust: number): string {
  const q = encodeURIComponent([keyword, geo.location].filter(Boolean).join(' '));
  const cc = geo.country.toLowerCase();
  return `https://www.bing.com/news/search?q=${q}&format=rss&cc=${cc}&_cb=${cacheBust}`;
}

/** Resolve geo/locale options from the company config (with safe defaults). */
export function resolveGeo(ctx: TrendFetchContext): GeoOpts {
  const country = (ctx.country || 'US').toUpperCase().slice(0, 2);
  const language = (ctx.language || 'en').toLowerCase().slice(0, 2);
  const location = [ctx.city, ctx.region].filter(Boolean).join(' ').trim();
  const days =
    ctx.timeRangeDays && ctx.timeRangeDays > 0 ? ctx.timeRangeDays : FRESHNESS_DAYS;
  return { country, language, location, days };
}

export class NewsSource implements TrendSource {
  readonly id = 'news' as const;
  readonly label = 'News';

  isConfigured(ctx: TrendFetchContext): boolean {
    return ctx.keywords.length > 0 || ctx.rssFeeds.length > 0;
  }

  async fetchTrendItems(ctx: TrendFetchContext): Promise<TrendItem[]> {
    const now = Date.now();
    const geo = resolveGeo(ctx);
    const keywords = ctx.keywords.map((k) => k.toLowerCase()).filter(Boolean);
    const kws = ctx.keywords.slice(0, MAX_KEYWORDS);

    const feeds: Array<{
      url: string;
      label: string;
      keyword?: string;
      requireMatch?: boolean;
    }> = [
      // Geo/locale-aware Google News + Bing per keyword.
      ...kws.map((k) => ({ url: googleNewsUrl(k, geo), label: 'Google News', keyword: k.toLowerCase() })),
      ...kws.map((k) => ({ url: bingNewsUrl(k, geo, now), label: 'Bing News', keyword: k.toLowerCase() })),
      // Top headlines in the workspace's own country, not always the US.
      {
        url: googleTopicUrl('BUSINESS', geo),
        label: 'Google News · Business',
        requireMatch: keywords.length > 0,
      },
      {
        url: googleTopicUrl('NATION', geo),
        label: 'Google News · National',
        requireMatch: keywords.length > 0,
      },
      // Industry press, only where it is this business's industry.
      ...industryFeeds(ctx).map((f) => ({ ...f, requireMatch: keywords.length > 0 })),
      // Marketing press — relevant to every workspace on the platform.
      ...CURATED_FEEDS.map((f) => ({ ...f, requireMatch: keywords.length > 0 })),
      // Company-configured feeds — always kept (the user chose them).
      ...ctx.rssFeeds.slice(0, MAX_FEEDS).map((url) => ({ url, label: 'RSS' })),
    ];

    const results = await Promise.allSettled(
      feeds.map((f) =>
        this.readFeed(f.url, f.label, f.keyword, keywords, now, geo.days, f.requireMatch ?? false),
      ),
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
    days: number,
    requireMatch: boolean,
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

    const cutoff = now - days * 86_400_000;
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
      // Curated feeds: keep only on-topic items when keywords are configured.
      if (requireMatch && matched.length === 0) continue;

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
