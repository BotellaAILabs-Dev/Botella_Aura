import { extractFacts } from '@/lib/content-variations';
import { overlap, topicWords } from '@/lib/generation-context';

/**
 * FACTUAL VALIDATION — every claim in a piece of content, checked against what
 * Aura trusts, before the piece is presented as ready for approval.
 *
 *   1. extractClaims    the sentences that assert something checkable: a
 *                       number, price, percentage or date; an absolute
 *                       ("the only", "award-winning", "guaranteed"); a
 *                       statement about the business ("we roast…", "our
 *                       subscriptions include…"); a statement about the
 *                       market or a competitor; a link or contact
 *   2. checkFacts       each claim against the trusted sources — the business
 *                       context (confirmed facts), the recommendation's
 *                       evidence (with when it was seen), the business's own
 *                       material, the person's brief — and the unconfirmed
 *                       ones (assumptions), kept apart
 *
 *   supported     a trusted source carries it
 *   unverified    only an unconfirmed detail carries it
 *   outdated      only an old or stale source carries it
 *   contradicted  a trusted source says something different (another
 *                 percentage, price or year about the same thing)
 *   unsupported   nothing carries it
 *
 * The report is `verified` only when every claim is supported. Anything else
 * needs review, and a contradiction blocks approval — so an unsupported claim
 * about the business is never presented as checked.
 *
 * Pure and client-safe; run on the server by server/content/fact-check.service.ts.
 */

export const FACT_CHECK_VERSION = 1 as const;

/** Evidence older than this backs a market claim only as "possibly outdated". */
export const OUTDATED_AFTER_DAYS = 180;

export type ClaimKind =
  'number' | 'date' | 'absolute' | 'business' | 'market' | 'contact';
export type ClaimStatus =
  'supported' | 'unverified' | 'outdated' | 'contradicted' | 'unsupported';

export interface Claim {
  /** The sentence, as written. */
  text: string;
  kinds: ClaimKind[];
  /** Checkable facts in it (normalised): numbers, prices, %, dates, links… */
  facts: string[];
  /** Absolute words in it ("only", "guaranteed"). */
  absolutes: string[];
}

export interface TrustedSource {
  label: string;
  text: string;
  kind: 'business_profile' | 'evidence' | 'knowledge' | 'brief' | 'assumption';
  /** Confirmed (false for assumptions — present but unconfirmed). */
  trusted: boolean;
  /** When it was observed/captured, when known (ISO). */
  observedAt: string | null;
  /** Marked stale by the business context. */
  stale: boolean;
}

export interface CheckedClaim extends Claim {
  status: ClaimStatus;
  /** Why, in words. */
  reason: string;
  /** The source that carries it (or the one it conflicts with). */
  source: {
    label: string;
    kind: TrustedSource['kind'];
    observedAt: string | null;
  } | null;
  /** For a contradiction: what the source says instead. */
  conflict?: { claimed: string; source: string };
  /**
   * Must be fixed before approval — a person cannot vouch for it: a
   * contradiction, or an unsupported number, price, date or absolute ("the
   * only", "award-winning"). The same claims the quality check blocks.
   */
  mustFix: boolean;
}

export interface FactCheckReport {
  version: typeof FACT_CHECK_VERSION;
  checkedAt: string;
  /**
   *   verified          every claim is supported by a trusted source
   *   needs_review      some are unsupported, unverified or possibly outdated
   *   contradicted      a claim conflicts with a trusted source
   *   nothing_to_check  no factual claims in it
   */
  status: 'verified' | 'needs_review' | 'contradicted' | 'nothing_to_check';
  claims: CheckedClaim[];
  counts: Record<ClaimStatus, number>;
  /** Claims that must be fixed before approval (see CheckedClaim.mustFix). */
  mustFix: number;
  /** What it was checked against, by kind. */
  checkedAgainst: { kind: TrustedSource['kind']; count: number }[];
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

const ABSOLUTES =
  /\b(best|#1|number one|no\.? ?1|only|first|leading|largest|biggest|fastest|cheapest|lowest price|guaranteed?|award[- ]winning|certified|organic|100%|always|never fails|proven|unbeatable|world[- ]class|official)\b/gi;
const BUSINESS =
  /\b(we|our|us)\b[^.!?]{0,40}\b(offer|offers|sell|sells|ship|ships|deliver|delivers|open|opened|serve|serves|make|makes|roast|roasts|source|sources|have|has|provide|provides|include|includes|launch|launched|use|uses|work with|partner|pay|paid|grow|grown|founded|started|employ|absorb|charge|price)/i;
/** "Our bag is…", "our subscriptions are…", "our beans cost…" — the business, described. */
const BUSINESS_STATE =
  /\bour\s+[\w-]+(?:\s+[\w-]+){0,3}\s+(is|are|was|were|costs?|comes?|starts?)\b/i;
const MARKET =
  /\b(prices? (rose|rise|fell|fall|climb|drop|went up|went down)|market|industry|competitors?|harvests?|demand|supply|customers are|everyone|most people|studies show|research shows)\b/i;
const DATE_WORDS =
  /\b(this (year|month|week|season)|today|right now|currently|latest|recently|new|since \d{4}|in \d{4}|\d{4})\b/i;
const CONTACT = /(https?:\/\/|www\.|@[a-z0-9_]{2,}|\b[\w.+-]+@[\w-]+\.[\w.]+)/i;

/** Sentences, from any shape of copy (paragraphs, bullets, lines). */
function sentences(text: string): string[] {
  return text
    .replace(/\s*\n+\s*/g, '\n')
    .split(/(?<=[.!?])\s+|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && !s.startsWith('#'));
}

export function extractClaims(
  text: string,
  competitors: string[] = [],
): Claim[] {
  const out: Claim[] = [];
  for (const s of sentences(text)) {
    // Questions and bare calls to action assert nothing.
    if (/\?$/.test(s)) continue;
    const facts = extractFacts(s);
    const absolutes = [
      ...new Set((s.match(ABSOLUTES) ?? []).map((a) => a.toLowerCase())),
    ];
    const kinds = new Set<ClaimKind>();
    if (facts.some((f) => /\d/.test(f) && !/^(\d{4})$/.test(f)))
      kinds.add('number');
    if (DATE_WORDS.test(s)) kinds.add('date');
    if (absolutes.length) kinds.add('absolute');
    if (BUSINESS.test(s) || BUSINESS_STATE.test(s)) kinds.add('business');
    if (
      MARKET.test(s) ||
      competitors.some((c) => c && s.toLowerCase().includes(c.toLowerCase()))
    )
      kinds.add('market');
    if (CONTACT.test(s)) kinds.add('contact');
    // "New" alone ("a new way to brew") is wording; it counts with something else.
    if (
      kinds.size === 1 &&
      kinds.has('date') &&
      !/\d{4}|this (year|month|week)|since/i.test(s)
    )
      continue;
    if (kinds.size === 0) continue;
    out.push({ text: s, kinds: [...kinds], facts, absolutes });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

const normal = (t: string) => t.toLowerCase().replace(/\s+/g, ' ');

/** The kind of a fact, so a percentage is compared with percentages. */
function factType(
  f: string,
): 'percent' | 'money' | 'year' | 'number' | 'other' {
  if (/%|percent/.test(f)) return 'percent';
  if (/^[$£€₹]/.test(f)) return 'money';
  if (/^(19|20)\d{2}$/.test(f)) return 'year';
  if (/^\d[\d,.]*$/.test(f)) return 'number';
  return 'other';
}

function ageDays(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? Math.floor((now.getTime() - t) / 86_400_000)
    : null;
}

function carries(source: TrustedSource, claim: Claim): boolean {
  const text = normal(source.text);
  const sourceFacts = new Set(extractFacts(source.text));
  const factsOk = claim.facts.every(
    (f) => sourceFacts.has(f) || text.includes(f),
  );
  const absOk = claim.absolutes.every((a) => text.includes(a));
  const words = topicWords(claim.text);
  const topic = overlap(words, source.text);
  // A claim with checkable facts needs them all, about the same thing. One
  // without needs the source to cover most of what it says — sharing "coffee
  // subscriptions" with the profile does not back "we ship them to Europe".
  if (!factsOk || !absOk) return false;
  if (claim.facts.length) return topic >= 1;
  return topic >= 2 && topic / Math.max(1, words.size) >= 0.6;
}

/** A trusted source about the same thing that states a different value. */
function conflictWith(
  source: TrustedSource,
  claim: Claim,
): { claimed: string; source: string } | null {
  if (!source.trusted) return null;
  if (overlap(topicWords(claim.text), source.text) < 2) return null;
  const theirs = extractFacts(source.text);
  for (const f of claim.facts) {
    const type = factType(f);
    if (type === 'other' || type === 'number') continue;
    const same = theirs.filter((t) => factType(t) === type);
    if (same.length && !same.includes(f))
      return { claimed: f, source: same[0]! };
  }
  return null;
}

export function checkFacts(args: {
  text: string;
  sources: TrustedSource[];
  competitors?: string[];
  now?: Date;
}): FactCheckReport {
  const now = args.now ?? new Date();
  const claims = extractClaims(args.text, args.competitors ?? []);
  const trusted = args.sources.filter((s) => s.trusted);
  const unconfirmed = args.sources.filter((s) => !s.trusted);
  const ref = (s: TrustedSource) => ({
    label: s.label,
    kind: s.kind,
    observedAt: s.observedAt,
  });

  const checked: Omit<CheckedClaim, "mustFix">[] = claims.map((c) => {
    const backing = trusted.filter((s) => carries(s, c));
    if (backing.length) {
      // Current backing first; only old or stale backing makes it "outdated"
      // — for claims about the market or a time ("this year", a number).
      const current = backing.find((s) => {
        const age = ageDays(s.observedAt, now);
        return !s.stale && (age === null || age <= OUTDATED_AFTER_DAYS);
      });
      const timeSensitive = c.kinds.some(
        (k) => k === 'market' || k === 'date' || k === 'number',
      );
      if (!current && timeSensitive) {
        const old = backing[0]!;
        const age = ageDays(old.observedAt, now);
        return {
          ...c,
          status: 'outdated',
          reason: old.stale
            ? `Backed only by ${old.label}, which is marked out of date.`
            : `Backed only by ${old.label}, seen ${age} days ago — check it still holds.`,
          source: ref(old),
        };
      }
      const s = current ?? backing[0]!;
      return {
        ...c,
        status: 'supported',
        reason: `Matches ${s.label}.`,
        source: ref(s),
      };
    }
    for (const s of trusted) {
      const conflict = conflictWith(s, c);
      if (conflict) {
        return {
          ...c,
          status: 'contradicted',
          reason: `Says ${conflict.claimed}, but ${s.label} says ${conflict.source}.`,
          source: ref(s),
          conflict,
        };
      }
    }
    const weak = unconfirmed.find((s) => carries(s, c));
    if (weak) {
      return {
        ...c,
        status: 'unverified',
        reason: `Only an unconfirmed detail backs it (${weak.label}) — confirm it before publishing.`,
        source: ref(weak),
      };
    }
    const what = c.absolutes.length
      ? `“${c.absolutes[0]}”`
      : c.facts.length
        ? c.facts.slice(0, 2).join(', ')
        : c.kinds.includes('business')
          ? 'this statement about the business'
          : 'this claim';
    return {
      ...c,
      status: 'unsupported',
      reason: `Nothing Aura trusts supports ${what}.`,
      source: null,
    };
  });

  // A person can vouch for a statement; not for a figure or an absolute that
  // nothing backs, and not for a contradiction.
  const withFix: CheckedClaim[] = checked.map((c) => ({
    ...c,
    mustFix:
      c.status === 'contradicted' ||
      (c.status === 'unsupported' &&
        (c.absolutes.length > 0 || c.facts.some((f) => /\d/.test(f)))),
  }));

  const counts: Record<ClaimStatus, number> = {
    supported: 0,
    unverified: 0,
    outdated: 0,
    contradicted: 0,
    unsupported: 0,
  };
  for (const c of checked) counts[c.status] += 1;
  const byKind = new Map<TrustedSource['kind'], number>();
  for (const s of args.sources)
    byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);

  return {
    version: FACT_CHECK_VERSION,
    checkedAt: now.toISOString(),
    status:
      checked.length === 0
        ? 'nothing_to_check'
        : counts.contradicted
          ? 'contradicted'
          : counts.unsupported || counts.unverified || counts.outdated
            ? 'needs_review'
            : 'verified',
    claims: withFix,
    counts,
    mustFix: withFix.filter((c) => c.mustFix).length,
    checkedAgainst: [...byKind.entries()].map(([kind, count]) => ({
      kind,
      count,
    })),
  };
}

/** The claims a person has to look at — everything not supported. */
export function claimsToReview(r: FactCheckReport): CheckedClaim[] {
  return r.claims.filter((c) => c.status !== 'supported');
}
