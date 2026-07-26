import { googleNewsItems, companyFromHeadline } from './google-news';
import type { RawSignal } from '@/server/outreach/types';

/**
 * Hiring-signal source. Uses public news/RSS for "<role> hiring" announcements —
 * NEVER LinkedIn's own jobs pages. When a dedicated job-board API key is
 * available in a later sprint, add it here behind that key.
 */
export async function jobSignals(roleTitles: string[]): Promise<RawSignal[]> {
  const queries = roleTitles.slice(0, 4);
  const results = await Promise.allSettled(
    queries.map((role) => googleNewsItems(`"${role}" (hiring OR "now hiring")`)),
  );

  const out: RawSignal[] = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      out.push({
        signalType: 'HIRING',
        companyName: companyFromHeadline(item.title),
        description: item.title,
        sourceUrl: item.url,
        matchedTerms: [],
      });
    }
  }
  return out;
}
