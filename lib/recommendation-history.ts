import { AURA_MODULES, type AuraModuleId } from '@/lib/aura-modules';
import { creationPlan } from '@/lib/recommendation-creation';
import { DUPLICATE_RULES } from '@/lib/recommendation-rules';
import {
  recommendationOutcome,
  type RecommendationOutcome,
  type RecommendationStatus,
} from '@/lib/recommendations';

/**
 * RECOMMENDATION HISTORY — what Aura suggested before, and what the business
 * did with it. Built from the lifecycle history (RecommendationEvent), so it
 * is a view, not a second record.
 *
 *   toHistoryEntry       one past recommendation as a person reads it:
 *                        outcome, when, by whom, what was changed, what was
 *                        made from it, and its originating opportunity
 *   repeatHold           whether Aura may suggest an opportunity again, from
 *                        what happened to its last suggestion (so a skip is
 *                        not answered by the same suggestion tomorrow)
 *   learningCandidates   patterns in the business's answers, shaped as
 *                        Marketing Memory insights (type, insight,
 *                        confidence, sampleSize, supportingDataSummary) —
 *                        ready to feed it, not yet written to it
 *
 * Pure and client-safe; loaded by server/recommendations/history.service.ts.
 */

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** What happened to a recommendation, as the history shows it. */
export type HistoryOutcome =
  | 'accepted'
  | 'edited'
  | 'in_progress'
  | 'completed'
  | 'skipped'
  | 'rejected'
  | 'withdrawn'
  | 'expired';

export const HISTORY_OUTCOMES: HistoryOutcome[] = [
  'accepted',
  'edited',
  'in_progress',
  'completed',
  'skipped',
  'rejected',
  'withdrawn',
  'expired',
];

export const OUTCOME_LABEL: Record<HistoryOutcome, string> = {
  accepted: 'Accepted',
  edited: 'Edited & accepted',
  in_progress: 'In progress',
  completed: 'Completed',
  skipped: 'Skipped',
  rejected: 'Turned down',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
};

/**
 * Where it ended up. Completed or in progress says where the work is; before
 * that, the first decision (lib/recommendations.ts recommendationOutcome).
 */
export function historyOutcome(
  status: RecommendationStatus,
  statusesSeen: RecommendationStatus[],
): HistoryOutcome | null {
  if (status === 'COMPLETED') return 'completed';
  if (status === 'IN_PROGRESS') return 'in_progress';
  const o: RecommendationOutcome = recommendationOutcome(statusesSeen);
  return o === 'undecided' ? null : o;
}

/** A "yes" — the business acted on it, as is or changed. */
export const YES_OUTCOMES: HistoryOutcome[] = [
  'accepted',
  'edited',
  'in_progress',
  'completed',
];

// ---------------------------------------------------------------------------
// One entry
// ---------------------------------------------------------------------------

export interface HistorySource {
  id: string;
  title: string;
  action: string;
  type: string;
  status: RecommendationStatus;
  channel: string | null;
  details: unknown;
  /** The rest of the recommendation, when loaded — for the Create action. */
  steps?: string[];
  rationale?: string;
  expectedOutcome?: string;
  contentType?: string | null;
  audience?: string | null;
  blockers?: string[];
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  editedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  expiredAt: Date | null;
  opportunity: {
    id: string;
    title: string;
    typeLabel: string;
    status: string;
  };
  events: {
    action: string;
    toStatus: RecommendationStatus;
    actorName: string | null;
    source: string;
    createdAt: Date;
    metadata: unknown;
  }[];
}

export interface HistoryEntry {
  id: string;
  title: string;
  action: string;
  channel: string | null;
  outcome: HistoryOutcome;
  outcomeLabel: string;
  /** When it was suggested, decided, last edited, started, completed — ISO. */
  suggestedAt: string;
  decidedAt: string | null;
  editedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Who decided, or "Aura" (it expired) / null (unknown). */
  decidedBy: string | null;
  /** Why, when the person said. */
  note: string | null;
  /** Fields a person changed, across every edit. */
  changedFields: string[];
  /** What Aura's modules made from it (a draft, a campaign). */
  made: { module: string; label: string; href: string | null }[];
  /**
   * Create from it (lib/recommendation-creation.ts) — on a suggestion said yes
   * to that makes something, so it can be picked up from the history too.
   */
  create: { label: string; href: string; creates: string } | null;
  /** The opportunity it came from, linkable. */
  opportunity: {
    id: string;
    title: string;
    typeLabel: string;
    href: string;
    status: string;
  };
  /** Each step, oldest first: what, by whom, when. */
  timeline: { action: string; by: string; at: string }[];
  /** Whether Aura will suggest something like it again, and when. */
  repeat: string | null;
}

const FIELD_LABEL: Record<string, string> = {
  title: 'headline',
  summary: 'summary',
  action: 'what to do',
  steps: 'steps',
  rationale: 'reason',
  expectedOutcome: 'expected outcome',
  outcomeMetric: 'metric',
  channel: 'channel',
  contentType: 'format',
  audience: 'audience',
};

const ACTION_LABEL: Record<string, string> = {
  generate: 'Suggested',
  present: 'Shown',
  accept: 'Accepted',
  edit: 'Edited',
  skip: 'Skipped',
  reject: 'Turned down',
  start: 'Started',
  complete: 'Completed',
  withdraw: 'Withdrawn',
  expire: 'Expired',
  defer: 'Set aside',
  link: 'Worked on',
};

function made(
  m: unknown,
): { module: string; label: string; href: string | null } | null {
  const meta = (m ?? {}) as {
    module?: string;
    created?: { type?: string; id?: string; label?: string | null };
  };
  if (!meta.module || !(meta.module in AURA_MODULES)) return null;
  const c = meta.created ?? {};
  const href =
    c.type === 'content-draft' && c.id
      ? `/dashboard/content/${c.id}`
      : c.type === 'campaign' && c.id
        ? `/dashboard/campaigns/${c.id}`
        : c.type === 'content-plan' && c.id
          ? `/dashboard/planner?month=${c.id}`
          : null;
  return {
    module: AURA_MODULES[meta.module as AuraModuleId].label,
    label: c.label ?? c.type ?? 'Created',
    href,
  };
}

/** The Create action for a said-yes suggestion that makes something; null otherwise. */
function createAction(r: HistorySource): HistoryEntry['create'] {
  if (
    r.steps === undefined ||
    r.rationale === undefined ||
    r.expectedOutcome === undefined
  ) {
    return null;
  }
  const plan = creationPlan({
    id: r.id,
    type: r.type as Parameters<typeof creationPlan>[0]['type'],
    title: r.title,
    action: r.action,
    steps: r.steps,
    rationale: r.rationale,
    expectedOutcome: r.expectedOutcome,
    channel: r.channel,
    contentType: r.contentType ?? null,
    audience: r.audience ?? null,
    details: r.details,
    status: r.status,
    blockers: r.blockers ?? [],
  });
  return plan.state === 'ready' && plan.creates
    ? { label: plan.label, href: plan.href, creates: plan.creates }
    : null;
}

export function toHistoryEntry(
  r: HistorySource,
  now: Date = new Date(),
): HistoryEntry | null {
  const outcome = historyOutcome(
    r.status,
    r.events.map((e) => e.toStatus),
  );
  if (!outcome) return null; // still waiting for an answer — not history yet

  const decision = r.events.find((e) =>
    ['accept', 'edit', 'skip', 'reject', 'withdraw', 'expire'].includes(
      e.action,
    ),
  );
  const changed = new Set<string>();
  for (const e of r.events) {
    if (e.action !== 'edit') continue;
    const changes = (e.metadata as { changes?: Record<string, unknown> } | null)
      ?.changes;
    for (const f of Object.keys(changes ?? {}))
      changed.add(FIELD_LABEL[f] ?? f);
  }
  const iso = (d: Date | null) => d?.toISOString() ?? null;

  return {
    id: r.id,
    title: r.title,
    action: r.action,
    channel: r.channel,
    outcome,
    outcomeLabel: OUTCOME_LABEL[outcome],
    suggestedAt: r.createdAt.toISOString(),
    decidedAt: iso(r.decidedAt ?? r.expiredAt ?? decision?.createdAt ?? null),
    editedAt: iso(r.editedAt),
    startedAt: iso(r.startedAt),
    completedAt: iso(r.completedAt),
    decidedBy:
      outcome === 'expired'
        ? 'Aura'
        : decision?.source === 'opportunity'
          ? `${decision.actorName ?? 'Someone'} (on the opportunity)`
          : (decision?.actorName ?? null),
    note: r.decisionNote,
    changedFields: [...changed],
    made: r.events
      .filter((e) => e.action === 'link')
      .map((e) => made(e.metadata))
      .filter((x): x is NonNullable<typeof x> => Boolean(x)),
    create: createAction(r),
    opportunity: {
      ...r.opportunity,
      href: `/dashboard/opportunities?focus=${r.opportunity.id}`,
    },
    timeline: r.events
      .filter((e) => e.action !== 'present')
      .map((e) => ({
        action: ACTION_LABEL[e.action] ?? e.action,
        by:
          e.source === 'engine' || e.source === 'system'
            ? 'Aura'
            : (e.actorName ?? 'Someone'),
        at: e.createdAt.toISOString(),
      })),
    repeat: repeatHold(
      {
        outcome,
        decidedAt: r.decidedAt ?? r.expiredAt,
        opportunityStatus: r.opportunity.status,
      },
      now,
    ).text,
  };
}

// ---------------------------------------------------------------------------
// Avoiding repetition
// ---------------------------------------------------------------------------

/** How long Aura waits before suggesting the same opportunity again. */
export const REPEAT_HOLD_DAYS: Partial<Record<HistoryOutcome, number>> = {
  /** "Not now" — not "no": ask again later, not tomorrow. */
  skipped: DUPLICATE_RULES.windowDays,
  /** Taken back by Aura (replaced) — the replacement stands for it. */
  withdrawn: DUPLICATE_RULES.windowDays,
  /** "No" — similar ones are held back for the rejection window. */
  rejected: DUPLICATE_RULES.rejectedWindowDays,
};

/**
 * May Aura suggest this opportunity again, given what happened to its last
 * suggestion? Used by the automatic suggestion pass; a person asking for a
 * recommendation explicitly is never held back.
 */
export function repeatHold(
  last: {
    outcome: HistoryOutcome;
    decidedAt: Date | null;
    opportunityStatus?: string;
  },
  now: Date,
): { held: boolean; until: Date | null; text: string | null } {
  if (YES_OUTCOMES.includes(last.outcome)) {
    return {
      held: true,
      until: null,
      text: 'Acted on — Aura won’t suggest it again.',
    };
  }
  const days = REPEAT_HOLD_DAYS[last.outcome];
  if (!days || !last.decidedAt) {
    return { held: false, until: null, text: null };
  }
  const until = new Date(last.decidedAt.getTime() + days * DAY);
  if (until <= now) {
    return {
      held: false,
      until,
      text: 'Aura may suggest it again if it still matters.',
    };
  }
  const left = Math.ceil((until.getTime() - now.getTime()) / DAY);
  return {
    held: true,
    until,
    text:
      last.outcome === 'rejected'
        ? `Similar suggestions are held back for ${left} more day${left === 1 ? '' : 's'}.`
        : `Aura won’t suggest it again for ${left} more day${left === 1 ? '' : 's'}.`,
  };
}

// ---------------------------------------------------------------------------
// Counts and learning
// ---------------------------------------------------------------------------

export function historyCounts(
  entries: { outcome: HistoryOutcome }[],
): Record<HistoryOutcome | 'all', number> {
  const out = Object.fromEntries(
    [...HISTORY_OUTCOMES, 'all'].map((k) => [k, 0]),
  ) as Record<HistoryOutcome | 'all', number>;
  for (const e of entries) {
    out[e.outcome] += 1;
    out.all += 1;
  }
  return out;
}

/** A pattern in the business's answers, shaped as a Marketing Memory insight. */
export interface LearningCandidate {
  insightType: 'CONTENT_FORMAT' | 'TOPIC' | 'OTHER';
  insight: string;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  sampleSize: number;
  supportingDataSummary: {
    source: 'recommendation_history';
    key: string;
    yes: number;
    no: number;
    recommendationIds: string[];
  };
}

/** Answers needed before a pattern is worth stating. */
export const LEARNING_MIN_SAMPLE = 4;

const confidenceFor = (n: number): LearningCandidate['confidence'] =>
  n >= 12 ? 'HIGH' : n >= 7 ? 'MEDIUM' : 'LOW';

const ACTION_NOUN: Record<string, string> = {
  post: 'single posts',
  series: 'post series',
  article: 'articles',
  'response-post': 'responses to competitors',
  'comparison-article': 'comparison articles',
  'targeted-post': 'posts for a specific audience',
  'recovery-post': 'posts to win back a drop',
  'apply-pattern': 'plans built on what works',
  'connect-channel': 'connecting channels',
  'update-audience': 'audience updates',
  'plan-it': 'planning suggestions',
};

/**
 * What the business's answers say, for Marketing Memory to learn from. Only
 * clear patterns over enough answers (LEARNING_MIN_SAMPLE): mostly yes, or
 * mostly no, by kind of suggestion and by channel. Skips count as neither —
 * "not now" says nothing about whether the idea was right.
 */
export function learningCandidates(
  answered: {
    id: string;
    outcome: HistoryOutcome;
    channel: string | null;
    details: unknown;
  }[],
): LearningCandidate[] {
  const groups = new Map<
    string,
    {
      label: string;
      type: LearningCandidate['insightType'];
      yes: string[];
      no: string[];
    }
  >();
  const add = (
    key: string,
    label: string,
    type: LearningCandidate['insightType'],
    id: string,
    yes: boolean,
  ) => {
    const g = groups.get(key) ?? { label, type, yes: [], no: [] };
    (yes ? g.yes : g.no).push(id);
    groups.set(key, g);
  };
  for (const a of answered) {
    const yes = YES_OUTCOMES.includes(a.outcome);
    const no = a.outcome === 'rejected';
    if (!yes && !no) continue;
    const action = (a.details as { action?: unknown } | null)?.action;
    if (typeof action === 'string' && ACTION_NOUN[action]) {
      add(`action:${action}`, ACTION_NOUN[action], 'CONTENT_FORMAT', a.id, yes);
    }
    if (a.channel) {
      add(
        `channel:${a.channel}`,
        `suggestions for ${a.channel}`,
        'OTHER',
        a.id,
        yes,
      );
    }
  }
  const out: LearningCandidate[] = [];
  for (const [key, g] of groups) {
    const n = g.yes.length + g.no.length;
    if (n < LEARNING_MIN_SAMPLE) continue;
    const rate = g.yes.length / n;
    if (rate > 0.25 && rate < 0.75) continue; // no clear pattern
    out.push({
      insightType: g.type,
      insight:
        rate >= 0.75
          ? `The business usually acts on ${g.label} (${g.yes.length} of ${n}).`
          : `The business usually turns down ${g.label} (${g.no.length} of ${n}).`,
      confidence: confidenceFor(n),
      sampleSize: n,
      supportingDataSummary: {
        source: 'recommendation_history',
        key,
        yes: g.yes.length,
        no: g.no.length,
        recommendationIds: [...g.yes, ...g.no],
      },
    });
  }
  return out.sort((a, b) => b.sampleSize - a.sampleSize);
}
