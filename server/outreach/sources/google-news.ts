import { XMLParser } from 'fast-xml-parser';
import { getText } from '@/lib/http';
import { logger } from '@/lib/logger';

/**
 * Keyless Google News RSS search — reused by the outreach news + jobs sources.
 * NOT scraping: this is the public RSS search feed, same approach as Sprint 2.
 */
export interface NewsItem {
  title: string;
  url: string;
  source?: string;
  publishedAt?: string;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

export async function googleNewsItems(
  query: string,
  freshnessDays = 14,
  max = 12,
): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  let xml: string;
  try {
    xml = await getText(url, {
      timeoutMs: 8000,
      retries: 1,
      cache: 'no-store',
      headers: { 'user-agent': 'BotellaAuraBot/0.1 (+https://botella.ai/bot)' },
    });
  } catch (err) {
    logger.info('outreach/news: fetch failed', {
      query,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  let items: {
    title?: string;
    link?: string;
    pubDate?: string;
    source?: string | { '#text'?: string };
  }[] = [];
  try {
    const doc = parser.parse(xml);
    const raw = doc?.rss?.channel?.item;
    items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  } catch {
    return [];
  }

  const cutoff = Date.now() - freshnessDays * 86_400_000;
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const it of items) {
    const title = (it.title ?? '').trim();
    const link = (it.link ?? '').trim();
    if (!title || !link || seen.has(link)) continue;
    const ts = it.pubDate ? Date.parse(it.pubDate) : NaN;
    if (!Number.isNaN(ts) && ts < cutoff) continue;
    seen.add(link);
    out.push({
      title,
      url: link,
      source:
        typeof it.source === 'string' ? it.source : it.source?.['#text'],
      publishedAt: Number.isNaN(ts) ? undefined : new Date(ts).toISOString(),
    });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Best-effort company-name extraction from a news headline. Honest and bounded:
 * we take the leading entity before a common verb/delimiter. The user confirms
 * or edits the lead — we never claim more certainty than a headline provides.
 */
export function companyFromHeadline(title: string): string {
  const cut = title.split(
    /\s+(?:raises|raised|secures|secured|lands|announces|announced|appoints|names|launches|launched|acquires|acquired|is hiring|hiring|nabs|closes)\b|[:—-]/i,
  )[0];
  const name = (cut ?? title).trim();
  return name.slice(0, 120) || title.slice(0, 120);
}
