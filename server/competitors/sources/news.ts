import { XMLParser } from 'fast-xml-parser';
import { getText } from '@/lib/http';
import { logger } from '@/lib/logger';
import type { CompetitorNewsItem } from '@/server/competitors/types';

/**
 * Public news source for competitor mentions. Reuses Sprint 2's keyless RSS
 * approach (Google News search feed) — NOT scraping. Filtered to the
 * competitor's name and bounded by recency.
 */
const FRESHNESS_DAYS = 10;
const MAX_ITEMS = 8;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

interface RssItem {
  title?: string;
  link?: string;
  pubDate?: string;
  source?: string | { '#text'?: string };
}

function sourceName(v: RssItem['source']): string | undefined {
  if (!v) return undefined;
  if (typeof v === 'string') return v;
  return v['#text'];
}

export async function fetchCompetitorNews(
  name: string,
): Promise<CompetitorNewsItem[]> {
  const q = encodeURIComponent(`"${name}"`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;

  let xml: string;
  try {
    xml = await getText(url, {
      timeoutMs: 8000,
      retries: 1,
      cache: 'no-store',
      headers: { 'user-agent': 'BotellaAuraBot/0.1 (+https://botella.ai/bot)' },
    });
  } catch (err) {
    logger.info('competitors/news: fetch failed', {
      name,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  let items: RssItem[] = [];
  try {
    const doc = parser.parse(xml);
    const raw = doc?.rss?.channel?.item;
    items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  } catch {
    return [];
  }

  const cutoff = Date.now() - FRESHNESS_DAYS * 86_400_000;
  const seen = new Set<string>();
  const out: CompetitorNewsItem[] = [];

  for (const it of items) {
    const title = (it.title ?? '').trim();
    const link = (it.link ?? '').trim();
    if (!title || !link || seen.has(link)) continue;

    const ts = it.pubDate ? Date.parse(it.pubDate) : NaN;
    if (!Number.isNaN(ts) && ts < cutoff) continue;
    // Require the competitor name to actually appear (Google News is fuzzy).
    if (!title.toLowerCase().includes(name.toLowerCase())) continue;

    seen.add(link);
    out.push({
      title,
      url: link,
      source: sourceName(it.source),
      publishedAt: Number.isNaN(ts) ? undefined : new Date(ts).toISOString(),
    });
    if (out.length >= MAX_ITEMS) break;
  }

  return out;
}
