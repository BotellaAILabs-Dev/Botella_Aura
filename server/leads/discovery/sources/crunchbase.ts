import { getJson } from '@/lib/http';
import { logger } from '@/lib/logger';
import type { DiscoveryCriteria } from '@/server/leads/discovery/types';
import type { DiscoveredCompany } from '@/server/leads/discovery/sources/github';

/**
 * Crunchbase company discovery via the official v4 organization search.
 *
 * The key comes from the workspace's Crunchbase connector when one is
 * connected, falling back to CRUNCHBASE_API_KEY on the deployment. With no key
 * the source reports itself skipped and contributes nothing — never fabricated
 * companies.
 */
export async function discoverCrunchbaseCompanies(
  criteria: DiscoveryCriteria,
  apiKey?: string | null,
): Promise<{ companies: DiscoveredCompany[]; skipped?: string }> {
  const key = apiKey || process.env.CRUNCHBASE_API_KEY;
  if (!key) {
    return {
      companies: [],
      skipped:
        'crunchbase: no API key — connect Crunchbase in Connectors to turn on funding/stage search.',
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
