import { z } from 'zod';

import {
  OPPORTUNITY_CONFIDENCES,
  type OpportunityConfidence,
  type OpportunityStatus,
  type OpportunityType,
} from '@/lib/opportunities';
import type { OpportunityHandoff } from '@/lib/recommendation-handoff';
import { CONTENT_TYPES, type ContentTypeKey } from '@/lib/validations/content';
import { CONTENT_CHANNELS } from '@/lib/validations/planner';
import { integrationAvailable } from '@/lib/recommendation-rules';

/**
 * Recommendations: the rules.
 *
 * A recommendation is what Aura proposes the business DO about an
 * opportunity:
 *
 *   Recommendation
 *   ├── Opportunity        opportunityId — required, every one has an origin
 *   ├── What               title, summary
 *   ├── Why                rationale
 *   ├── Action             action, steps
 *   ├── Expected Outcome   expectedOutcome, outcomeMetric
 *   ├── Evidence           RecommendationEvidence — copied from the opportunity
 *   ├── Confidence         never above the opportunity's
 *   ├── Priority
 *   ├── Channel            channel, contentType
 *   ├── Audience           audience
 *   └── Status             lifecycle below, with history
 *
 * This module is the pure part: the vocabulary, the lifecycle, validation of a
 * recommendation, the default draft built from an opportunity, and the brief
 * handed to the workflow that carries it out. The service is
 * server/recommendations/recommendation.service.ts.
 */

export const RECOMMENDATION_TYPES = [
  'CONTENT',
  'CAMPAIGN',
  'COMPETITIVE_RESPONSE',
  'AUDIENCE',
  'CHANNEL',
  'OPTIMIZATION',
  'OTHER',
] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

export const RECOMMENDATION_STATUSES = [
  'PROPOSED',
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'REJECTED',
  'WITHDRAWN',
  'EXPIRED',
] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

export const RECOMMENDATION_TYPE_INFO: Record<
  RecommendationType,
  { label: string; description: string }
> = {
  CONTENT: { label: 'Content', description: 'Create a piece of content.' },
  CAMPAIGN: {
    label: 'Campaign',
    description: 'Several coordinated pieces over a period.',
  },
  COMPETITIVE_RESPONSE: {
    label: 'Competitive response',
    description: 'Answer a competitor’s move or theme.',
  },
  AUDIENCE: {
    label: 'Audience',
    description: 'Reach a group the business is not addressing.',
  },
  CHANNEL: {
    label: 'Channel',
    description: 'Start, connect or change a channel.',
  },
  OPTIMIZATION: {
    label: 'Optimisation',
    description: 'Do more of what works, or fix what stopped working.',
  },
  OTHER: { label: 'Other', description: 'Anything else.' },
};

/** The kind of action an opportunity naturally calls for. */
export const TYPE_FOR_OPPORTUNITY: Record<OpportunityType, RecommendationType> =
  {
    TRENDING_TOPIC: 'CONTENT',
    CONTENT_GAP: 'CONTENT',
    SEASONAL_MOMENT: 'CONTENT',
    COMPETITOR_MOVE: 'COMPETITIVE_RESPONSE',
    COMPETITIVE_GAP: 'COMPETITIVE_RESPONSE',
    AUDIENCE_SEGMENT: 'AUDIENCE',
    CHANNEL: 'CHANNEL',
    PERFORMANCE_PATTERN: 'OPTIMIZATION',
    OTHER: 'OTHER',
  };

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 *   PROPOSED ─► ACCEPTED ─► IN_PROGRESS ─► COMPLETED
 *      │           └────────────────────► COMPLETED
 *      ├─► REJECTED
 *      ├─► WITHDRAWN    (also from ACCEPTED / IN_PROGRESS: taken back)
 *      └─► EXPIRED      (relevance window passed before a decision)
 *
 * COMPLETED, REJECTED, WITHDRAWN and EXPIRED are final: a new recommendation
 * is made instead, so each one's history stays what it was.
 */
export const RECOMMENDATION_TRANSITIONS: Record<
  RecommendationStatus,
  RecommendationStatus[]
> = {
  PROPOSED: ['ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'],
  ACCEPTED: ['IN_PROGRESS', 'COMPLETED', 'WITHDRAWN'],
  IN_PROGRESS: ['COMPLETED', 'WITHDRAWN'],
  COMPLETED: [],
  REJECTED: [],
  WITHDRAWN: [],
  EXPIRED: [],
};

/** Waiting for a decision. Only these expire. */
export const OPEN_RECOMMENDATION_STATUSES: RecommendationStatus[] = [
  'PROPOSED',
];

/** Not finished: an opportunity with one of these cannot get another. */
export const LIVE_RECOMMENDATION_STATUSES: RecommendationStatus[] = [
  'PROPOSED',
  'ACCEPTED',
  'IN_PROGRESS',
];

export function canTransitionRecommendation(
  from: RecommendationStatus,
  to: RecommendationStatus,
): boolean {
  return RECOMMENDATION_TRANSITIONS[from].includes(to);
}

/** Expired from age alone? Only one still waiting for a decision can expire. */
export function isRecommendationPastRelevance(
  r: { status: RecommendationStatus; relevantUntil: Date | null },
  now: Date,
): boolean {
  return (
    OPEN_RECOMMENDATION_STATUSES.includes(r.status) &&
    r.relevantUntil !== null &&
    r.relevantUntil <= now
  );
}

/**
 * STATUS SYNC with the opportunity. One decision, recorded on both sides:
 *
 *   recommendation created      → opportunity RECOMMENDED
 *   recommendation ACCEPTED     → opportunity ACCEPTED
 *   recommendation REJECTED     → opportunity REJECTED
 *   in progress / completed     → opportunity already ACCEPTED; unchanged
 *   withdrawn / expired         → opportunity unchanged
 *
 *   opportunity ACCEPTED        → open recommendation ACCEPTED
 *   opportunity REJECTED        → open recommendation REJECTED
 *   opportunity EXPIRED         → open recommendation EXPIRED
 */
export const RECOMMENDATION_TO_OPPORTUNITY: Record<
  RecommendationStatus,
  OpportunityStatus | null
> = {
  PROPOSED: 'RECOMMENDED',
  ACCEPTED: 'ACCEPTED',
  IN_PROGRESS: null,
  COMPLETED: null,
  REJECTED: 'REJECTED',
  WITHDRAWN: null,
  EXPIRED: null,
};

export const OPPORTUNITY_TO_RECOMMENDATION: Partial<
  Record<OpportunityStatus, RecommendationStatus>
> = {
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
};

// ---------------------------------------------------------------------------
// What a recommendation must contain
// ---------------------------------------------------------------------------

const text = (max: number) => z.string().trim().min(1).max(max);
const CONF_RANK: Record<OpportunityConfidence, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

/**
 * A recommendation's own content, as whoever writes it (the default draft
 * below, a person, or the recommendation engine) provides it. Everything the
 * opportunity supplies — the link, evidence, priority, context — is added by
 * the service from the hand-off, so it cannot be got wrong here.
 */
export const recommendationContentSchema = z.object({
  type: z.enum(RECOMMENDATION_TYPES),
  /** WHAT */
  title: text(200),
  summary: text(2000),
  /** ACTION — one imperative sentence, and optional steps. */
  action: text(500),
  steps: z.array(text(300)).max(8).default([]),
  /** WHY */
  rationale: text(2000),
  /** EXPECTED OUTCOME */
  expectedOutcome: text(1000),
  outcomeMetric: z.string().trim().max(120).nullable().default(null),
  /** CHANNEL — one of Aura's channels, when it applies. */
  channel: z.enum(CONTENT_CHANNELS).nullable().default(null),
  contentType: z.enum(CONTENT_TYPES).nullable().default(null),
  /** AUDIENCE — when it applies. */
  audience: z.string().trim().max(600).nullable().default(null),
  details: z.record(z.unknown()).default({}),
  /** May lower the opportunity's confidence, never raise it. */
  confidence: z.enum(OPPORTUNITY_CONFIDENCES).optional(),
  confidenceReason: z.string().trim().max(500).optional(),
  /** May shorten the opportunity's relevance window, never extend it. */
  relevantUntil: z.date().nullable().optional(),
});
export type RecommendationContentInput = z.input<
  typeof recommendationContentSchema
>;
export type RecommendationContent = z.output<
  typeof recommendationContentSchema
>;

/**
 * Confidence and relevance a recommendation may claim, given its opportunity:
 * a recommendation cannot be surer than the evidence, or outlive the opening
 * it answers.
 */
export function boundByOpportunity(
  content: Pick<
    RecommendationContent,
    'confidence' | 'confidenceReason' | 'relevantUntil'
  >,
  handoff: OpportunityHandoff,
): {
  confidence: OpportunityConfidence;
  confidenceReason: string | null;
  relevantUntil: Date | null;
} {
  const theirs = handoff.assessment.confidence;
  const lowered =
    content.confidence && CONF_RANK[content.confidence] < CONF_RANK[theirs];
  const until = handoff.opportunity.relevantUntil
    ? new Date(handoff.opportunity.relevantUntil)
    : null;
  const asked = content.relevantUntil ?? null;
  return {
    confidence: lowered ? content.confidence! : theirs,
    confidenceReason: lowered
      ? (content.confidenceReason ?? `Lowered from ${theirs.toLowerCase()}.`)
      : handoff.assessment.confidenceReason,
    relevantUntil: asked && (!until || asked < until) ? asked : until,
  };
}

// ---------------------------------------------------------------------------
// The default draft
// ---------------------------------------------------------------------------

const CHANNEL_CONTENT_TYPE: Record<string, ContentTypeKey> = {
  LinkedIn: 'LINKEDIN_POST',
  Instagram: 'IMAGE_POST',
  X: 'TWEET_THREAD',
  Blog: 'BLOG',
  Newsletter: 'BLOG',
};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const isChannel = (c: string): c is (typeof CONTENT_CHANNELS)[number] =>
  (CONTENT_CHANNELS as readonly string[]).includes(c);

/**
 * A complete recommendation built from an opportunity with plain templates —
 * no model call. Every field is filled from what is known: the opportunity's
 * own reasoning and angle, the channels it or the business named, and the
 * business's stated audience.
 *
 * The recommendation engine replaces this with something sharper; until then
 * (and whenever the engine is unavailable) a recommendation is still
 * structured, actionable and traceable.
 */
export function draftFromOpportunity(
  h: OpportunityHandoff,
  business: { channels: string[]; audience: string | null },
): RecommendationContent {
  const o = h.opportunity;
  const d = o.details;
  const type = TYPE_FOR_OPPORTUNITY[o.type];
  // The opportunity's own channel (e.g. the unconnected one), else the first
  // it or the business names.
  const channel =
    (typeof d.channel === 'string' && isChannel(d.channel)
      ? d.channel
      : null) ??
    [...strings(d.channels), ...business.channels].find(isChannel) ??
    null;
  const contentType =
    type === 'CONTENT' || type === 'COMPETITIVE_RESPONSE' || type === 'CAMPAIGN'
      ? ((channel ? CHANNEL_CONTENT_TYPE[channel] : undefined) ??
        'LINKEDIN_POST')
      : null;
  const ideas = strings(d.contentIdeas).slice(0, 5);
  const where = channel ? ` on ${channel}` : '';

  const ACTION: Record<RecommendationType, string> = {
    CONTENT: `Publish a post${where} on “${o.title}”.`,
    CAMPAIGN: `Run a short series${where} on “${o.title}”.`,
    COMPETITIVE_RESPONSE: `Publish your answer${where} to “${o.title}”, from your own point of view.`,
    AUDIENCE: `Write one piece aimed at this audience and see how it lands.`,
    CHANNEL: channel
      ? `Connect ${channel} to Aura so you can publish and measure it.`
      : 'Connect this channel to Aura so you can publish and measure it.',
    OPTIMIZATION: `Build this into your next month’s plan: ${o.title}.`,
    OTHER: `Act on: ${o.title}.`,
  };
  const OUTCOME: Record<
    RecommendationType,
    { text: string; metric: string | null }
  > = {
    CONTENT: {
      text: 'Engagement from your audience on a topic that is current for them.',
      metric: 'engagement',
    },
    CAMPAIGN: {
      text: 'Sustained engagement on the theme across the series.',
      metric: 'engagement',
    },
    COMPETITIVE_RESPONSE: {
      text: 'Buyers comparing options hear your position, not only the competitor’s.',
      metric: 'engagement',
    },
    AUDIENCE: {
      text: 'A first read on whether this audience responds to you.',
      metric: 'engagement',
    },
    CHANNEL: {
      text: 'Posts on this channel published and measured in Aura.',
      metric: null,
    },
    OPTIMIZATION: {
      text: 'Results recover, or keep improving, where this pattern applies.',
      metric: 'engagement',
    },
    OTHER: { text: 'Progress on this opportunity.', metric: null },
  };

  return recommendationContentSchema.parse({
    type,
    title: o.title.slice(0, 200),
    summary: o.summary.slice(0, 2000),
    action: ACTION[type].slice(0, 500),
    steps:
      ideas.length > 0
        ? ideas.map((i) => i.slice(0, 300))
        : o.angle
          ? [`Take this angle: ${o.angle}`.slice(0, 300)]
          : [],
    rationale: (o.rationale || o.summary).slice(0, 2000),
    expectedOutcome: OUTCOME[type].text,
    outcomeMetric: OUTCOME[type].metric,
    channel,
    contentType,
    audience:
      type === 'CHANNEL' ? null : (business.audience?.slice(0, 600) ?? null),
    details: {
      ...(ideas.length ? { contentIdeas: ideas } : {}),
      ...(o.angle ? { angle: o.angle } : {}),
      ...(typeof d.timing === 'string' ? { timing: d.timing } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Handing a recommendation to the workflow that carries it out
// ---------------------------------------------------------------------------

export const EXECUTION_WORKFLOWS = [
  'CONTENT',
  'PLANNER',
  'COMPETITORS',
  'CONNECTORS',
  'BUSINESS_PROFILE',
] as const;
export type ExecutionWorkflow = (typeof EXECUTION_WORKFLOWS)[number];

const WORKFLOW_FOR_TYPE: Record<RecommendationType, ExecutionWorkflow> = {
  CONTENT: 'CONTENT',
  CAMPAIGN: 'PLANNER',
  COMPETITIVE_RESPONSE: 'CONTENT',
  AUDIENCE: 'CONTENT',
  CHANNEL: 'CONNECTORS',
  OPTIMIZATION: 'PLANNER',
  OTHER: 'PLANNER',
};

export interface ExecutionBrief {
  version: 1;
  workflow: ExecutionWorkflow;
  /** Where in Aura to carry it out, pre-filled where the page supports it. */
  href: string;
  recommendationId: string;
  opportunityId: string;
  /** What to make or do, as text a person or a generator can use directly. */
  brief: string;
  channel: string | null;
  contentType: string | null;
  audience: string | null;
  /** Do it before this, or it is no longer relevant. */
  dueBy: string | null;
  /** What it is based on, so the output can cite it. */
  evidence: { label: string; detail: string; url: string | null }[];
  /**
   * Whether a workflow may act on it (lib/recommendation-rules.ts). When
   * false, `blockers` says why and `href` leads to the review, not the work.
   */
  executable: boolean;
  blockers: string[];
  /** Whether Aura can publish to the channel, or the business posts by hand. */
  publishing: 'aura' | 'manual' | null;
}

/**
 * The recommendation as the workflow that carries it out receives it —
 * Content Studio for content, the planner for campaigns and optimisations,
 * Connectors for a channel. The contract for the execution sprints.
 */
export function executionBrief(r: {
  id: string;
  opportunityId: string;
  type: RecommendationType;
  title: string;
  action: string;
  steps: string[];
  rationale: string;
  expectedOutcome: string;
  channel: string | null;
  contentType: string | null;
  audience: string | null;
  details: unknown;
  relevantUntil: Date | null;
  evidence: { label: string; detail: string; url: string | null }[];
  executable?: boolean;
  blockers?: string[];
}): ExecutionBrief {
  const executable = r.executable ?? true;
  const workflow = WORKFLOW_FOR_TYPE[r.type];
  const angle =
    r.details && typeof r.details === 'object' && 'angle' in r.details
      ? String((r.details as { angle: unknown }).angle)
      : null;
  const brief = [
    r.title,
    '',
    r.action,
    ...(r.steps.length ? ['', ...r.steps.map((s) => `- ${s}`)] : []),
    ...(angle ? ['', `Angle: ${angle}`] : []),
    ...(r.audience ? ['', `For: ${r.audience}`] : []),
    '',
    `Why: ${r.rationale}`,
    `Goal: ${r.expectedOutcome}`,
  ].join('\n');
  const href = !executable
    ? `/dashboard/opportunities?focus=${r.opportunityId}`
    : workflow === 'CONTENT'
      ? `/dashboard/content/new?brief=${encodeURIComponent(brief.slice(0, 1500))}`
      : workflow === 'PLANNER'
        ? '/dashboard/planner'
        : workflow === 'CONNECTORS'
          ? '/dashboard/connectors'
          : workflow === 'COMPETITORS'
            ? '/dashboard/competitors'
            : '/dashboard/business';
  return {
    version: 1,
    workflow,
    href,
    recommendationId: r.id,
    opportunityId: r.opportunityId,
    brief,
    channel: r.channel,
    contentType: r.contentType,
    audience: r.audience,
    dueBy: r.relevantUntil?.toISOString() ?? null,
    evidence: r.evidence.map((e) => ({
      label: e.label,
      detail: e.detail,
      url: e.url,
    })),
    executable,
    blockers: r.blockers ?? [],
    publishing: r.channel
      ? integrationAvailable(r.channel)
        ? 'aura'
        : 'manual'
      : null,
  };
}
