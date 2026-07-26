import { getJson } from '@/lib/http';
import { logger } from '@/lib/logger';
import type { RawSignal } from '@/server/outreach/types';

/**
 * Crunchbase funding-signal source — STUBBED behind CRUNCHBASE_API_KEY.
 *
 * Crunchbase's API is paid/gated. Following the product's honesty principle, we
 * do NOT fabricate funding data. When no key is configured, this source reports
 * itself as unavailable (the detect service surfaces that in `skipped`) and
 * contributes nothing. When a key IS set, it queries the official API. The
 * request shape below targets the Crunchbase v4 search endpoint; adjust to your
 * plan's exact schema when you enable it.
 */
export interface CrunchbaseResult {
  available: boolean;
  signals: RawSignal[];
  reason?: string;
}

export async function crunchbaseSignals(
  terms: string[],
): Promise<CrunchbaseResult> {
  const key = process.env.CRUNCHBASE_API_KEY;
  if (!key) {
    return {
      available: false,
      signals: [],
      reason: 'CRUNCHBASE_API_KEY not set — funding signals from Crunchbase are off.',
    };
  }

  try {
    // Official Crunchbase v4 organization search (funding-focused).
    const signals: RawSignal[] = [];
    for (const term of terms.slice(0, 2)) {
      const data = await getJson<{
        entities?: { properties?: { name?: string; short_description?: string; permalink?: string } }[];
      }>('https://api.crunchbase.com/api/v4/searches/organizations', {
        method: 'POST',
        headers: { 'X-cb-user-key': key, 'content-type': 'application/json' },
        timeoutMs: 10_000,
        body: JSON.stringify({
          field_ids: ['name', 'short_description', 'permalink'],
          query: [
            { type: 'predicate', field_id: 'description', operator_id: 'contains', values: [term] },
          ],
          limit: 5,
        }),
      });
      for (const e of data.entities ?? []) {
        const name = e.properties?.name;
        if (!name) continue;
        signals.push({
          signalType: 'FUNDING',
          companyName: name,
          description: e.properties?.short_description ?? `Crunchbase match for "${term}"`,
          sourceUrl: e.properties?.permalink
            ? `https://www.crunchbase.com/organization/${e.properties.permalink}`
            : undefined,
          matchedTerms: [],
        });
      }
    }
    return { available: true, signals };
  } catch (err) {
    logger.warn('outreach/crunchbase: request failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { available: false, signals: [], reason: 'Crunchbase request failed.' };
  }
}
