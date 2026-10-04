import type { BadgeProps } from '@/components/ui/badge';
import {
  ACTIVE_STATUSES,
  OPPORTUNITY_TYPE_INFO,
  TRANSITIONS,
  type OpportunityConfidence,
  type OpportunityPriority,
  type OpportunitySource,
  type OpportunityStatus,
  type OpportunityType,
  type SignalKind,
} from '@/lib/opportunities';
import type { SignalReliability, SignalSource } from '@/lib/signals';

/**
 * The Opportunities view: how a stored opportunity is shown to a person.
 *
 * Pure and client-safe. The page (app/dashboard/opportunities) loads rows and
 * turns them into OpportunityView with toOpportunityView; the component only
 * renders. Everything a person needs to judge an opportunity is answered
 * here: what it is, why Aura thinks it exists, what evidence that rests on
 * and where that evidence came from, how sure Aura is, whether it is still
 * open, and what to do next.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type StatusGroup = 'active' | 'accepted' | 'closed';

export const STATUS_INFO: Record<
  OpportunityStatus,
  {
    label: string;
    variant: BadgeProps['variant'];
    group: StatusGroup;
    description: string;
  }
> = {
  DETECTED: {
    label: 'New',
    variant: 'default',
    group: 'active',
    description: 'Found by Aura and not looked at yet.',
  },
  REVIEWED: {
    label: 'Reviewed',
    variant: 'secondary',
    group: 'active',
    description: 'Someone has looked at it; no decision yet.',
  },
  RECOMMENDED: {
    label: 'Recommended',
    variant: 'success',
    group: 'active',
    description: 'Put forward as worth acting on.',
  },
  ACCEPTED: {
    label: 'Accepted',
    variant: 'success',
    group: 'accepted',
    description: 'You decided to act on it.',
  },
  REJECTED: {
    label: 'Rejected',
    variant: 'destructive',
    group: 'closed',
    description:
      'You decided not to act on it. Aura will not propose the same evidence again.',
  },
  EXPIRED: {
    label: 'Expired',
    variant: 'muted',
    group: 'closed',
    description:
      'Its moment passed. It comes back only if detected again with fresh evidence.',
  },
};

export const SOURCE_LABEL: Record<OpportunitySource, string> = {
  ADVISOR: 'Campaign advisor',
  TRENDS: 'Market trends',
  COMPETITORS: 'Competitors',
  MEMORY: 'What works for you',
  ANALYTICS: 'Your results',
  BUSINESS_CONTEXT: 'Your business',
  AI_DETECTION: 'AI analysis',
  MANUAL: 'Added manually',
};

export const PRIORITY_INFO: Record<
  OpportunityPriority,
  { label: string; variant: BadgeProps['variant']; rank: number }
> = {
  URGENT: { label: 'Urgent', variant: 'destructive', rank: 4 },
  HIGH: { label: 'High priority', variant: 'warning', rank: 3 },
  MEDIUM: { label: 'Medium priority', variant: 'secondary', rank: 2 },
  LOW: { label: 'Low priority', variant: 'muted', rank: 1 },
};

export const CONFIDENCE_INFO: Record<
  OpportunityConfidence,
  { label: string; rank: number }
> = {
  HIGH: { label: 'High confidence', rank: 3 },
  MEDIUM: { label: 'Medium confidence', rank: 2 },
  LOW: { label: 'Low confidence', rank: 1 },
};

const EVIDENCE_KIND_LABEL: Record<SignalKind, string> = {
  COMPETITOR_SNAPSHOT: 'Competitor change',
  TREND_ITEM: 'Market story',
  MEMORY_INSIGHT: 'Learned pattern',
  CONTENT_DRAFT: 'Your content',
  ANALYTICS_REPORT: 'Your results',
  KNOWLEDGE_CHUNK: 'Your documents',
  LEAD_SIGNAL: 'Lead activity',
  BUSINESS_CONTEXT: 'Your business',
  EXTERNAL: 'External source',
};

/** Where in Aura the record behind each kind of evidence can be seen. */
const EVIDENCE_PAGE: Partial<
  Record<SignalKind, { href: string; label: string }>
> = {
  COMPETITOR_SNAPSHOT: {
    href: '/dashboard/competitors',
    label: 'Open in Competitors',
  },
  TREND_ITEM: { href: '/dashboard/trends', label: 'Open in Market trends' },
  MEMORY_INSIGHT: {
    href: '/dashboard/memory',
    label: 'Open in What works for you',
  },
  CONTENT_DRAFT: {
    href: '/dashboard/content',
    label: 'Open in Content Studio',
  },
  ANALYTICS_REPORT: { href: '/dashboard/analytics', label: 'Open in Results' },
  KNOWLEDGE_CHUNK: {
    href: '/dashboard/settings/knowledge-base',
    label: 'Open in Knowledge base',
  },
  LEAD_SIGNAL: { href: '/dashboard/leads', label: 'Open in Leads' },
  BUSINESS_CONTEXT: {
    href: '/dashboard/business',
    label: 'Open About my business',
  },
};

const SIGNAL_SOURCE_LABEL: Record<SignalSource, string> = {
  TRENDS: 'Market trends',
  COMPETITORS: 'Competitors',
  ANALYTICS: 'Your results',
  MEMORY: 'What works for you',
  BUSINESS_CONTEXT: 'Your business',
};

// ---------------------------------------------------------------------------
// The view model
// ---------------------------------------------------------------------------

/** A stored opportunity as the page loads it (Prisma row, structurally). */
export interface OpportunityRow {
  id: string;
  type: OpportunityType;
  status: OpportunityStatus;
  title: string;
  summary: string;
  rationale: string | null;
  angle: string | null;
  details: unknown;
  source: OpportunitySource;
  detectedBy: string;
  priority: OpportunityPriority;
  priorityScore: number;
  confidence: OpportunityConfidence;
  confidenceReason: string | null;
  detectedAt: Date;
  lastSeenAt: Date;
  relevantUntil: Date | null;
  statusChangedAt: Date;
  decisionNote: string | null;
  expiredAt: Date | null;
  signals: {
    id: string;
    kind: SignalKind;
    refId: string | null;
    label: string;
    detail: string;
    url: string | null;
    observedAt: Date | null;
    signalId: string | null;
    signal: {
      source: SignalSource;
      reliability: SignalReliability;
      reliabilityReason: string;
      occurrences: number;
      expiresAt: Date | null;
    } | null;
  }[];
  events: {
    id: string;
    fromStatus: OpportunityStatus | null;
    toStatus: OpportunityStatus;
    actorId: string | null;
    note: string | null;
    createdAt: Date;
  }[];
}

export interface EvidenceView {
  id: string;
  kindLabel: string;
  label: string;
  detail: string;
  observedAt: string | null;
  /** The page in Aura where the underlying record lives. */
  sourcePage: { href: string; label: string } | null;
  /** The original article, release or page, when there is one. */
  externalUrl: string | null;
  /** The normalised signal it came through, when it did. */
  signal: {
    id: string;
    source: string;
    reliability: SignalReliability;
    reliabilityReason: string;
    occurrences: number;
    expired: boolean;
  } | null;
  /** Linked to a signal that has since been pruned from the store. */
  signalRemoved: boolean;
  /** How this piece of evidence supports the opportunity, when the detector said. */
  supports: string | null;
}

export interface NextStep {
  /** What to do, in a sentence. */
  text: string;
  /** Where to go to do it, when that is somewhere in Aura. */
  link: { href: string; label: string } | null;
}

export interface OpportunityView {
  id: string;
  type: OpportunityType;
  typeLabel: string;
  status: OpportunityStatus;
  statusGroup: StatusGroup;
  title: string;
  /** What it is. Null when it is the same text as the reasoning in `why`. */
  summary: string | null;
  /** Why Aura identified it: the detector's reasoning, then its criteria. */
  why: string[];
  angle: string | null;
  source: OpportunitySource;
  sourceLabel: string;
  /** Which rule or model found it, in words. */
  detectedByLabel: string;
  priority: OpportunityPriority;
  priorityScore: number;
  confidence: OpportunityConfidence;
  confidenceReason: string | null;
  detectedAt: string;
  lastSeenAt: string;
  relevantUntil: string | null;
  /** Whole days until it stops being relevant; null = no expiry or closed. */
  daysLeft: number | null;
  statusChangedAt: string;
  decisionNote: string | null;
  evidence: EvidenceView[];
  history: {
    id: string;
    from: OpportunityStatus | null;
    to: OpportunityStatus;
    byPerson: boolean;
    note: string | null;
    at: string;
  }[];
  /** Statuses a person may move it to from here. */
  transitions: OpportunityStatus[];
  nextStep: NextStep;
  warnings: string[];
}

const DAY = 86_400_000;
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** "rule:competitor-move" → "Rule: competitor move"; "ai:claude-x" → "AI analysis (claude-x)". */
export function detectedByLabel(detectedBy: string): string {
  if (detectedBy.startsWith('rule:')) {
    return `Rule: ${detectedBy.slice(5).replace(/-/g, ' ')}`;
  }
  if (detectedBy.startsWith('ai:'))
    return `AI analysis (${detectedBy.slice(3)})`;
  if (detectedBy === 'deterministic') return 'Advisor rules (no AI)';
  return `AI advisor (${detectedBy})`;
}

/**
 * What to do next. Open opportunities need a decision; an accepted one needs
 * acting on, and where depends on what kind of opening it is; closed ones
 * say why there is nothing to do.
 */
export function nextStepFor(o: {
  type: OpportunityType;
  status: OpportunityStatus;
  title: string;
  angle: string | null;
}): NextStep {
  switch (o.status) {
    case 'DETECTED':
      return {
        text: 'Check the evidence, then mark it reviewed, recommend it, or reject it.',
        link: null,
      };
    case 'REVIEWED':
      return {
        text: 'Decide: recommend it to the team, accept it, or reject it.',
        link: null,
      };
    case 'RECOMMENDED':
      return { text: 'Accept it to act on it, or reject it.', link: null };
    case 'REJECTED':
      return {
        text: 'Nothing to do. Reopen it if you change your mind.',
        link: null,
      };
    case 'EXPIRED':
      return {
        text: 'Nothing to do — its moment has passed.',
        link: null,
      };
    case 'ACCEPTED':
      break;
  }
  switch (o.type) {
    case 'TRENDING_TOPIC':
    case 'CONTENT_GAP':
    case 'SEASONAL_MOMENT':
      return {
        text: 'Write a post on it while it is current.',
        // Straight into Content Studio with this opportunity as the brief.
        link: {
          href: `/dashboard/content/new?brief=${encodeURIComponent(
            o.angle ? `${o.title}\n\nAngle: ${o.angle}` : o.title,
          )}`,
          label: 'Draft a post',
        },
      };
    case 'COMPETITOR_MOVE':
    case 'COMPETITIVE_GAP':
      return {
        text: 'Compare your positioning, then publish your answer.',
        link: { href: '/dashboard/competitors', label: 'Open Competitors' },
      };
    case 'CHANNEL':
      return {
        text: 'Connect the channel so Aura can publish and measure it.',
        link: { href: '/dashboard/connectors', label: 'Connect channel' },
      };
    case 'PERFORMANCE_PATTERN':
      return {
        text: 'Build it into next month’s plan.',
        link: { href: '/dashboard/planner', label: 'Open Content plan' },
      };
    case 'AUDIENCE_SEGMENT':
      return {
        text: 'Add this audience to your business profile, then plan content for it.',
        link: { href: '/dashboard/business', label: 'Update audience' },
      };
    default:
      return {
        text: 'Plan how you will act on it.',
        link: { href: '/dashboard/planner', label: 'Open Content plan' },
      };
  }
}

export function toOpportunityView(
  o: OpportunityRow,
  now: Date,
): OpportunityView {
  const details = record(o.details);
  const ai = record(details.ai);
  const aiSupports = new Map<string, string>();
  for (const e of Array.isArray(ai.evidence) ? ai.evidence : []) {
    const r = record(e);
    if (typeof r.signalId === 'string' && typeof r.supports === 'string') {
      aiSupports.set(r.signalId, r.supports);
    }
  }

  // WHY — the detector's own explanation first, then the checkable criteria
  // a rule fired on (stored in details), without repeating the rationale.
  const why: string[] = [];
  if (o.rationale) why.push(o.rationale);
  for (const c of strings(details.criteria)) {
    if (!o.rationale?.includes(c)) why.push(c);
  }
  if (typeof details.timing === 'string' && details.timing) {
    why.push(`Timing: ${details.timing}`);
  }

  const active = ACTIVE_STATUSES.includes(o.status);
  const daysLeft =
    active && o.relevantUntil
      ? Math.max(
          0,
          Math.ceil((o.relevantUntil.getTime() - now.getTime()) / DAY),
        )
      : null;

  return {
    id: o.id,
    type: o.type,
    typeLabel: OPPORTUNITY_TYPE_INFO[o.type].label,
    status: o.status,
    statusGroup: STATUS_INFO[o.status].group,
    title: o.title,
    summary: o.rationale === o.summary ? null : o.summary,
    why,
    angle: o.angle,
    source: o.source,
    sourceLabel: SOURCE_LABEL[o.source],
    detectedByLabel: detectedByLabel(o.detectedBy),
    priority: o.priority,
    priorityScore: o.priorityScore,
    confidence: o.confidence,
    confidenceReason: o.confidenceReason,
    detectedAt: o.detectedAt.toISOString(),
    lastSeenAt: o.lastSeenAt.toISOString(),
    relevantUntil: o.relevantUntil?.toISOString() ?? null,
    daysLeft,
    statusChangedAt: o.statusChangedAt.toISOString(),
    decisionNote: o.decisionNote,
    evidence: o.signals.map((s) => ({
      id: s.id,
      kindLabel: EVIDENCE_KIND_LABEL[s.kind],
      label: s.label,
      detail: s.detail,
      observedAt: s.observedAt?.toISOString() ?? null,
      sourcePage: EVIDENCE_PAGE[s.kind] ?? null,
      externalUrl: s.url && /^https?:\/\//i.test(s.url) ? s.url : null,
      signal:
        s.signalId && s.signal
          ? {
              id: s.signalId,
              source: SIGNAL_SOURCE_LABEL[s.signal.source],
              reliability: s.signal.reliability,
              reliabilityReason: s.signal.reliabilityReason,
              occurrences: s.signal.occurrences,
              expired: s.signal.expiresAt !== null && s.signal.expiresAt <= now,
            }
          : null,
      signalRemoved: Boolean(s.signalId) && !s.signal,
      supports: (s.signalId && aiSupports.get(s.signalId)) || null,
    })),
    history: o.events.map((e) => ({
      id: e.id,
      from: e.fromStatus,
      to: e.toStatus,
      byPerson: e.actorId !== null,
      note: e.note,
      at: e.createdAt.toISOString(),
    })),
    transitions: TRANSITIONS[o.status],
    nextStep: nextStepFor(o),
    warnings: strings(ai.warnings),
  };
}

// ---------------------------------------------------------------------------
// Filtering and sorting
// ---------------------------------------------------------------------------

export const STATUS_FILTERS = [
  { id: 'active', label: 'Open' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'closed', label: 'Rejected & expired' },
  { id: 'all', label: 'All' },
] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number]['id'];

export const SORTS = [
  { id: 'priority', label: 'Priority' },
  { id: 'newest', label: 'Newest' },
  { id: 'closing', label: 'Closing soonest' },
  { id: 'confidence', label: 'Confidence' },
] as const;
export type SortId = (typeof SORTS)[number]['id'];

export interface OpportunityFilters {
  status: StatusFilter;
  type: OpportunityType | 'all';
  source: OpportunitySource | 'all';
  sort: SortId;
}

export const DEFAULT_FILTERS: OpportunityFilters = {
  status: 'active',
  type: 'all',
  source: 'all',
  sort: 'priority',
};

const time = (iso: string | null) =>
  iso ? new Date(iso).getTime() : Number.POSITIVE_INFINITY;

export function filterOpportunities(
  list: OpportunityView[],
  f: OpportunityFilters,
): OpportunityView[] {
  const out = list.filter(
    (o) =>
      (f.status === 'all' || o.statusGroup === f.status) &&
      (f.type === 'all' || o.type === f.type) &&
      (f.source === 'all' || o.source === f.source),
  );
  const byPriority = (a: OpportunityView, b: OpportunityView) =>
    PRIORITY_INFO[b.priority].rank - PRIORITY_INFO[a.priority].rank ||
    b.priorityScore - a.priorityScore;
  const newest = (a: OpportunityView, b: OpportunityView) =>
    time(b.detectedAt) - time(a.detectedAt);
  const compare: Record<
    SortId,
    (a: OpportunityView, b: OpportunityView) => number
  > = {
    priority: (a, b) => byPriority(a, b) || newest(a, b),
    newest,
    // No expiry sorts last; ties by priority.
    closing: (a, b) =>
      time(a.relevantUntil) - time(b.relevantUntil) || byPriority(a, b),
    confidence: (a, b) =>
      CONFIDENCE_INFO[b.confidence].rank - CONFIDENCE_INFO[a.confidence].rank ||
      byPriority(a, b),
  };
  // Whatever the sort, open opportunities come before decided and closed
  // ones — "All" should not lead with things nobody can act on any more.
  const group = { active: 0, accepted: 1, closed: 2 } as const;
  return out.sort(
    (a, b) =>
      group[a.statusGroup] - group[b.statusGroup] || compare[f.sort](a, b),
  );
}

/** How many in each status group, for the filter labels. */
export function countByGroup(
  list: OpportunityView[],
): Record<StatusFilter, number> {
  const counts = { active: 0, accepted: 0, closed: 0, all: list.length };
  for (const o of list) counts[o.statusGroup] += 1;
  return counts;
}

/** The action a transition button offers, in words. */
export function transitionLabel(
  from: OpportunityStatus,
  to: OpportunityStatus,
): string {
  if (from === 'REJECTED' && to === 'REVIEWED') return 'Reopen';
  switch (to) {
    case 'REVIEWED':
      return 'Mark reviewed';
    case 'RECOMMENDED':
      return 'Recommend';
    case 'ACCEPTED':
      return 'Accept';
    case 'REJECTED':
      return 'Reject';
    default:
      return STATUS_INFO[to].label;
  }
}

/** People never expire an opportunity by hand; time does. */
export function personTransitions(o: OpportunityView): OpportunityStatus[] {
  return o.transitions.filter((s) => s !== 'EXPIRED');
}
