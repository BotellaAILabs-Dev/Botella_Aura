import type { RawSignal, OutreachCriteria } from '@/server/outreach/types';

/**
 * Lead-signal matching/filtering (Sprint 4, Module 3). PURE + deterministic —
 * this is the fixture-tested core (NON-NEGOTIABLE #7). It decides which raw
 * public signals qualify against the company's targeting criteria and dedupes
 * them, before any Lead is created or any Claude call is made.
 */

/** Flattened, lowercased set of all targeting terms. */
export function criteriaTerms(criteria: OutreachCriteria): string[] {
  return [
    ...criteria.industries,
    ...criteria.roleTitles,
    ...criteria.companyStages,
  ]
    .map((t) => t.toLowerCase().trim())
    .filter(Boolean);
}

/**
 * Whether a signal matches the criteria. With NO terms configured, everything
 * matches (so a brand-new workspace still sees signal); otherwise a signal
 * qualifies if any term appears in its company name or description.
 */
export function signalMatches(
  signal: RawSignal,
  criteria: OutreachCriteria,
): { matched: boolean; terms: string[] } {
  const terms = criteriaTerms(criteria);
  if (terms.length === 0) return { matched: true, terms: [] };

  const haystack = `${signal.companyName} ${signal.description}`.toLowerCase();
  const hits = terms.filter((t) => haystack.includes(t));
  return { matched: hits.length > 0, terms: Array.from(new Set(hits)) };
}

/** Dedupe by signal type + company (case-insensitive). Keeps the first seen. */
export function dedupeSignals(signals: RawSignal[]): RawSignal[] {
  const seen = new Set<string>();
  const out: RawSignal[] = [];
  for (const s of signals) {
    const key = `${s.signalType}::${s.companyName.toLowerCase().trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** Filter to matching signals (annotating matchedTerms) and dedupe. */
export function filterSignals(
  signals: RawSignal[],
  criteria: OutreachCriteria,
): RawSignal[] {
  const matched: RawSignal[] = [];
  for (const s of signals) {
    const { matched: ok, terms } = signalMatches(s, criteria);
    if (ok) matched.push({ ...s, matchedTerms: terms });
  }
  return dedupeSignals(matched);
}
