import type { OpportunityConfidence, SignalKind } from '@/lib/opportunities';
import type { Band, RankingFactor } from '@/lib/recommendation-ranking';
import { LOW_CONFIDENCE_BLOCKER } from '@/lib/recommendation-rules';
import { AURA_MODULES, type AuraModuleId } from '@/lib/aura-modules';
import {
  ACCEPTED_RECOMMENDATION_STATUSES,
  OPEN_RECOMMENDATION_STATUSES,
  executionBrief,
  type RecommendationStatus,
  type RecommendationType,
} from '@/lib/recommendations';

/**
 * "Aura Suggests" — a recommendation as a person reads it.
 *
 * The Recommendation model already holds every part (what, why, expected
 * outcome, evidence, the workflow that carries it out). This turns it into
 * plain language, with no technical context needed:
 *
 *   What              the title and the action, in the business's terms
 *   Why               the reasoning, without the engine's bookkeeping
 *   Expected outcome  what doing it is meant to achieve
 *   Based on          the kinds of information behind it ("Trend signal",
 *                     "Recent content performance", "Business goals"), with
 *                     each piece of evidence one click away
 *   Next step         one clear action (Create content, Add to your plan, …),
 *                     plus Edit and Skip
 *
 * No scores, enum names, ids or confidence codes reach the person: confidence
 * is said in words, timing in days, problems as what to do about them.
 *
 * Pure and client-safe. Loaded by server/recommendations/suggestions.service.ts.
 */

const DAY = 86_400_000;

/** What each kind of evidence is, said plainly. */
export const EVIDENCE_SOURCE_LABEL: Record<SignalKind, string> = {
  TREND_ITEM: 'Trend signal',
  COMPETITOR_SNAPSHOT: 'Competitor activity',
  ANALYTICS_REPORT: 'Recent content performance',
  MEMORY_INSIGHT: 'What has worked for you before',
  CONTENT_DRAFT: 'Your recent content',
  KNOWLEDGE_CHUNK: 'Your business documents',
  LEAD_SIGNAL: 'Customer interest',
  BUSINESS_CONTEXT: 'Your business profile',
  EXTERNAL: 'Outside source',
};

/** The parts of the business profile a recommendation drew on, said plainly. */
const CONTEXT_SOURCE_LABEL: [RegExp, string][] = [
  [/^(objectives|goals|campaigns)\b/, 'Business goals'],
  [/^audience\b/, 'Your audience'],
  [/^identity\b/, 'What your business offers'],
  [/^channels\b/, 'The channels you use'],
  [/^(voice|brand)\b/, 'Your brand voice'],
];

export function contextSourceLabel(field: string): string {
  return (
    CONTEXT_SOURCE_LABEL.find(([re]) => re.test(field))?.[1] ??
    'Your business profile'
  );
}

const CONFIDENCE_WORDS: Record<OpportunityConfidence, string> = {
  HIGH: 'Strong evidence',
  MEDIUM: 'Good evidence',
  LOW: 'Early signal — worth a look at the evidence first',
};

const BAND_WORDS: Record<Band, string> = {
  now: 'Top pick',
  next: 'Up next',
  later: 'When you have time',
  hidden: 'Set aside for now',
};

export interface SuggestionSource {
  id: string;
  opportunityId: string;
  type: RecommendationType;
  status: RecommendationStatus;
  title: string;
  summary: string;
  action: string;
  steps: string[];
  rationale: string;
  expectedOutcome: string;
  channel: string | null;
  contentType: string | null;
  audience: string | null;
  details: unknown;
  confidence: OpportunityConfidence;
  relevantUntil: Date | null;
  executable: boolean;
  blockers: string[];
  contextFields: string[];
  evidence: {
    id: string;
    kind: SignalKind;
    label: string;
    detail: string;
    url: string | null;
    observedAt: Date | null;
    current: boolean;
  }[];
}

export interface SuggestionRanking {
  rank: number;
  band: Band;
  factors: RankingFactor[];
  resurfaced: boolean;
}

export interface SuggestionEvidence {
  id: string;
  /** What kind of information it is ("Trend signal"). */
  source: string;
  label: string;
  detail: string;
  url: string | null;
  /** "3 days ago", or null when not known. */
  seen: string | null;
  /** Still current, or since superseded. */
  current: boolean;
}

export interface SuggestionView {
  id: string;
  status: RecommendationStatus;
  /** Waiting for an answer, or already a yes. */
  stage: 'open' | 'accepted';
  /** What: the headline, and what to do. */
  what: string;
  action: string;
  steps: string[];
  /** Why: Aura's reasoning, in plain words. */
  why: string;
  /** Why it is near the top right now (goal match, closing soon, …). */
  whyNow: string[];
  expectedOutcome: string;
  /** Based on: each kind of information behind it, once. */
  basedOn: string[];
  evidence: SuggestionEvidence[];
  /** How sure Aura is, in words. */
  confidence: string;
  /** "Best done within 5 days", or null when there is no rush. */
  timing: string | null;
  /** "Top pick", "Up next", … */
  place: string;
  rank: number;
  /** Back after "Not now". */
  resurfaced: boolean;
  channel: string | null;
  /** A note to read before acting, e.g. the evidence is thin. */
  caution: string | null;
  /** The clear next action. */
  next: {
    label: string;
    href: string;
    /** Taking it also says yes to the suggestion (it is still open). */
    accepts: boolean;
    /** Something must be fixed first; the action leads there instead. */
    blocked: string | null;
    /** The Aura module it leads to (lib/aura-modules.ts). */
    module: AuraModuleId;
    moduleLabel: string;
    /** Other modules that help, each carrying the recommendation. */
    related: { label: string; href: string }[];
  };
  /** Editable fields as they are now, to prefill Edit. */
  editable: {
    title: string;
    action: string;
    steps: string[];
    expectedOutcome: string;
    channel: string | null;
  };
}

/**
 * The engine appends its own bookkeeping to the reasoning ("Based on 2
 * pieces of evidence: …"). The evidence is shown on its own, so that
 * sentence is dropped from Why; what follows it (why this action fits) stays.
 */
export function plainWhy(rationale: string): string {
  const m = /\s*Based on \d+ pieces? of evidence: /.exec(rationale);
  let base = rationale;
  let fit = '';
  if (m) {
    base = rationale.slice(0, m.index);
    const rest = rationale.slice(m.index + m[0].length);
    const f = /\s[A-Z][^.;:]*? fits because /.exec(rest);
    fit = f ? rest.slice(f.index) : '';
  }
  return [sentence(base), sentence(fit)]
    .filter(Boolean)
    .join(' ')
    .replace(/\bthe business’s\b/g, 'your')
    .replace(/\bthe business publishes\b/g, 'you publish')
    .replace(
      /\ba format the business learned works\b/g,
      'a format that works for you',
    )
    .replace(/\b(\d+) ([a-z]+)\(s\)/g, (_, n: string, w: string) =>
      n === '1' ? `${n} ${w}` : `${n} ${w}s`,
    );
}

/** Capitalised, single-spaced, ending in a full stop. */
function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]["”’)]?$/.test(cap) ? cap : `${cap}.`;
}

/** A blocker, as what the person should know or do. */
export function plainBlocker(blocker: string): string {
  if (blocker === LOW_CONFIDENCE_BLOCKER) {
    return 'Aura is less sure about this one — look over the evidence before you go ahead.';
  }
  let m = /^Aura cannot connect (.+) yet\.$/.exec(blocker);
  if (m)
    return `Aura can’t connect ${m[1]} yet, so this can’t be done from here.`;
  m = /^(.+) is not a channel the business uses\.$/.exec(blocker);
  if (m) {
    return `You don’t post on ${m[1]} at the moment. Edit the suggestion to pick a channel you use.`;
  }
  return blocker;
}

/** A ranking reason worth telling the person, rephrased where needed. */
function plainReason(f: RankingFactor): string | null {
  if (f.points <= 0) return null;
  if (!['goals', 'timing', 'history', 'evidence'].includes(f.factor)) {
    return null;
  }
  let s = f.why;
  const m = /^closes in (\d+) day\(s\)$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    s =
      n <= 0
        ? 'it’s only relevant for today'
        : `it’s only relevant for ${n} more day${n === 1 ? '' : 's'}`;
  } else if (s === 'closes within a week') {
    s = 'it’s only relevant for about another week';
  } else if (/^\d+ current pieces of evidence$/.test(s)) {
    s = 'more than one source points the same way';
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ago(at: Date | null, now: Date): string | null {
  if (!at) return null;
  const d = Math.floor((now.getTime() - at.getTime()) / DAY);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.floor(d / 7)} weeks ago`;
  return `${Math.floor(d / 30)} months ago`;
}

export function toSuggestion(
  r: SuggestionSource,
  ranking: SuggestionRanking,
  now: Date = new Date(),
): SuggestionView {
  const open = OPEN_RECOMMENDATION_STATUSES.includes(r.status);
  const accepted = ACCEPTED_RECOMMENDATION_STATUSES.includes(r.status);
  // Saying yes is the review a low-confidence suggestion needs; anything
  // else blocking it (a channel) has to be fixed first.
  const lowConfidence = r.blockers.includes(LOW_CONFIDENCE_BLOCKER);
  const otherBlockers = r.blockers.filter((b) => b !== LOW_CONFIDENCE_BLOCKER);
  const brief = executionBrief({
    ...r,
    evidence: r.evidence,
    executable: otherBlockers.length === 0,
    blockers: otherBlockers,
  });

  const basedOn = [
    ...new Set([
      ...r.evidence.map((e) => EVIDENCE_SOURCE_LABEL[e.kind]),
      ...r.contextFields.map(contextSourceLabel),
    ]),
  ];
  const daysLeft = r.relevantUntil
    ? Math.ceil((r.relevantUntil.getTime() - now.getTime()) / DAY)
    : null;
  const timing =
    daysLeft === null || daysLeft > 21
      ? null
      : daysLeft <= 1
        ? 'Best done today'
        : `Best done within ${daysLeft} days`;

  return {
    id: r.id,
    status: r.status,
    stage: accepted || !open ? 'accepted' : 'open',
    what: r.title,
    action: r.action,
    steps: r.steps,
    why: plainWhy(r.rationale) || r.summary,
    whyNow: ranking.factors
      .map(plainReason)
      .filter((x): x is string => Boolean(x))
      .slice(0, 2),
    expectedOutcome: r.expectedOutcome,
    basedOn,
    evidence: r.evidence.map((e) => ({
      id: e.id,
      source: EVIDENCE_SOURCE_LABEL[e.kind],
      label: e.label,
      detail: e.detail,
      url: e.url,
      seen: ago(e.observedAt, now),
      current: e.current,
    })),
    confidence: CONFIDENCE_WORDS[r.confidence],
    timing,
    place: BAND_WORDS[ranking.band],
    rank: ranking.rank,
    resurfaced: ranking.resurfaced,
    channel: r.channel,
    caution: otherBlockers.length
      ? plainBlocker(otherBlockers[0]!)
      : lowConfidence && open
        ? plainBlocker(LOW_CONFIDENCE_BLOCKER)
        : null,
    next: {
      label: otherBlockers.length
        ? 'See what’s needed'
        : brief.verb,
      href: brief.href,
      accepts: open && otherBlockers.length === 0,
      blocked: otherBlockers.length ? plainBlocker(otherBlockers[0]!) : null,
      module: brief.module,
      moduleLabel: AURA_MODULES[brief.module].label,
      related: brief.related.map((d) => ({
        label: d.label,
        href: d.href,
      })),
    },
    editable: {
      title: r.title,
      action: r.action,
      steps: r.steps,
      expectedOutcome: r.expectedOutcome,
      channel: r.channel,
    },
  };
}

/**
 * Technical residue a person should never see in a suggestion: enum names
 * (TREND_ITEM), internal field names, scores. Used by the tests as the
 * "understandable without technical context" check.
 */
export const TECHNICAL_TOKENS: RegExp[] = [
  /\b[A-Z]{2,}_[A-Z_]{2,}\b/,
  /\b(GENERATED|PRESENTED|PROPOSED|HIGH|MEDIUM|LOW)\b/,
  /\bscore\b/i,
  /\bpriorityScore|confidenceReason|contextFields|opportunityId\b/,
  /\b(rule|ai):[a-z-]+/,
  /\bc[a-z0-9]{20,}\b/,
];

/** The text of a suggestion a person reads. */
export function readableText(s: SuggestionView): string[] {
  return [
    s.what,
    s.action,
    ...s.steps,
    s.why,
    ...s.whyNow,
    s.expectedOutcome,
    ...s.basedOn,
    ...s.evidence.flatMap((e) => [e.source, e.seen ?? '']),
    s.confidence,
    s.timing ?? '',
    s.place,
    s.caution ?? '',
    s.next.label,
    s.next.blocked ?? '',
  ];
}
