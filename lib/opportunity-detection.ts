import type { BusinessContext } from '@/lib/business-context';
import type {
  OpportunityConfidence,
  OpportunityInput,
  OpportunityType,
} from '@/lib/opportunities';
import type { SignalReliability, SignalSource } from '@/lib/signals';
import type { SignalKind } from '@/lib/opportunities';

/**
 * Opportunity detection rules — when does a set of signals amount to a real
 * business opportunity?
 *
 * DETERMINISTIC FIRST. Every rule here is plain logic over the normalised
 * signal store (server/signals): which signals it reads, how it groups them,
 * how much evidence it needs, how sure it can be, how much it matters, when
 * it expires, and how it avoids repeating itself. Each rule is a pure function
 * and is tested on its own.
 *
 * AI WHERE INTERPRETATION IS REQUIRED. Judging whether competitors are active
 * on a theme the business has never written about means comparing meaning,
 * not matching keys — that is AI-assisted detection
 * (lib/ai-opportunity-detection.ts), whose output is validated against the
 * signals it cites and goes through the same evidence, confidence, priority
 * and duplicate rules when stored.
 *
 * Every candidate a rule produces then passes the engine's shared gates
 * (detectOpportunities below), which no rule can bypass.
 */

/** A stored signal as detection reads it (a Signal row, structurally). */
export interface DetectableSignal {
  id: string;
  source: SignalSource;
  kind: SignalKind;
  title: string;
  summary: string;
  url: string | null;
  refId: string | null;
  observedAt: Date;
  expiresAt: Date | null;
  reliability: SignalReliability;
  occurrences: number;
  contextMatches: string[];
  metadata: unknown;
  dedupeKey: string;
}

/** What a rule proposes, before the engine's gates. */
export interface Candidate {
  rule: string;
  type: OpportunityType;
  /** Stable for the same opportunity in the same period — see DUPLICATES. */
  dedupeKey: string;
  title: string;
  summary: string;
  angle?: string;
  details?: Record<string, unknown>;
  impact: 'low' | 'medium' | 'high';
  effort: 'low' | 'medium' | 'high';
  signals: DetectableSignal[];
  /** Why the rule fired, in words a reviewer can check. */
  criteria: string[];
  /** Business Context fields it relies on. */
  contextFields: string[];
  relevantUntil: Date | null;
}

export interface Rule {
  id: string;
  type: OpportunityType;
  description: string;
  /** Plain-language minimum evidence, for the docs and the run report. */
  minimumEvidence: string;
  detect(
    signals: DetectableSignal[],
    ctx: BusinessContext | null,
    now: Date,
  ): Candidate[];
}

const DAY = 86_400_000;
const meta = (s: DetectableSignal) =>
  s.metadata && typeof s.metadata === 'object'
    ? (s.metadata as Record<string, unknown>)
    : {};
const within = (s: DetectableSignal, days: number, now: Date) =>
  now.getTime() - s.observedAt.getTime() <= days * DAY;
const latestExpiry = (signals: DetectableSignal[], fallback: Date | null) => {
  const dates = signals
    .map((s) => s.expiresAt)
    .filter((d): d is Date => Boolean(d));
  return dates.length
    ? new Date(Math.max(...dates.map((d) => d.getTime())))
    : fallback;
};
/** "2026-10" — opportunities of the same kind in the same month are one. */
const month = (d: Date) => d.toISOString().slice(0, 7);
/** ISO week, "2026-W40" — for fast-moving opportunities. */
export function isoWeek(d: Date): string {
  const t = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
const slug = (v: string) =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * A competitor visibly changed what it sells or says: pricing, homepage, or
 * a release. One opportunity per competitor per month, however many changes
 * they make in it — each extra change is more evidence, not a new item.
 */
export const competitorMoveRule: Rule = {
  id: 'competitor-move',
  type: 'COMPETITOR_MOVE',
  description:
    'A tracked competitor changed its pricing, its homepage or shipped a release.',
  minimumEvidence:
    'One HIGH-reliability change observed directly on the competitor’s site or GitHub, in the last 30 days.',
  detect(signals, _ctx, now) {
    const changes = signals.filter(
      (s) =>
        s.source === 'COMPETITORS' &&
        s.reliability === 'HIGH' &&
        ['pricing', 'homepage', 'release'].includes(String(meta(s).change)) &&
        within(s, 30, now),
    );
    const byCompetitor = new Map<string, DetectableSignal[]>();
    for (const s of changes) {
      const id = String(meta(s).competitorId ?? meta(s).competitor);
      byCompetitor.set(id, [...(byCompetitor.get(id) ?? []), s]);
    }
    return [...byCompetitor.entries()].map(([id, group]) => {
      const name = String(meta(group[0]!).competitor ?? 'A competitor');
      const kinds = [...new Set(group.map((s) => String(meta(s).change)))];
      const pricing = kinds.includes('pricing');
      return {
        rule: this.id,
        type: this.type,
        dedupeKey: `rule:competitor-move:${id}:${month(group[0]!.observedAt)}`,
        title: `Respond to ${name}’s ${kinds.join(' and ')} change`,
        summary: group.map((s) => s.summary).join(' '),
        angle: pricing
          ? 'Compete on value and outcome, not on matching their price.'
          : 'Show what you do differently rather than echoing their message.',
        details: { competitor: name, changes: kinds },
        // A pricing move changes buyers' comparisons; a homepage tweak less so.
        impact: pricing ? 'high' : 'medium',
        effort: 'low',
        signals: group,
        criteria: [
          `${name} made ${group.length === 1 ? 'a change' : `${group.length} changes`} to its ${kinds.join(' and ')}, seen directly on its site`,
        ],
        contextFields: ['identity.description', 'identity.offerings'],
        relevantUntil: latestExpiry(group, new Date(now.getTime() + 30 * DAY)),
      };
    });
  },
};

/**
 * The market is talking about something the business has said it cares
 * about. Grouped by the business keyword the stories match; needs either two
 * different stories, or one story seen in more than one place.
 */
export const trendingTopicRule: Rule = {
  id: 'trending-topic',
  type: 'TRENDING_TOPIC',
  description: 'Several current stories about a topic the business follows.',
  minimumEvidence:
    'Two different stories on the same business keyword in the last 14 days, or one story seen in two or more places — and at least one of them MEDIUM reliability or better.',
  detect(signals, ctx, now) {
    const stories = signals.filter(
      (s) => s.source === 'TRENDS' && within(s, 14, now),
    );
    const byTopic = new Map<string, DetectableSignal[]>();
    const specificity = new Map<string, number>();
    for (const s of stories) {
      for (const m of s.contextMatches.filter(
        (x) => x.startsWith('keyword:') || x.startsWith('industry:'),
      )) {
        const topic = m.slice(m.indexOf(':') + 1);
        byTopic.set(topic, [...(byTopic.get(topic) ?? []), s]);
        // The business's own keyword is more specific than its broad
        // industry; a longer phrase more specific than a shorter one.
        specificity.set(
          topic,
          (m.startsWith('keyword:') ? 1000 : 0) + topic.length,
        );
      }
    }
    // Most specific topic first: when the same stories match "specialty
    // coffee" and "Coffee", the engine keeps the first and merges the other
    // (see the duplicate gate in detectOpportunities).
    const topics = [...byTopic.entries()].sort(
      (a, b) => (specificity.get(b[0]) ?? 0) - (specificity.get(a[0]) ?? 0),
    );
    const themes = (ctx?.objectives.campaigns ?? []).flatMap((c) =>
      c.themes.map((t) => t.toLowerCase()),
    );
    const out: Candidate[] = [];
    for (const [topic, group] of topics) {
      const corroborated = group.some((s) => s.occurrences >= 2);
      if (group.length < 2 && !corroborated) continue;
      if (!group.some((s) => s.reliability !== 'LOW')) continue;
      // Riding a topic the business is already campaigning on is worth more.
      const onCampaign = themes.some(
        (t) =>
          t.includes(topic.toLowerCase()) || topic.toLowerCase().includes(t),
      );
      out.push({
        rule: this.id,
        type: this.type,
        dedupeKey: `rule:trending-topic:${slug(topic)}:${isoWeek(now)}`,
        title: `Join the conversation on ${topic}`,
        summary: `${group.length} current ${group.length === 1 ? 'story' : 'stories'} on ${topic}: ${group
          .slice(0, 3)
          .map((s) => s.title)
          .join('; ')}.`,
        details: { topic, onCampaign },
        impact: onCampaign ? 'high' : 'medium',
        effort: 'low',
        signals: group,
        criteria: [
          group.length >= 2
            ? `${group.length} different news stories are covering “${topic}” right now`
            : `a story about “${topic}” is being picked up in several places`,
          ...(onCampaign ? ['matches a running campaign theme'] : []),
        ],
        contextFields: ['identity.description', 'audience.stated'],
        relevantUntil: latestExpiry(group, new Date(now.getTime() + 14 * DAY)),
      });
    }
    return out;
  },
};

/** Something the business's own results say works — do more of it. */
export const provenPatternRule: Rule = {
  id: 'proven-pattern',
  type: 'PERFORMANCE_PATTERN',
  description: 'A pattern learned from the business’s own results.',
  minimumEvidence:
    'One learned pattern of MEDIUM reliability or better (enough results behind it), or one the user confirmed.',
  detect(signals, _ctx, now) {
    return signals
      .filter((s) => s.source === 'MEMORY' && s.reliability !== 'LOW')
      .map((s) => ({
        rule: this.id,
        type: this.type,
        dedupeKey: `rule:proven-pattern:${s.refId ?? s.id}`,
        title: `Do more of what works: ${s.summary.slice(0, 90)}`,
        summary: s.summary,
        details: { pattern: meta(s).insightType },
        impact: 'medium' as const,
        effort: 'low' as const,
        signals: [s],
        criteria: [
          `learned from your results (${s.reliability.toLowerCase()} reliability)`,
        ],
        contextFields: [],
        relevantUntil: latestExpiry([s], new Date(now.getTime() + 60 * DAY)),
      }));
  },
};

/**
 * Results moved sharply between periods. Up: build on what drove it. Down:
 * find out why before it compounds. Needs recorded numbers compared across two
 * periods — a single period never produces one.
 */
export const resultsShiftRule: Rule = {
  id: 'results-shift',
  type: 'PERFORMANCE_PATTERN',
  description:
    'A results metric moved by 25% or more between the last two periods.',
  minimumEvidence:
    'One HIGH-reliability analytics movement (recorded and compared across two periods).',
  detect(signals, _ctx, now) {
    return signals
      .filter(
        (s) =>
          s.source === 'ANALYTICS' &&
          s.reliability === 'HIGH' &&
          meta(s).metric,
      )
      .map((s) => {
        const m = meta(s);
        const up = Number(m.to) > Number(m.from);
        return {
          rule: this.id,
          type: this.type,
          dedupeKey: `rule:results-shift:${String(m.metric)}:${up ? 'up' : 'down'}:${s.refId ?? s.id}`,
          title: up
            ? `Build on the jump: ${s.title}`
            : `Find out why: ${s.title}`,
          summary: s.summary,
          details: { metric: m.metric, from: m.from, to: m.to },
          impact: up ? ('medium' as const) : ('high' as const),
          effort: 'medium' as const,
          signals: [s],
          criteria: [s.summary],
          contextFields: ['objectives.goals'],
          relevantUntil: latestExpiry([s], new Date(now.getTime() + 30 * DAY)),
        };
      });
  },
};

/** The business publishes somewhere Aura cannot act — connecting it unlocks publishing and measurement. */
export const unconnectedChannelRule: Rule = {
  id: 'unconnected-channel',
  type: 'CHANNEL',
  description: 'A channel the business uses is not connected to Aura.',
  minimumEvidence: 'The business stated the channel and it has no connection.',
  detect(signals) {
    return signals
      .filter((s) => s.source === 'BUSINESS_CONTEXT' && meta(s).channel)
      .map((s) => ({
        rule: this.id,
        type: this.type,
        dedupeKey: `rule:unconnected-channel:${slug(String(meta(s).channel))}`,
        title: `Connect ${String(meta(s).channel)} so Aura can publish and measure there`,
        summary: s.summary,
        details: { channel: meta(s).channel },
        impact: 'low' as const,
        effort: 'low' as const,
        signals: [s],
        criteria: ['you publish on this channel and it is not connected'],
        contextFields: ['channels.preferred'],
        relevantUntil: null,
      }));
  },
};

export const DETECTION_RULES: Rule[] = [
  competitorMoveRule,
  trendingTopicRule,
  provenPatternRule,
  resultsShiftRule,
  unconnectedChannelRule,
];

/**
 * Categories that need interpretation, and so are left to AI-assisted
 * detection (lib/ai-opportunity-detection.ts): the engine does not attempt
 * them with rules.
 */
export const AI_INTERPRETED_CATEGORIES: {
  type: OpportunityType;
  why: string;
}[] = [
  {
    type: 'CONTENT_GAP',
    why: 'Needs comparing what competitors talk about with what the business has published — meaning, not keys.',
  },
  {
    type: 'COMPETITIVE_GAP',
    why: 'Needs judging a theme competitors keep returning to across many unrelated signals.',
  },
  {
    type: 'AUDIENCE_SEGMENT',
    why: 'Needs reading who is engaging and why, which no single signal states.',
  },
];

// ---------------------------------------------------------------------------
// The engine's shared gates
// ---------------------------------------------------------------------------

const RANK: Record<SignalReliability, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };

/**
 * CONFIDENCE THRESHOLDS — from how reliable the evidence is, not just how
 * much of it there is:
 *
 *   HIGH    two or more distinct signals, at least one HIGH, none LOW
 *   MEDIUM  at least one HIGH signal, or two or more MEDIUM-or-better
 *   LOW     anything less — including any amount of LOW-only evidence
 *
 * Passed to recordOpportunity as the detector's claim; the stored value is the
 * lower of this and what the evidence count and business context allow.
 */
export function confidenceFromReliability(signals: DetectableSignal[]): {
  confidence: OpportunityConfidence;
  reason: string;
} {
  const n = signals.length;
  const high = signals.filter((s) => s.reliability === 'HIGH').length;
  const medPlus = signals.filter(
    (s) => RANK[s.reliability] >= RANK.MEDIUM,
  ).length;
  const low = n - medPlus;
  if (n >= 2 && high >= 1 && low === 0) {
    return {
      confidence: 'HIGH',
      reason: `${n} signals, ${high} high-reliability, none low`,
    };
  }
  if (high >= 1 || medPlus >= 2) {
    return {
      confidence: 'MEDIUM',
      reason: `${high} high and ${medPlus - high} medium-reliability signal(s)`,
    };
  }
  return {
    confidence: 'LOW',
    reason:
      low === n
        ? 'only low-reliability signals'
        : 'a single medium-reliability signal',
  };
}

/** Why a candidate was not turned into an opportunity. */
export type Suppression =
  | 'not-relevant'
  | 'insufficient-evidence'
  | 'already-rejected'
  | 'rule-muted'
  | 'duplicate';

export interface DetectionOptions {
  now: Date;
  /** Signal ids used as evidence in opportunities the business rejected. */
  rejectedSignalIds?: Set<string>;
  /** Rules muted for producing rejected opportunities (see RULE_MUTING). */
  mutedRules?: Set<string>;
  rules?: Rule[];
}

export interface DetectionResult {
  accepted: (Candidate & {
    confidence: OpportunityConfidence;
    confidenceReason: string;
  })[];
  suppressed: {
    rule: string;
    dedupeKey: string;
    title: string;
    reason: Suppression;
    detail: string;
  }[];
}

/**
 * FALSE-POSITIVE HANDLING — muting a rule that keeps being wrong:
 * three or more of its opportunities rejected in the last 60 days, and none
 * accepted, mutes it for 30 days from the latest rejection.
 */
export const RULE_MUTING = { windowDays: 60, rejections: 3, muteDays: 30 };

export function mutedRules(
  history: { rule: string; status: string; decidedAt: Date | null }[],
  now: Date,
): Set<string> {
  const since = now.getTime() - RULE_MUTING.windowDays * DAY;
  const byRule = new Map<string, { rejected: Date[]; accepted: number }>();
  for (const h of history) {
    if (!h.decidedAt || h.decidedAt.getTime() < since) continue;
    const r = byRule.get(h.rule) ?? { rejected: [], accepted: 0 };
    if (h.status === 'REJECTED') r.rejected.push(h.decidedAt);
    if (h.status === 'ACCEPTED') r.accepted += 1;
    byRule.set(h.rule, r);
  }
  const muted = new Set<string>();
  for (const [rule, r] of byRule) {
    if (r.accepted > 0 || r.rejected.length < RULE_MUTING.rejections) continue;
    const last = Math.max(...r.rejected.map((d) => d.getTime()));
    if (now.getTime() - last < RULE_MUTING.muteDays * DAY) muted.add(rule);
  }
  return muted;
}

/**
 * Run every rule over the signals and apply the shared gates:
 *
 *   1. RELEVANCE — market signals (trends) must relate to the business.
 *      Competitor, results, memory and business signals are about this
 *      business by construction.
 *   2. NO REPEAT OF A REJECTION — a candidate whose evidence was all used in
 *      an opportunity the business rejected is not proposed again.
 *   3. MUTED RULES — see RULE_MUTING.
 *   4. EVIDENCE — at least one current signal (expired ones never reach the
 *      engine); confidence from reliability (confidenceFromReliability).
 *
 * Priority is then derived when the candidate is recorded, and a LOW
 * confidence caps it at MEDIUM (lib/opportunities.ts derivePriority).
 */
export function detectOpportunities(
  signals: DetectableSignal[],
  ctx: BusinessContext | null,
  options: DetectionOptions,
): DetectionResult {
  const now = options.now;
  const current = signals.filter((s) => !s.expiresAt || s.expiresAt > now);
  const result: DetectionResult = { accepted: [], suppressed: [] };
  const suppress = (c: Candidate, reason: Suppression, detail: string) =>
    result.suppressed.push({
      rule: c.rule,
      dedupeKey: c.dedupeKey,
      title: c.title,
      reason,
      detail,
    });

  for (const rule of options.rules ?? DETECTION_RULES) {
    for (const c of rule.detect(current, ctx, now)) {
      if (options.mutedRules?.has(c.rule)) {
        suppress(
          c,
          'rule-muted',
          'Recent opportunities from this rule were all rejected.',
        );
        continue;
      }
      if (c.signals.length === 0) {
        suppress(c, 'insufficient-evidence', 'No current signals.');
        continue;
      }
      if (
        c.type === 'TRENDING_TOPIC' &&
        !c.signals.some((s) => s.contextMatches.length > 0)
      ) {
        suppress(
          c,
          'not-relevant',
          'None of the stories relate to the business.',
        );
        continue;
      }
      const fresh = c.signals.filter(
        (s) => !options.rejectedSignalIds?.has(s.id),
      );
      if (fresh.length === 0) {
        suppress(
          c,
          'already-rejected',
          'All of its evidence was in an opportunity the business rejected.',
        );
        continue;
      }
      // 5. DUPLICATES WITHIN A RUN — two candidates of the same type that
      //    share any evidence are one opportunity. The earlier (more specific)
      //    one keeps it all; the other is recorded as merged, not dropped
      //    silently.
      const twin = result.accepted.find(
        (a) =>
          a.type === c.type &&
          a.signals.some((s) => fresh.some((f) => f.id === s.id)),
      );
      if (twin) {
        const ids = new Set(twin.signals.map((s) => s.id));
        twin.signals = [
          ...twin.signals,
          ...fresh.filter((s) => !ids.has(s.id)),
        ];
        const merged = confidenceFromReliability(twin.signals);
        twin.confidence = merged.confidence;
        twin.confidenceReason = merged.reason;
        suppress(
          c,
          'duplicate',
          `Same evidence as "${twin.title}"; merged into it.`,
        );
        continue;
      }
      const { confidence, reason } = confidenceFromReliability(fresh);
      result.accepted.push({
        ...c,
        signals: fresh,
        confidence,
        confidenceReason: reason,
      });
    }
  }
  return result;
}

/** A detected candidate as recordOpportunity input. */
export function candidateToInput(
  c: DetectionResult['accepted'][number],
): OpportunityInput {
  return {
    type: c.type,
    title: c.title.slice(0, 200),
    summary: c.summary.slice(0, 4000),
    rationale: c.criteria.join('; '),
    ...(c.angle ? { angle: c.angle } : {}),
    details: { ...c.details, rule: c.rule, criteria: c.criteria },
    source: sourceFor(c),
    detectedBy: `rule:${c.rule}`,
    signals: c.signals.map((s) => ({
      kind: s.kind,
      refId: s.refId,
      label: s.title.slice(0, 200),
      detail: s.summary.slice(0, 2000),
      ...(s.url && /^https?:\/\//i.test(s.url) ? { url: s.url } : {}),
      observedAt: s.observedAt,
      signalId: s.id,
    })),
    impact: c.impact,
    effort: c.effort,
    confidence: c.confidence,
    relevantUntil: c.relevantUntil,
    dedupeKey: c.dedupeKey,
    contextFields: c.contextFields,
  };
}

function sourceFor(c: Candidate): OpportunityInput['source'] {
  switch (c.signals[0]?.source) {
    case 'TRENDS':
      return 'TRENDS';
    case 'COMPETITORS':
      return 'COMPETITORS';
    case 'MEMORY':
      return 'MEMORY';
    case 'ANALYTICS':
      return 'ANALYTICS';
    case 'BUSINESS_CONTEXT':
      return 'BUSINESS_CONTEXT';
    default:
      return 'MANUAL';
  }
}
