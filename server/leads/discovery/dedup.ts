import type { DiscoveredLead } from '@/server/leads/discovery/types';

/**
 * Deduplication & merge (Sprint 5, Module 1). PURE + deterministic — the
 * fixture-tested core (NON-NEGOTIABLE #4/#6). Discovered people/companies are
 * matched against each other and against existing Sprint 4 `Lead` rows by a
 * normalized name + company comparison, so the same person never becomes two
 * rows the user has to reconcile.
 */

/** Lowercase, strip punctuation/legal suffixes, collapse whitespace. */
export function normalize(input: string): string {
  return (input || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|gmbh|plc|limited)\b\.?/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(input: string): Set<string> {
  return new Set(normalize(input).split(' ').filter(Boolean));
}

/** Jaccard token overlap in [0,1]. */
export function jaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export function sameCompany(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na === nb || jaccard(a, b) >= 0.6;
}

export function namesMatch(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Subset rule: a multi-token name fully contained in the other (handles
  // middle initials / suffixes, e.g. "Jane Q. Doe" ⊇ "Jane Doe") — but require
  // ≥2 tokens so a bare first name doesn't over-merge distinct people.
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (small.size >= 2 && [...small].every((t) => big.has(t))) return true;
  return jaccard(a, b) >= 0.7;
}

/** Minimal shape needed to compare two leads (discovered or existing). */
export interface LeadLike {
  name?: string | null;
  companyName: string;
}

/**
 * Whether two leads refer to the same person (or the same company-level lead
 * when neither names a person). A company-level lead and a named person at that
 * company are intentionally treated as DISTINCT (both are kept).
 */
export function isSameLead(a: LeadLike, b: LeadLike): boolean {
  if (!sameCompany(a.companyName, b.companyName)) return false;
  const an = a.name?.trim();
  const bn = b.name?.trim();
  if (!an && !bn) return true;
  if (!an || !bn) return false;
  return namesMatch(an, bn);
}

/** Merge b's non-empty fields into a (a wins on conflict). */
export function mergeDiscovered(
  a: DiscoveredLead,
  b: DiscoveredLead,
): DiscoveredLead {
  return {
    name: a.name || b.name,
    title: a.title || b.title,
    companyName: a.companyName || b.companyName,
    sourceUrl: a.sourceUrl || b.sourceUrl,
    evidence: a.evidence || b.evidence,
    via: a.via,
  };
}

/** Collapse duplicates within a single discovery batch. */
export function dedupeWithin(candidates: DiscoveredLead[]): DiscoveredLead[] {
  const out: DiscoveredLead[] = [];
  for (const c of candidates) {
    const idx = out.findIndex((o) => isSameLead(o, c));
    if (idx >= 0) out[idx] = mergeDiscovered(out[idx]!, c);
    else out.push(c);
  }
  return out;
}

/** Find the first existing lead a candidate matches, or null. */
export function findExistingMatch<T extends LeadLike>(
  candidate: DiscoveredLead,
  existing: T[],
): T | null {
  return existing.find((e) => isSameLead(e, candidate)) ?? null;
}
