/**
 * "What matters now" — the current business situation in a few lines.
 *
 * Built ONLY from what Aura has actually recorded:
 *
 *   · active, high-relevance OPPORTUNITIES (the Opportunity model), and
 *   · important CHANGES among current SIGNALS — a competitor changed its
 *     pricing, results moved between two periods, the market is talking about
 *     something — that no opportunity already covers.
 *
 * Every item is tied to the record it came from (`ref`), says why it matters
 * in words taken from that record, says how sure Aura is, and links to the
 * related recommendation when there is one.
 *
 * NO FABRICATION. When there is too little to go on, the section says so and
 * says what is missing (`state` and `gaps`) instead of producing filler:
 *
 *   ready         enough sources, something stands out
 *   limited       something stands out, but it rests on weak or partial data
 *   quiet         enough sources, nothing stands out right now
 *   insufficient  not enough information to say what matters
 *
 * Pure and client-safe; loaded by server/home/what-matters.service.ts.
 */

const DAY = 86_400_000;

export type Reliability = 'LOW' | 'MEDIUM' | 'HIGH';

export interface MattersOpportunity {
  id: string;
  title: string;
  typeLabel: string;
  status: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  priorityScore: number;
  confidence: Reliability;
  /** The detector's reasoning, first line. */
  why: string | null;
  daysLeft: number | null;
  detectedAt: Date;
  /** Signals it was built from. */
  signalIds: string[];
  /** Its recommendation still in play, if any. */
  recommendation: { id: string; title: string; status: string } | null;
}

export interface MattersSignal {
  id: string;
  source:
    'TRENDS' | 'COMPETITORS' | 'ANALYTICS' | 'MEMORY' | 'BUSINESS_CONTEXT';
  title: string;
  summary: string;
  reliability: Reliability;
  occurrences: number;
  strength: number | null;
  observedAt: Date;
  expiresAt: Date | null;
  contextMatches: string[];
  metadata: Record<string, unknown>;
  /** A recommendation in play that uses it as evidence. */
  recommendation: { id: string; title: string; status: string } | null;
  /** An active opportunity built from it. */
  opportunityId: string | null;
}

export interface Coverage {
  /** Keywords Aura follows in the market. */
  trendKeywords: number;
  competitorsTracked: number;
  /** Analytics periods recorded: two are needed to see a change. */
  resultPeriods: number;
  /** The business profile says what it is trying to achieve. */
  hasGoals: boolean;
  /** When Aura last collected signals; null = never. */
  lastCollectedAt: Date | null;
}

export interface MatterItem {
  key: string;
  kind: 'opportunity' | 'change';
  /** What is happening. */
  title: string;
  /** Why it matters, from the record itself. */
  why: string;
  /** Where it came from and when ("Competitors · 3 days ago"). */
  source: string;
  /** How sure Aura is, in words; `weak` marks an early or thin signal. */
  confidence: { label: string; weak: boolean };
  /** Time pressure, if any ("Closes in 3 days"). */
  urgency: string | null;
  /** The underlying record. */
  ref: { type: 'opportunity' | 'signal'; id: string };
  /** Where the record can be seen. */
  href: string;
  /** The related recommendation, or how to get one. */
  related: { label: string; href: string } | null;
}

export interface Gap {
  key: string;
  text: string;
  action: { label: string; href: string };
}

export interface WhatMatters {
  state: 'ready' | 'limited' | 'quiet' | 'insufficient';
  /** One sentence on the situation — only from the items, never invented. */
  summary: string;
  items: MatterItem[];
  /** What Aura is missing to say more. */
  gaps: Gap[];
  /** "Based on 12 current signals from market trends and competitors." */
  basis: string | null;
}

export const WHAT_MATTERS_LIMITS = {
  items: 5,
  opportunities: 3,
  /** A change older than this is not "now". */
  changeDays: 14,
  /** An opportunity at least this high, or closing within a week, is high-relevance. */
  relevantScore: 60,
} as const;

const SOURCE_LABEL: Record<MattersSignal['source'], string> = {
  TRENDS: 'Market trends',
  COMPETITORS: 'Competitors',
  ANALYTICS: 'Your results',
  MEMORY: 'What works for you',
  BUSINESS_CONTEXT: 'Your business',
};

const SOURCE_PAGE: Record<MattersSignal['source'], string> = {
  TRENDS: '/dashboard/trends',
  COMPETITORS: '/dashboard/competitors',
  ANALYTICS: '/dashboard/analytics',
  MEMORY: '/dashboard/memory',
  BUSINESS_CONTEXT: '/dashboard/business',
};

const CONFIDENCE: Record<Reliability, { label: string; weak: boolean }> = {
  HIGH: { label: 'Strong evidence', weak: false },
  MEDIUM: { label: 'Good evidence', weak: false },
  LOW: { label: 'Early sign — limited evidence', weak: true },
};

const OPEN_RECOMMENDATION = ['GENERATED', 'PRESENTED'];
const YES_RECOMMENDATION = ['ACCEPTED', 'EDITED', 'IN_PROGRESS'];

function ago(at: Date, now: Date): string {
  const d = Math.floor((now.getTime() - at.getTime()) / DAY);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  return `${Math.floor(d / 7)} weeks ago`;
}

function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]["”’)]?$/.test(cap) ? cap : `${cap}.`;
}

function related(
  rec: { title: string; status: string } | null,
  opportunityId: string | null,
): MatterItem['related'] {
  if (rec && OPEN_RECOMMENDATION.includes(rec.status)) {
    return { label: 'See Aura’s suggestion', href: '/dashboard/suggestions' };
  }
  if (rec && YES_RECOMMENDATION.includes(rec.status)) {
    return {
      label: 'You said yes — see the next step',
      href: '/dashboard/suggestions',
    };
  }
  if (opportunityId) {
    return {
      label: 'Ask Aura for a suggestion',
      href: `/dashboard/opportunities?focus=${opportunityId}`,
    };
  }
  return null;
}

/** Is this opportunity worth a place in "what matters now"? */
export function isHighRelevance(o: MattersOpportunity): boolean {
  return (
    o.priority === 'HIGH' ||
    o.priority === 'URGENT' ||
    o.priorityScore >= WHAT_MATTERS_LIMITS.relevantScore ||
    (o.daysLeft !== null && o.daysLeft <= 7)
  );
}

/**
 * Is this signal a CHANGE worth telling a person about? Standing facts (a
 * competitor's current positioning, the business's own profile, a single
 * results period with nothing to compare against, a learned pattern) are
 * context, not news.
 */
export function isImportantChange(s: MattersSignal, now: Date): boolean {
  if (s.expiresAt && s.expiresAt <= now) return false;
  if (
    now.getTime() - s.observedAt.getTime() >
    WHAT_MATTERS_LIMITS.changeDays * DAY
  ) {
    return false;
  }
  switch (s.source) {
    case 'COMPETITORS':
      return s.metadata.change !== 'positioning';
    case 'ANALYTICS':
      return (
        typeof s.metadata.from === 'number' && typeof s.metadata.to === 'number'
      );
    case 'TRENDS':
      // One story from one weak source is noise until it is seen again or
      // relates to the business.
      return (
        s.reliability !== 'LOW' ||
        s.occurrences > 1 ||
        s.contextMatches.length > 0
      );
    default:
      return false;
  }
}

/** Why a change matters — only from what the signal itself records. */
export function whyChangeMatters(s: MattersSignal): string {
  const m = s.metadata;
  if (s.source === 'ANALYTICS') {
    const from = m.from as number;
    const to = m.to as number;
    return to < from
      ? `${sentence(s.summary)} Worth finding out why before it goes further.`
      : `${sentence(s.summary)} Worth understanding so you can do more of it.`;
  }
  if (s.source === 'COMPETITORS') {
    const who =
      typeof m.competitor === 'string' ? m.competitor : 'A competitor';
    const what =
      m.change === 'pricing'
        ? `Buyers comparing you with ${who} will see the new prices.`
        : m.change === 'homepage'
          ? `${who} is changing how it presents itself to the same buyers.`
          : m.change === 'release'
            ? `${who} has something new to talk about.`
            : `${who} is active — buyers comparing options may notice.`;
    return `${sentence(s.summary)} ${what}`;
  }
  // TRENDS
  const keyword = s.contextMatches
    .find((c) => c.startsWith('keyword:'))
    ?.slice('keyword:'.length);
  return keyword
    ? `Your market is talking about this, and it relates to “${keyword}”, which you follow.`
    : s.occurrences > 1
      ? `Seen in ${s.occurrences} places — your market is talking about this.`
      : 'Your market is talking about this.';
}

function rank(r: Reliability): number {
  return r === 'HIGH' ? 3 : r === 'MEDIUM' ? 2 : 1;
}

export function buildWhatMatters(
  input: {
    opportunities: MattersOpportunity[];
    signals: MattersSignal[];
    coverage: Coverage;
  },
  now: Date = new Date(),
): WhatMatters {
  const { coverage } = input;
  const L = WHAT_MATTERS_LIMITS;

  // --- What Aura is missing --------------------------------------------------
  const gaps: Gap[] = [];
  if (coverage.trendKeywords === 0) {
    gaps.push({
      key: 'trends',
      text: 'Aura isn’t following any topics in your market yet.',
      action: { label: 'Choose topics', href: '/dashboard/trends' },
    });
  }
  if (coverage.competitorsTracked === 0) {
    gaps.push({
      key: 'competitors',
      text: 'No competitors are being tracked, so Aura can’t see their moves.',
      action: { label: 'Add competitors', href: '/dashboard/competitors' },
    });
  }
  if (coverage.resultPeriods < 2) {
    gaps.push({
      key: 'results',
      text:
        coverage.resultPeriods === 0
          ? 'No results recorded yet, so Aura can’t tell what is working.'
          : 'Only one period of results so far — two are needed to see a change.',
      action: { label: 'See results', href: '/dashboard/analytics' },
    });
  }
  if (!coverage.hasGoals) {
    gaps.push({
      key: 'goals',
      text: 'Your goals aren’t set, so Aura can’t tell what matters most to you.',
      action: { label: 'Add your goals', href: '/dashboard/business' },
    });
  }

  // --- Opportunities ---------------------------------------------------------
  const opps = input.opportunities
    .filter(isHighRelevance)
    .sort(
      (a, b) =>
        Number(a.confidence === 'LOW') - Number(b.confidence === 'LOW') ||
        (a.daysLeft ?? 999) - (b.daysLeft ?? 999) ||
        b.priorityScore - a.priorityScore ||
        a.id.localeCompare(b.id),
    )
    .slice(0, L.opportunities);
  const covered = new Set(opps.flatMap((o) => o.signalIds));
  const oppItems: MatterItem[] = opps.map((o) => ({
    key: `opportunity:${o.id}`,
    kind: 'opportunity',
    title: o.title,
    why: o.why ? sentence(o.why) : `${o.typeLabel} Aura found in your data.`,
    source: `${o.typeLabel} · spotted ${ago(o.detectedAt, now)}`,
    confidence: CONFIDENCE[o.confidence],
    urgency:
      o.daysLeft === null || o.daysLeft > 14
        ? null
        : o.daysLeft <= 0
          ? 'Closes today'
          : o.daysLeft === 1
            ? 'Closes tomorrow'
            : `Closes in ${o.daysLeft} days`,
    ref: { type: 'opportunity', id: o.id },
    href: `/dashboard/opportunities?focus=${o.id}`,
    related: related(o.recommendation, o.id),
  }));

  // --- Changes no opportunity covers -----------------------------------------
  const changes = input.signals
    .filter((s) => isImportantChange(s, now) && !covered.has(s.id))
    .sort(
      (a, b) =>
        rank(b.reliability) - rank(a.reliability) ||
        Math.abs(b.strength ?? 0) - Math.abs(a.strength ?? 0) ||
        b.observedAt.getTime() - a.observedAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  const changeItems: MatterItem[] = changes
    .slice(0, L.items - oppItems.length)
    .map((s) => ({
      key: `signal:${s.id}`,
      kind: 'change',
      title: s.title,
      why: whyChangeMatters(s),
      source: `${SOURCE_LABEL[s.source]} · ${ago(s.observedAt, now)}`,
      confidence: CONFIDENCE[s.reliability],
      urgency: null,
      ref: { type: 'signal', id: s.id },
      href: s.opportunityId
        ? `/dashboard/opportunities?focus=${s.opportunityId}`
        : SOURCE_PAGE[s.source],
      related: related(s.recommendation, s.opportunityId),
    }));

  // Strong before weak; opportunities before changes at equal strength.
  const items = [...oppItems, ...changeItems].sort(
    (a, b) => Number(a.confidence.weak) - Number(b.confidence.weak),
  );

  // --- State and summary (from the items only) -------------------------------
  const current = input.signals.filter(
    (s) => !s.expiresAt || s.expiresAt > now,
  );
  const sources = [
    ...new Set(current.map((s) => SOURCE_LABEL[s.source].toLowerCase())),
  ];
  const basis = current.length
    ? `Based on ${current.length} current signal${current.length === 1 ? '' : 's'} from ${listWords(sources)}${
        coverage.lastCollectedAt
          ? `, last checked ${ago(coverage.lastCollectedAt, now)}`
          : ''
      }.`
    : null;
  // Too little to say anything: no current signals and no open opportunities.
  const nothingToGoOn =
    current.length === 0 && input.opportunities.length === 0;
  const thin = gaps.length >= 3;
  const state: WhatMatters['state'] = nothingToGoOn
    ? 'insufficient'
    : items.length === 0
      ? thin
        ? 'insufficient'
        : 'quiet'
      : items.every((i) => i.confidence.weak) || thin
        ? 'limited'
        : 'ready';

  return {
    state,
    summary: summarize(state, oppItems, changeItems),
    items,
    gaps,
    basis,
  };
}

function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function summarize(
  state: WhatMatters['state'],
  opps: MatterItem[],
  changes: MatterItem[],
): string {
  if (state === 'insufficient') {
    return 'Aura doesn’t have enough information yet to say what matters for your business.';
  }
  if (state === 'quiet') {
    return 'Nothing stands out right now. Aura will flag anything that changes.';
  }
  const parts: string[] = [];
  if (opps.length) {
    const closing = opps.filter((o) => o.urgency).length;
    parts.push(
      `${opps.length} opportunit${opps.length === 1 ? 'y' : 'ies'} worth acting on${
        closing ? ` (${closing} closing soon)` : ''
      }`,
    );
  }
  if (changes.length) {
    parts.push(
      `${changes.length} change${changes.length === 1 ? '' : 's'} to know about`,
    );
  }
  const line = `${parts.join(' and ')}.`;
  return state === 'limited'
    ? `${line.charAt(0).toUpperCase()}${line.slice(1)} Some of this rests on limited information, so check the evidence before acting.`
    : `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}
