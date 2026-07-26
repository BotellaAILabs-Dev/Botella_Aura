import { googleNewsItems, companyFromHeadline } from './google-news';
import type { RawSignal } from '@/server/outreach/types';

/**
 * News signal source — funding / launch / leadership signals via keyless Google
 * News RSS, driven by the company's target industries/keywords.
 */
export async function newsSignals(terms: string[]): Promise<RawSignal[]> {
  const queries = terms.slice(0, 4); // bound outbound calls
  const results = await Promise.allSettled(
    queries.map((term) =>
      googleNewsItems(`"${term}" (raises OR funding OR launches OR appoints)`),
    ),
  );

  const out: RawSignal[] = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      const t = item.title.toLowerCase();
      const signalType = /rais|fund|seed|series|round/.test(t)
        ? 'FUNDING'
        : /appoint|names|hires? .*(ceo|cmo|cto|chief|head|vp)|leadership/.test(t)
          ? 'LEADERSHIP_CHANGE'
          : 'NEWS';
      out.push({
        signalType,
        companyName: companyFromHeadline(item.title),
        description: item.title,
        sourceUrl: item.url,
        matchedTerms: [],
      });
    }
  }
  return out;
}
