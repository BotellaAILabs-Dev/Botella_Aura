import { getJson } from '@/lib/http';
import { logger } from '@/lib/logger';
import type { DiscoveryCriteria } from '@/server/leads/discovery/types';
import type { DiscoveredCompany } from '@/server/leads/discovery/sources/github';

/**
 * Crunchbase company discovery (Sprint 5) — STUBBED behind CRUNCHBASE_API_KEY.
 * Paid/gated; when no key is set the source is skipped (surfaced in the run
 * summary) and contributes nothing. No fabricated companies. The official v4
 * organization search is wired for when a key exists.
 */
export async function discoverCrunchbaseCompanies(
  criteria: DiscoveryCriteria,
): Promise<{ companies: DiscoveredCompany[]; skipped?: string }> {
  const key = process.env.CRUNCHBASE_API_KEY;
  if (!key) {
    return {
      companies: [],
      skipped: 'crunchbase: CRUNCHBASE_API_KEY not set — funding/stage search off.',
    };
  }

  const terms = [...criteria.industries, ...criteria.keywords].slice(0, 2);
  if (terms.length === 0) return { companies: [], skipped: 'crunchbase: no criteria' };

  try {
    const companies: DiscoveredCompany[] = [];
    for (const term of terms) {
      const data = await getJson<{
        entities?: {
          properties?: { name?: string; short_description?: string; permalink?: string; website?: { value?: string } };
        }[];
      }>('https://api.crunchbase.com/api/v4/searches/organizations', {
        method: 'POST',
        headers: { 'X-cb-user-key': key, 'content-type': 'application/json' },
        timeoutMs: 10_000,
        body: JSON.stringify({
          field_ids: ['name', 'short_description', 'permalink', 'website'],
          query: [
            { type: 'predicate', field_id: 'description', operator_id: 'contains', values: [term] },
          ],
          limit: 6,
        }),
      });
      for (const e of data.entities ?? []) {
        const name = e.properties?.name;
        if (!name) continue;
        companies.push({
          name,
          website: e.properties?.website?.value,
          sourceUrl: e.properties?.permalink
            ? `https://www.crunchbase.com/organization/${e.properties.permalink}`
            : 'https://www.crunchbase.com',
          description: e.properties?.short_description,
        });
      }
    }
    return { companies };
  } catch (err) {
    logger.warn('discovery/crunchbase: request failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { companies: [], skipped: 'crunchbase: request failed' };
  }
}
