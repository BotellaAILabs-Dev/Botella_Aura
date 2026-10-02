import type { BusinessContext } from '@/lib/business-context';
import type { SignalInput, SignalKind } from '@/lib/opportunities';

/**
 * Signals: one shape for every observation Aura can detect opportunities from.
 *
 * A trend story, a competitor's pricing change, a jump in engagement, a
 * learned pattern, a running campaign — each arrives from a different module
 * in a different form. Normalised here, they all carry the same things: where
 * they came from, the record behind them, when they happened, how far they can
 * be relied on, and which part of the business they relate to.
 *
 * Pure and client-safe. The collectors live in server/signals.
 */

export const SIGNAL_SOURCES = [
  'TRENDS',
  'COMPETITORS',
  'ANALYTICS',
  'MEMORY',
  'BUSINESS_CONTEXT',
] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export const SIGNAL_RELIABILITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type SignalReliability = (typeof SIGNAL_RELIABILITIES)[number];

export const SIGNAL_SOURCE_INFO: Record<
  SignalSource,
  { label: string; storage: string; expiresAfterDays: number | null }
> = {
  TRENDS: {
    label: 'Market trends',
    storage: 'TrendDigest.payload.items',
    expiresAfterDays: 14,
  },
  COMPETITORS: {
    label: 'Competitors',
    storage: 'CompetitorSnapshot.changesSummary',
    expiresAfterDays: 30,
  },
  ANALYTICS: {
    label: 'Your results',
    storage: 'AnalyticsReport',
    expiresAfterDays: 45,
  },
  MEMORY: {
    label: 'What works for you',
    storage: 'MarketingMemory (active)',
    expiresAfterDays: 60,
  },
  BUSINESS_CONTEXT: {
    label: 'Your business',
    storage: 'Business Context',
    expiresAfterDays: null,
  },
};

/** A signal as a collector produces it, before it is stored. */
export interface NormalizedSignal {
  source: SignalSource;
  kind: SignalKind;
  title: string;
  summary: string;
  url?: string;
  /** The underlying record (a trend item is "<digestId>:<itemId>"). */
  refId: string | null;
  observedAt: Date;
  expiresAt: Date | null;
  reliability: SignalReliability;
  reliabilityReason: string;
  strength?: number;
  /** What parts of the business it relates to, filled in by matchContext. */
  contextMatches: string[];
  metadata: Record<string, unknown>;
  /** Same observation → same key, wherever and however often it is seen. */
  dedupeKey: string;
}

// ---------------------------------------------------------------------------
// Dedupe keys
// ---------------------------------------------------------------------------

/** A URL as one story: no protocol, www, tracking parameters or trailing slash. */
export function canonicalUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|fbclid$|gclid$|mc_)/i.test(p)) u.searchParams.delete(p);
    }
    const query = u.searchParams.toString();
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/+$/, '')}${query ? `?${query}` : ''}`;
  } catch {
    return null;
  }
}

/** Text as a comparison key: case, punctuation and spacing are not differences. */
export function textKey(text: string, words = 16): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, words)
    .join('-');
}

// ---------------------------------------------------------------------------
// Reliability
// ---------------------------------------------------------------------------

const RANK: Record<SignalReliability, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };
const BY_RANK = ['LOW', 'LOW', 'MEDIUM', 'HIGH'] as const;

/**
 * Seeing the same observation in independent places makes it more reliable —
 * a story in two digests, a pattern confirmed twice. One step up per extra
 * sighting, never above HIGH.
 */
export function corroborate(
  base: SignalReliability,
  occurrences: number,
): { reliability: SignalReliability; note: string | null } {
  if (occurrences <= 1) return { reliability: base, note: null };
  const raised = BY_RANK[Math.min(3, RANK[base] + 1)]!;
  return { reliability: raised, note: `seen ${occurrences} times` };
}

export function reliabilityAtLeast(
  r: SignalReliability,
  min: SignalReliability,
): boolean {
  return RANK[r] >= RANK[min];
}

// ---------------------------------------------------------------------------
// Business association
// ---------------------------------------------------------------------------

/**
 * Which parts of the business a signal relates to — the business's own market
 * keywords, competitors, the industries it sells into and its own industry.
 * A signal with no matches is market noise until proven otherwise; detection
 * can ask for relevant signals only.
 */
export function matchContext(
  signal: Pick<NormalizedSignal, 'title' | 'summary'>,
  ctx: BusinessContext | null,
): string[] {
  if (!ctx) return [];
  const haystack = ` ${`${signal.title} ${signal.summary}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const has = (term: string) => {
    const t = term
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    return t.length >= 3 && haystack.includes(` ${t} `);
  };
  const matches = new Set<string>();
  for (const k of ctx.market.keywords) if (has(k)) matches.add(`keyword:${k}`);
  for (const c of ctx.market.competitors)
    if (has(c.name)) matches.add(`competitor:${c.name}`);
  for (const i of ctx.audience.industries)
    if (has(i)) matches.add(`audience-industry:${i}`);
  if (ctx.identity.industry && has(ctx.identity.industry))
    matches.add(`industry:${ctx.identity.industry}`);
  return [...matches];
}

// ---------------------------------------------------------------------------
// Consumption by opportunity detection
// ---------------------------------------------------------------------------

/** A stored signal, as opportunity detection reads it. */
export interface StoredSignal {
  id: string;
  source: SignalSource;
  kind: SignalKind;
  title: string;
  summary: string;
  url: string | null;
  refId: string | null;
  observedAt: Date;
  reliability: SignalReliability;
}

/**
 * A stored signal as opportunity evidence: same kind and record, plus the link
 * back to the normalised signal, so an opportunity is traceable to both.
 */
export function signalToEvidence(
  s: StoredSignal,
): SignalInput & { signalId: string } {
  return {
    kind: s.kind,
    refId: s.refId,
    label: s.title.slice(0, 200),
    detail: s.summary.slice(0, 2000),
    ...(s.url && /^https?:\/\//i.test(s.url) ? { url: s.url } : {}),
    observedAt: s.observedAt,
    signalId: s.id,
  };
}
