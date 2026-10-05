import { z } from 'zod';

import {
  citableFacts,
  unsupportedNumbers,
} from '@/lib/ai-opportunity-detection';
import type { BusinessContextSnapshot } from '@/lib/business-context-snapshot';
import {
  derivePriority,
  type OpportunityConfidence,
  type OpportunityPriority,
  type OpportunityType,
} from '@/lib/opportunities';
import type { OpportunityHandoff } from '@/lib/recommendation-handoff';
import {
  recommendationContentSchema,
  type RecommendationContent,
  type RecommendationType,
} from '@/lib/recommendations';
import type { SignalReliability, SignalSource } from '@/lib/signals';
import type { ContentTypeKey } from '@/lib/validations/content';
import { CONTENT_CHANNELS } from '@/lib/validations/planner';

/**
 * Recommendation generation: a validated opportunity in, a structured,
 * supported recommendation out.
 *
 *   1. POSSIBLE ACTIONS   each opportunity type has a catalogue of actions,
 *                         each stating what it needs (a channel the business
 *                         uses, a known audience, time, impact, evidence)
 *   2. SELECTION          every action is checked against the CURRENT
 *                         Business Context Snapshot and the relevant signals;
 *                         unsupported ones are set aside with the reason, the
 *                         rest are scored on fit (connected channel, learned
 *                         format, goals, effort vs time left) and ranked
 *   3. WRITING            the chosen action becomes a full recommendation —
 *                         by template here, or by a model whose output is
 *                         validated (validateAiRecommendation) and replaced
 *                         by the template if it does not hold up
 *   4. ASSESSMENT         confidence (never above the opportunity's, lowered
 *                         when it rests on unconfirmed context) and priority
 *                         (from impact, the action's effort, confidence and
 *                         time left), each with its reason
 *   5. SUPPORT GATE       checkSupport: anything the data does not back is
 *                         rejected, or stored with a flag saying so
 *
 * Pure and client-safe. The service is server/recommendations/engine.service.ts.
 */

export const ENGINE_VERSION = 'rec-engine-v1';

type Channel = (typeof CONTENT_CHANNELS)[number];
type Rating = 'low' | 'medium' | 'high';
const RATING: Record<Rating, number> = { low: 1, medium: 2, high: 3 };
const DAY = 86_400_000;

/** A stored signal as the engine reads it (a Signal row, structurally). */
export interface EngineSignal {
  id: string;
  source: SignalSource;
  title: string;
  summary: string;
  reliability: SignalReliability;
  expiresAt: Date | null;
  metadata: unknown;
}

/** What the engine knows about the business, from the snapshot. */
export interface EngineContext {
  /** Channels the business says it publishes on (trusted facts only). */
  publishesOn: Channel[];
  connected: Channel[];
  /** Who it sells to, when confirmed. */
  audience: string | null;
  /** An audience Aura only assumed — usable, but flagged. */
  assumedAudience: string | null;
  goals: string | null;
  campaignThemes: string[];
  /** Content formats learned to work, from confident insights. */
  learnedFormats: ContentTypeKey[];
}

const FORMAT_WORDS: [RegExp, ContentTypeKey][] = [
  [/carousel/i, 'CAROUSEL'],
  [/thread/i, 'TWEET_THREAD'],
  [/\b(image|photo|visual)s?\b/i, 'IMAGE_POST'],
  [/\b(blog|article|long-form)s?\b/i, 'BLOG'],
];

export function engineContext(s: BusinessContextSnapshot): EngineContext {
  const assumed = s.assumptions.find((a) => a.field === 'audience.stated');
  return {
    publishesOn: [...(s.channels?.publishesOn ?? [])],
    connected: [...(s.channels?.connected ?? [])],
    audience: s.audience?.description ?? null,
    assumedAudience: assumed ? assumed.value : null,
    goals: s.goals?.current ?? null,
    campaignThemes: (s.goals?.campaigns ?? []).flatMap((c) => c.themes),
    learnedFormats: (s.learning?.insights ?? [])
      .filter((i) => i.type === 'CONTENT_FORMAT' && i.confidence !== 'LOW')
      .flatMap((i) =>
        FORMAT_WORDS.filter(([re]) => re.test(i.insight)).map(([, f]) => f),
      ),
  };
}

/**
 * Formats learned to work, from the current signal store — which can be
 * fresher than the snapshot. Only confident content-format patterns count.
 */
export function learnedFormatsFromSignals(
  signals: EngineSignal[],
): ContentTypeKey[] {
  return signals
    .filter(
      (s) =>
        s.source === 'MEMORY' &&
        s.reliability !== 'LOW' &&
        (s.metadata as { insightType?: unknown } | null)?.insightType ===
          'CONTENT_FORMAT',
    )
    .flatMap((s) =>
      FORMAT_WORDS.filter(([re]) => re.test(`${s.title} ${s.summary}`)).map(
        ([, f]) => f,
      ),
    );
}

// ---------------------------------------------------------------------------
// 1. Possible actions
// ---------------------------------------------------------------------------

export interface ActionSpec {
  id: string;
  type: RecommendationType;
  label: string;
  effort: Rating;
  /** Needs a channel the business publishes on. */
  needsChannel: boolean;
  /** Only on one of these channels (e.g. an article needs a blog). */
  channels?: Channel[];
  needsAudience: boolean;
  /** Not worth starting with less time left than this. */
  minDaysLeft?: number;
  /** Only for openings at least this big. */
  minImpact?: Rating;
  /** Needs this kind of evidence among the opportunity's signals. */
  needsEvidence?: 'analytics-drop' | 'pattern';
}

const post: ActionSpec = {
  id: 'post',
  type: 'CONTENT',
  label: 'One post',
  effort: 'low',
  needsChannel: true,
  needsAudience: false,
};
const series: ActionSpec = {
  id: 'series',
  type: 'CAMPAIGN',
  label: 'A short series',
  effort: 'medium',
  needsChannel: true,
  needsAudience: false,
  minDaysLeft: 7,
  minImpact: 'medium',
};
const article: ActionSpec = {
  id: 'article',
  type: 'CONTENT',
  label: 'An in-depth article',
  effort: 'medium',
  needsChannel: true,
  channels: ['Blog', 'Newsletter'],
  needsAudience: false,
};

/** What could be done about each kind of opportunity, most natural first. */
export const ACTIONS_FOR: Record<OpportunityType, ActionSpec[]> = {
  TRENDING_TOPIC: [post, series],
  SEASONAL_MOMENT: [post, series],
  CONTENT_GAP: [article, post, series],
  COMPETITOR_MOVE: [
    {
      ...post,
      id: 'response-post',
      type: 'COMPETITIVE_RESPONSE',
      label: 'A response post',
    },
    {
      ...article,
      id: 'comparison-article',
      type: 'COMPETITIVE_RESPONSE',
      label: 'A comparison article',
    },
  ],
  COMPETITIVE_GAP: [
    { ...series, type: 'COMPETITIVE_RESPONSE', label: 'A series on the theme' },
    {
      ...post,
      id: 'response-post',
      type: 'COMPETITIVE_RESPONSE',
      label: 'A response post',
    },
  ],
  AUDIENCE_SEGMENT: [
    {
      ...post,
      id: 'targeted-post',
      type: 'AUDIENCE',
      label: 'A post for this audience',
      needsAudience: true,
    },
    {
      id: 'update-audience',
      type: 'AUDIENCE',
      label: 'Add this audience to your profile',
      effort: 'low',
      needsChannel: false,
      needsAudience: false,
    },
  ],
  CHANNEL: [
    {
      id: 'connect-channel',
      type: 'CHANNEL',
      label: 'Connect the channel',
      effort: 'low',
      needsChannel: false,
      needsAudience: false,
    },
  ],
  PERFORMANCE_PATTERN: [
    {
      id: 'recovery-post',
      type: 'OPTIMIZATION',
      label: 'A post to win the drop back',
      effort: 'low',
      needsChannel: true,
      needsAudience: false,
      needsEvidence: 'analytics-drop',
    },
    {
      id: 'apply-pattern',
      type: 'OPTIMIZATION',
      label: 'Build it into next month’s plan',
      effort: 'medium',
      needsChannel: false,
      needsAudience: false,
      needsEvidence: 'pattern',
    },
  ],
  OTHER: [
    {
      id: 'plan-it',
      type: 'OTHER',
      label: 'Plan how to act on it',
      effort: 'medium',
      needsChannel: false,
      needsAudience: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// 2. Selection
// ---------------------------------------------------------------------------

export interface ScoredAction {
  spec: ActionSpec;
  score: number;
  channel: Channel | null;
  contentType: ContentTypeKey | null;
  /** Why it fits (or fits less), in words a reviewer can check. */
  reasons: string[];
  /** Usable, but resting on something unconfirmed. */
  flags: string[];
}

export interface Selection {
  viable: ScoredAction[];
  unsupported: { id: string; label: string; reasons: string[] }[];
}

const CHANNEL_FORMAT: Record<Channel, ContentTypeKey> = {
  LinkedIn: 'LINKEDIN_POST',
  Instagram: 'IMAGE_POST',
  X: 'TWEET_THREAD',
  Blog: 'BLOG',
  Newsletter: 'BLOG',
  YouTube: 'IMAGE_POST',
};
/** Which formats each channel can carry. */
const CHANNEL_FORMATS: Record<Channel, ContentTypeKey[]> = {
  LinkedIn: ['LINKEDIN_POST', 'CAROUSEL', 'IMAGE_POST'],
  Instagram: ['IMAGE_POST', 'CAROUSEL'],
  X: ['TWEET_THREAD'],
  Blog: ['BLOG'],
  Newsletter: ['BLOG'],
  YouTube: ['IMAGE_POST'],
};

const isChannel = (c: unknown): c is Channel =>
  typeof c === 'string' && (CONTENT_CHANNELS as readonly string[]).includes(c);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const meta = (s: EngineSignal) =>
  s.metadata && typeof s.metadata === 'object'
    ? (s.metadata as Record<string, unknown>)
    : {};

/** An analytics movement among the signals: metric, from, to. */
export function analyticsShift(
  signals: EngineSignal[],
): { metric: string; from: number; to: number } | null {
  for (const s of signals) {
    if (s.source !== 'ANALYTICS') continue;
    const m = meta(s);
    if (
      typeof m.metric === 'string' &&
      typeof m.from === 'number' &&
      typeof m.to === 'number'
    ) {
      // The readable label is the title's start ("Engagement down 40%").
      const label = s.title.replace(/\s+(up|down)\s.*$/i, '').trim();
      return { metric: label || m.metric, from: m.from, to: m.to };
    }
  }
  return null;
}

const words = (t: string) =>
  new Set(
    t
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  );

/**
 * Check every possible action against the business and the evidence, and
 * rank the ones that hold up. Deterministic.
 */
export function selectActions(
  h: OpportunityHandoff,
  ctx: EngineContext,
  signals: EngineSignal[],
  now: Date,
): Selection {
  const o = h.opportunity;
  const daysLeft = o.relevantUntil
    ? (new Date(o.relevantUntil).getTime() - now.getTime()) / DAY
    : null;
  const impact = h.assessment.impact ?? 'medium';
  const named = [
    ...(isChannel(o.details.channel) ? [o.details.channel] : []),
    ...strings(o.details.channels).filter(isChannel),
  ];
  const goalWords = words([ctx.goals ?? '', ...ctx.campaignThemes].join(' '));
  const fitsGoal = [...words(`${o.title} ${o.summary}`)].some((w) =>
    goalWords.has(w),
  );
  const shift = analyticsShift(signals);
  const hasPattern =
    signals.some((s) => s.source === 'MEMORY') ||
    Boolean(shift && shift.to > shift.from);

  const viable: ScoredAction[] = [];
  const unsupported: Selection['unsupported'] = [];

  ACTIONS_FOR[o.type].forEach((spec, order) => {
    const why: string[] = [];
    const reasons: string[] = [];
    const flags: string[] = [];
    let channel: Channel | null = null;

    // CHANNEL: needs a channel the business publishes on.
    if (spec.needsChannel) {
      const allowed = spec.channels
        ? ctx.publishesOn.filter((c) => spec.channels!.includes(c))
        : ctx.publishesOn;
      channel =
        named.find((c) => allowed.includes(c)) ??
        allowed.find((c) => ctx.connected.includes(c)) ??
        allowed[0] ??
        null;
      if (!channel) {
        why.push(
          spec.channels
            ? `needs ${spec.channels.join(' or ')}, which the business does not publish on`
            : 'the business has not said where it publishes',
        );
      }
    }
    if (spec.id === 'connect-channel') {
      const c = named[0] ?? null;
      if (!c) why.push('the opportunity does not name a channel');
      else if (!ctx.publishesOn.includes(c))
        why.push(`the business does not publish on ${c}`);
      else if (ctx.connected.includes(c)) why.push(`${c} is already connected`);
      channel = c;
    }

    // AUDIENCE
    if (spec.needsAudience) {
      if (ctx.audience)
        reasons.push('aimed at the audience the business confirmed');
      else if (ctx.assumedAudience)
        flags.push(
          'aims at an audience Aura assumed, not one the business confirmed',
        );
      else why.push('no audience is known for the business');
    }

    // TIME and SIZE
    if (spec.minDaysLeft && daysLeft !== null && daysLeft < spec.minDaysLeft) {
      why.push(
        `only ${Math.max(0, Math.floor(daysLeft))} day(s) left — not enough for ${spec.label.toLowerCase()}`,
      );
    }
    if (spec.minImpact && RATING[impact] < RATING[spec.minImpact]) {
      why.push(
        `the opening is ${impact} impact — too small for ${spec.label.toLowerCase()}`,
      );
    }

    // EVIDENCE
    if (
      spec.needsEvidence === 'analytics-drop' &&
      !(shift && shift.to < shift.from)
    ) {
      why.push('no drop in results among the evidence');
    }
    if (spec.needsEvidence === 'pattern' && !hasPattern) {
      why.push('no learned pattern or rise in results among the evidence');
    }

    if (why.length) {
      unsupported.push({ id: spec.id, label: spec.label, reasons: why });
      return;
    }

    // FIT — scored, each point with its reason.
    let score = 50 - order * 2;
    let contentType: ContentTypeKey | null = null;
    if (channel && spec.needsChannel) {
      contentType = CHANNEL_FORMAT[channel];
      if (ctx.connected.includes(channel)) {
        score += 10;
        reasons.push(
          `${channel} is connected, so it can be published and measured`,
        );
      } else {
        reasons.push(`the business publishes on ${channel}`);
      }
      const learned = ctx.learnedFormats.find((f) =>
        CHANNEL_FORMATS[channel!].includes(f),
      );
      if (learned && spec.type !== 'CHANNEL') {
        contentType = learned;
        score += 10;
        reasons.push(
          `uses a format the business learned works (${learned.toLowerCase().replace('_', ' ')})`,
        );
      }
    }
    if (fitsGoal) {
      score += 10;
      reasons.push('relates to the business’s current goal or campaign');
    }
    score += spec.effort === 'low' ? 10 : spec.effort === 'high' ? -10 : 0;
    if (daysLeft !== null && daysLeft <= 7 && spec.effort !== 'low') {
      score -= 15;
      reasons.push('closes within a week, so lower-effort actions rank first');
    }
    if (spec.type === 'CAMPAIGN' && impact === 'high') {
      score += 8;
      reasons.push('a high-impact opening is worth more than one post');
    }
    viable.push({ spec, score, channel, contentType, reasons, flags });
  });

  viable.sort((a, b) => b.score - a.score);
  return { viable, unsupported };
}

// ---------------------------------------------------------------------------
// 3. Writing (template)
// ---------------------------------------------------------------------------

/**
 * The chosen action as a full recommendation, from templates — no model
 * call. Every statement comes from the opportunity, its evidence or the
 * business's own context, so the support gate always passes it.
 */
export function composeRecommendation(
  h: OpportunityHandoff,
  chosen: ScoredAction,
  ctx: EngineContext,
  signals: EngineSignal[],
): RecommendationContent {
  const o = h.opportunity;
  const s = chosen.spec;
  const on = chosen.channel ? ` on ${chosen.channel}` : '';
  // The format as a plain noun: "a carousel", "a thread", "a post".
  const NOUN: Record<string, [string, string]> = {
    CAROUSEL: ['a carousel', 'carousels'],
    IMAGE_POST: ['an image post', 'image posts'],
    TWEET_THREAD: ['a thread', 'threads'],
    BLOG: ['an article', 'articles'],
  };
  const [one, many] = (chosen.contentType && NOUN[chosen.contentType]) || [
    'a post',
    'posts',
  ];
  const ideas = strings(o.details.contentIdeas).slice(0, 4);
  const competitor = signals
    .map((x) => meta(x).competitor)
    .find((c): c is string => typeof c === 'string');
  const shift = analyticsShift(signals);

  const TITLE: Record<string, string> = {
    post: `Post about: ${o.title}`,
    series: `A short series on: ${o.title}`,
    article: `Write an article on: ${o.title}`,
    'response-post': `Answer ${competitor ?? 'the competitor'}: ${o.title}`,
    'comparison-article': `Publish a comparison: ${o.title}`,
    'targeted-post': `Speak to this audience: ${o.title}`,
    'update-audience': `Add an audience: ${o.title}`,
    'connect-channel': o.title,
    'recovery-post': `Win back ${shift?.metric ?? 'results'}: ${o.title}`,
    'apply-pattern': `Do more of what works: ${o.title}`,
    'plan-it': o.title,
  };
  const ACTION: Record<string, string> = {
    post: `Publish ${one}${on} about this, this week.`,
    series: `Publish three ${many}${on} on this theme over the next two weeks.`,
    article: `Write and publish one in-depth article${on} on this topic.`,
    'response-post': `Publish ${one}${on} giving your own view on this — do not mirror ${competitor ?? 'the competitor'}’s wording.`,
    'comparison-article': `Publish an article${on} comparing your approach with ${competitor ?? 'the competitor'}’s, from your customers’ point of view.`,
    'targeted-post': `Publish ${one}${on} written for this audience.`,
    'update-audience':
      'Add this audience to your business profile so Aura plans content for it.',
    'connect-channel': `Connect ${chosen.channel ?? 'this channel'} to Aura.`,
    'recovery-post': `Publish ${one}${on} built on what has worked for you before.`,
    'apply-pattern': 'Build this pattern into next month’s content plan.',
    'plan-it': `Plan how you will act on this: ${o.title}.`,
  };
  const STEPS: Record<string, string[]> = {
    series: [
      'Post 1: the news and why it matters',
      'Post 2: your point of view',
      'Post 3: what your customers should do',
    ],
    'connect-channel': [
      'Open Connectors',
      `Connect ${chosen.channel ?? 'the channel'}`,
      'Publish your next post there from Aura',
    ],
    'update-audience': [
      'Open About my business',
      'Add the audience',
      'Generate a post for it',
    ],
    'apply-pattern': [
      'Open the content plan',
      'Apply the pattern to next month’s posts',
    ],
  };
  const OUTCOME: Record<string, [string, string | null]> = {
    post: [
      'Engagement from your audience on a topic that is current for them.',
      'engagement',
    ],
    series: [
      'Sustained engagement on the theme across the series.',
      'engagement',
    ],
    article: [
      'A lasting piece buyers find when they research this topic.',
      'traffic',
    ],
    'response-post': [
      'Buyers comparing options hear your position, not only the competitor’s.',
      'engagement',
    ],
    'comparison-article': [
      'Buyers comparing options find your side of the comparison.',
      'traffic',
    ],
    'targeted-post': [
      'A first read on whether this audience responds to you.',
      'engagement',
    ],
    'update-audience': [
      'Aura’s plans and drafts start addressing this audience.',
      null,
    ],
    'connect-channel': [
      `Posts on ${chosen.channel ?? 'this channel'} published and measured in Aura.`,
      null,
    ],
    'recovery-post': shift
      ? [
          `${shift.metric} recovers toward ${shift.from} (it went from ${shift.from} to ${shift.to}).`,
          shift.metric,
        ]
      : ['Results recover.', 'engagement'],
    'apply-pattern': [
      'Results keep improving where this pattern applies.',
      'engagement',
    ],
    'plan-it': ['Progress on this opportunity.', null],
  };

  const evidenceLine = `Based on ${h.evidence.length} piece${h.evidence.length === 1 ? '' : 's'} of evidence: ${h.evidence
    .slice(0, 3)
    .map((e) => e.label)
    .join('; ')}.`;
  const fit = chosen.reasons.length
    ? ` ${chosen.spec.label} fits because ${chosen.reasons.join('; ')}.`
    : '';
  const [outcome, metric] = OUTCOME[s.id] ?? [
    'Progress on this opportunity.',
    null,
  ];

  return recommendationContentSchema.parse({
    type: s.type,
    title: (TITLE[s.id] ?? o.title).slice(0, 200),
    summary: o.summary.slice(0, 2000),
    action: (ACTION[s.id] ?? `Act on: ${o.title}.`).slice(0, 500),
    steps: (ideas.length && s.needsChannel
      ? ideas
      : (STEPS[s.id] ?? (o.angle ? [`Take this angle: ${o.angle}`] : []))
    ).map((x) => x.slice(0, 300)),
    rationale: `${o.rationale || o.summary} ${evidenceLine}${fit}`.slice(
      0,
      2000,
    ),
    expectedOutcome: outcome,
    outcomeMetric: metric,
    channel: chosen.channel,
    contentType: s.needsChannel ? chosen.contentType : null,
    audience:
      s.type === 'CHANNEL' || s.id === 'update-audience'
        ? null
        : (ctx.audience ?? ctx.assumedAudience ?? null),
    details: {
      action: s.id,
      ...(o.angle ? { angle: o.angle } : {}),
      ...(ideas.length ? { contentIdeas: ideas } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// 3b. Writing (model) — validated
// ---------------------------------------------------------------------------

/** What the model returns: the words only. Type, channel, format and
 * audience are the engine's choice and cannot be changed by it. */
export const aiRecommendationSchema = z.object({
  title: z.string().trim().min(3).max(200),
  summary: z.string().trim().min(10).max(2000),
  action: z.string().trim().min(10).max(500),
  steps: z.array(z.string().trim().min(3).max(300)).max(6),
  rationale: z.string().trim().min(20).max(2000),
  expectedOutcome: z.string().trim().min(10).max(1000),
  outcomeMetric: z.string().trim().max(120).nullable(),
  /** References (E1, E2…) to the evidence it relies on. */
  evidence: z.array(z.string().trim().max(10)).min(1),
  businessFacts: z.array(z.string().trim().max(60)).max(12),
  assumptions: z.array(z.string().trim()).max(10),
});

export function buildWritingPrompt(args: {
  h: OpportunityHandoff;
  chosen: ScoredAction;
  snapshotText: string;
  snapshot: BusinessContextSnapshot;
  template: RecommendationContent;
}): { system: string; prompt: string } {
  const { h, chosen, template } = args;
  const facts = [...citableFacts(args.snapshot)].map(
    ([k, v]) => `${k}${v === 'assumption' ? ' (ASSUMPTION)' : ''}`,
  );
  const system = [
    'You write one marketing recommendation for one business: a clear action, why it is relevant now, and what it should achieve.',
    'The action has already been chosen; write it well. Do not change the type, channel, format or audience.',
    'Rules — output that breaks any of them is discarded:',
    '1. Cite the evidence you rely on by reference (E1, E2…). Use only those facts.',
    '2. Use only business facts from FACT KEYS, and list the ones you rely on in businessFacts.',
    '3. Do not invent numbers, results, customers, products, prices or dates. List anything you had to assume in assumptions (prefer none).',
    '4. The action is one imperative sentence the business can carry out this week.',
    'Respond with ONLY JSON: {"title","summary","action","steps":[],"rationale","expectedOutcome","outcomeMetric","evidence":["E1"],"businessFacts":[],"assumptions":[]}',
  ].join('\n');
  const prompt = [
    args.snapshotText,
    '',
    `FACT KEYS: ${facts.join(', ') || '(none)'}`,
    '',
    `OPPORTUNITY (${h.opportunity.type}): ${h.opportunity.title}`,
    h.opportunity.summary,
    h.opportunity.rationale ?? '',
    h.opportunity.angle ? `Angle: ${h.opportunity.angle}` : '',
    '',
    'EVIDENCE:',
    ...h.evidence.map(
      (e, i) => `[E${i + 1}] ${e.label}: ${e.detail.slice(0, 300)}`,
    ),
    '',
    `CHOSEN ACTION: ${chosen.spec.label} (${chosen.spec.type})`,
    `Channel: ${chosen.channel ?? 'none'}. Format: ${chosen.contentType ?? 'none'}. Audience: ${template.audience ?? 'none'}.`,
    `Why it was chosen: ${chosen.reasons.join('; ') || 'the most natural action'}`,
    '',
    'A plain draft to improve on:',
    JSON.stringify({
      title: template.title,
      action: template.action,
      steps: template.steps,
      expectedOutcome: template.expectedOutcome,
    }),
  ]
    .filter((l) => l !== '')
    .join('\n');
  return { system, prompt };
}

/**
 * Check the model's recommendation. Rejected (with reasons) if it cites no
 * evidence or evidence it was not given, relies on a business fact the
 * context does not have, declares an assumption, or states a figure none of
 * its sources contain. On success, the engine's own choices (type, channel,
 * format, audience, details) are kept and only the words are taken.
 */
export function validateAiRecommendation(
  raw: unknown,
  args: {
    h: OpportunityHandoff;
    snapshot: BusinessContextSnapshot;
    snapshotText: string;
    template: RecommendationContent;
    now: Date;
  },
):
  | { ok: true; content: RecommendationContent; cited: number[] }
  | { ok: false; reasons: string[] } {
  const parsed = aiRecommendationSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reasons: parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || 'output'}: ${i.message}`),
    };
  }
  const r = parsed.data;
  const reasons: string[] = [];
  const cited: number[] = [];
  for (const ref of r.evidence) {
    const n = Number(ref.replace(/^E/i, ''));
    if (!Number.isInteger(n) || n < 1 || n > args.h.evidence.length) {
      reasons.push(`cites ${ref}, which is not evidence it was given`);
    } else cited.push(n - 1);
  }
  const facts = citableFacts(args.snapshot);
  for (const f of r.businessFacts) {
    if (!facts.has(f))
      reasons.push(
        `relies on "${f}", which the business context does not contain`,
      );
  }
  if (r.assumptions.some((a) => a.length > 0)) {
    reasons.push(
      `declares assumptions: ${r.assumptions.join('; ').slice(0, 200)}`,
    );
  }
  const sources = [
    args.snapshotText,
    args.h.opportunity.title,
    args.h.opportunity.summary,
    args.h.opportunity.rationale ?? '',
    ...args.h.evidence.map((e) => `${e.label} ${e.detail}`),
  ].join('\n');
  const written = [
    r.title,
    r.summary,
    r.action,
    ...r.steps,
    r.rationale,
    r.expectedOutcome,
  ].join('\n');
  const invented = unsupportedNumbers(written, sources, args.now);
  if (invented.length) {
    reasons.push(`states ${invented.join(', ')}, which no source contains`);
  }
  if (reasons.length) return { ok: false, reasons };
  return {
    ok: true,
    cited: [...new Set(cited)],
    content: recommendationContentSchema.parse({
      ...args.template,
      title: r.title,
      summary: r.summary,
      action: r.action,
      steps: r.steps,
      rationale: r.rationale,
      expectedOutcome: r.expectedOutcome,
      outcomeMetric: r.outcomeMetric,
    }),
  };
}

// ---------------------------------------------------------------------------
// 4. Assessment
// ---------------------------------------------------------------------------

const CONF_RANK: Record<OpportunityConfidence, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

export interface Assessment {
  confidence: OpportunityConfidence;
  confidenceReason: string;
  priority: OpportunityPriority;
  priorityScore: number;
  priorityReason: string;
}

/**
 * CONFIDENCE starts at the opportunity's and is capped at MEDIUM when the
 * recommendation rests on anything unconfirmed (flags). PRIORITY comes from
 * the opportunity's impact, the chosen action's effort, that confidence, and
 * the time left — so a quick action on a closing opening rises, and a
 * low-confidence one never becomes high priority.
 */
export function assess(
  h: OpportunityHandoff,
  chosen: ScoredAction,
  flags: string[],
  now: Date,
): Assessment {
  let confidence = h.assessment.confidence;
  const reasons = [
    `from the opportunity: ${h.assessment.confidenceReason ?? confidence.toLowerCase()}`,
  ];
  if (flags.length && CONF_RANK[confidence] > CONF_RANK.MEDIUM) {
    confidence = 'MEDIUM';
    reasons.push(`capped at medium: ${flags[0]}`);
  }
  const impact = h.assessment.impact ?? 'medium';
  const until = h.opportunity.relevantUntil
    ? new Date(h.opportunity.relevantUntil)
    : null;
  const { priority, score } = derivePriority({
    impact,
    effort: chosen.spec.effort,
    confidence,
    relevantUntil: until,
    now,
  });
  const days = until
    ? Math.max(0, Math.ceil((until.getTime() - now.getTime()) / DAY))
    : null;
  return {
    confidence,
    confidenceReason: reasons.join('; '),
    priority,
    priorityScore: score,
    priorityReason: `${impact} impact, ${chosen.spec.effort} effort (${chosen.spec.label.toLowerCase()}), ${confidence.toLowerCase()} confidence${days !== null ? `, ${days} day(s) left` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// 5. Support gate
// ---------------------------------------------------------------------------

/**
 * The last check before anything is stored, applied to every recommendation
 * however it was written (template, model, or a person's edits):
 *
 *   REJECTED  no current evidence; an audience recommendation with no
 *             audience; a content recommendation with nowhere to publish
 *   FLAGGED   (stored, confidence capped, the flag shown) — a channel the
 *             business does not use; figures no source contains; business
 *             information it relies on that is unconfirmed or out of date;
 *             business context changed since the opportunity was detected
 */
export function checkSupport(
  content: RecommendationContent,
  args: {
    h: OpportunityHandoff;
    ctx: EngineContext;
    chosenFlags: string[];
    now: Date;
  },
): { rejected: string[]; flags: string[] } {
  const { h, ctx } = args;
  const rejected: string[] = [];
  const flags = [...args.chosenFlags];

  if (!h.evidence.some((e) => e.current))
    rejected.push('none of its evidence is current');
  if (
    content.type === 'AUDIENCE' &&
    content.details.action === 'targeted-post' &&
    !content.audience
  ) {
    rejected.push('it targets an audience, but none is known');
  }
  const publishes = ['CONTENT', 'CAMPAIGN', 'COMPETITIVE_RESPONSE'].includes(
    content.type,
  );
  if (publishes && !content.channel)
    rejected.push('it asks for content but names nowhere to publish it');

  if (
    content.channel &&
    content.type !== 'CHANNEL' &&
    !ctx.publishesOn.includes(content.channel as Channel)
  ) {
    flags.push(`${content.channel} is not a channel the business says it uses`);
  }
  const sources = [
    h.opportunity.title,
    h.opportunity.summary,
    h.opportunity.rationale ?? '',
    ...h.evidence.map((e) => `${e.label} ${e.detail}`),
    ctx.audience ?? '',
    ctx.goals ?? '',
  ].join('\n');
  const invented = unsupportedNumbers(
    [
      content.title,
      content.action,
      ...content.steps,
      content.rationale,
      content.expectedOutcome,
    ].join('\n'),
    sources,
    args.now,
  );
  if (invented.length)
    flags.push(`states ${invented.join(', ')}, which no source contains`);
  if (h.context.shakyFields.length) {
    flags.push(
      `relies on unconfirmed or out-of-date business information (${h.context.shakyFields.join(', ')})`,
    );
  }
  if (h.context.changedSinceDetection) {
    flags.push(
      'the business context has changed since the opportunity was detected',
    );
  }
  return { rejected, flags: [...new Set(flags)] };
}
