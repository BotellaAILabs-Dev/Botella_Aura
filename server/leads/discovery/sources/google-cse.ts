import { getJson } from '@/lib/http';
import { logger } from '@/lib/logger';
import type { DiscoveryCriteria, DiscoveredLead } from '@/server/leads/discovery/types';

/**
 * Google Custom Search discovery (Sprint 5) — STUBBED behind GOOGLE_CSE_API_KEY
 * + GOOGLE_CSE_CX. Uses the OFFICIAL Custom Search JSON API (an approved API
 * product) for public-web "founder of X" / "X CTO" style lookups — NEVER raw
 * scraping of Google result pages. Skipped + flagged when unconfigured.
 */
export async function discoverViaSearch(
  criteria: DiscoveryCriteria,
): Promise<{ leads: DiscoveredLead[]; skipped?: string }> {
  const key = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) {
    return {
      leads: [],
      skipped:
        'google-cse: GOOGLE_CSE_API_KEY / GOOGLE_CSE_CX not set — web search off.',
    };
  }

  // Build a couple of role-oriented queries from the criteria.
  const role = criteria.roleTitles[0] ?? 'founder';
  const topic = criteria.industries[0] ?? criteria.keywords[0];
  if (!topic) return { leads: [], skipped: 'google-cse: no criteria' };
  const geo = criteria.geographies[0] ? ` ${criteria.geographies[0]}` : '';
  const queries = [`${role} ${topic} company${geo}`, `${topic} startup ${role}${geo}`];

  const leads: DiscoveredLead[] = [];
  for (const q of queries) {
    try {
      const data = await getJson<{
        items?: { title?: string; link?: string; snippet?: string }[];
      }>(
        `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&num=5&q=${encodeURIComponent(q)}`,
        { timeoutMs: 10_000 },
      );
      for (const item of data.items ?? []) {
        if (!item.title || !item.link) continue;
        // Company-level lead from the result; the user confirms the person.
        leads.push({
          companyName: item.title.split(/[|\-–—:]/)[0]!.trim().slice(0, 120),
          sourceUrl: item.link,
          evidence: item.snippet?.slice(0, 200),
          via: 'google-cse',
        });
      }
    } catch (err) {
      logger.info('discovery/google-cse: query failed', {
        q,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { leads };
}
