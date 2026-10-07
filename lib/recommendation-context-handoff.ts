import { z } from 'zod';

import { plainWhy } from '@/lib/aura-suggests';
import { playbookFor } from '@/lib/content-playbook';
import { LOW_CONFIDENCE_BLOCKER } from '@/lib/recommendation-rules';
import {
  CONTENT_TYPES,
  generateContentSchema,
  type ContentTypeKey,
} from '@/lib/validations/content';
import type { SocialPlatformKey } from '@/lib/platforms';

/**
 * RECOMMENDATION CONTEXT HANDOFF — the data contract Sprint 9 consumes to turn
 * an accepted recommendation into a contextual content or marketing brief.
 *
 * One versioned, validated payload carrying everything the recommendation
 * knows, plus what it was given from the Business Context — so a workflow
 * never has to read the Recommendation model's internals, and the model does
 * not need redesigning for it:
 *
 *   recommendationId · opportunityId · business · goal · audience · channel ·
 *   action · reason · evidence · expectedOutcome · cta · brandVoice · memory
 *
 * Every field says where its value came from (`source`). Nothing is invented:
 * a value Aura does not have is `null`, listed in `missing` with what that
 * means for the writer and where to add it (MISSING_FIELD_POLICY), and
 * `readiness` says whether the brief can go ahead.
 *
 * Pure and client-safe; loaded by server/recommendations/context-handoff.service.ts
 * and served at GET /api/recommendations/:id/handoff.
 */

export const CONTEXT_HANDOFF_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/** Where a value came from. */
export const VALUE_SOURCES = [
  'recommendation',
  'opportunity',
  'business_profile',
  'campaign',
  'brand_voice',
  'marketing_memory',
  'content_playbook',
] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];

const text = z.string().trim().min(1);
const sourced = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, source: z.enum(VALUE_SOURCES) });

export const HANDOFF_FIELDS = [
  'recommendationId',
  'opportunityId',
  'business',
  'goal',
  'audience',
  'channel',
  'action',
  'reason',
  'evidence',
  'expectedOutcome',
  'cta',
  'brandVoice',
  'memory',
] as const;
export type HandoffField = (typeof HANDOFF_FIELDS)[number];

export const contextHandoffSchema = z.object({
  version: z.literal(CONTEXT_HANDOFF_VERSION),
  /** Carried into everything made from it (drafts, campaigns, history). */
  recommendationId: text,
  opportunityId: text,
  status: text,
  /** Only an accepted (or edited) recommendation is handed over for real. */
  accepted: z.boolean(),
  type: text,

  business: z.object({
    name: text,
    description: text.nullable(),
    offerings: text.nullable(),
    industry: text.nullable(),
    website: text.nullable(),
  }),
  /** The business goal it serves — the business's own words, or a campaign's. */
  goal: sourced(text).nullable(),
  audience: sourced(text).nullable(),
  channel: z
    .object({
      channel: text.nullable(),
      /** The Content Studio format, when the recommendation names one. */
      contentType: z.enum(CONTENT_TYPES).nullable(),
      /** The social network the copy is written for, when there is one. */
      platform: z.enum(['LINKEDIN', 'INSTAGRAM', 'X', 'FACEBOOK']).nullable(),
      /** Aura can publish there, or the business posts it by hand. */
      publishing: z.enum(['aura', 'manual']).nullable(),
    })
    .nullable(),
  action: z.object({
    title: text,
    action: text,
    steps: z.array(text),
    angle: text.nullable(),
  }),
  reason: z.object({
    why: text,
    confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    confidenceReason: text.nullable(),
  }),
  evidence: z.array(
    z.object({
      label: text,
      detail: z.string(),
      url: z.string().nullable(),
      observedAt: z.string().nullable(),
    }),
  ),
  expectedOutcome: z.object({ outcome: text, metric: text.nullable() }),
  cta: z.object({
    /** Whether the format calls for one at all. */
    expected: z.boolean(),
    /** How a CTA is written for this format and network (the playbook's rule). */
    guidance: text.nullable(),
    /** Where it should send people. Never made up: the business's own site, or null. */
    destination: sourced(text).nullable(),
  }),
  brandVoice: z
    .object({
      summary: text.nullable(),
      tone: z.array(text),
      phrases: z.array(text),
      avoid: z.array(text),
      formatting: text.nullable(),
    })
    .nullable(),
  /** What Aura has learned works for this business, relevant to this piece. */
  memory: z.array(
    z.object({
      insight: text,
      type: text,
      confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
      /** Why it is relevant here. */
      relevance: text,
    }),
  ),

  /** What Aura does not have, and what that means (MISSING_FIELD_POLICY). */
  missing: z.array(
    z.object({
      field: z.enum(HANDOFF_FIELDS),
      level: z.enum(['required', 'recommended']),
      /** What the writer does without it. */
      behaviour: text,
      fix: z.object({ label: text, href: text }).nullable(),
    }),
  ),
  /**
   *   ready             everything a brief needs is here
   *   ready_with_gaps   can go ahead; the gaps in `missing` are stated, not filled
   *   blocked           cannot go ahead: `blockedBy` says why
   */
  readiness: z.enum(['ready', 'ready_with_gaps', 'blocked']),
  blockedBy: z.array(text),
  generatedAt: z.string(),
});
export type ContextHandoff = z.infer<typeof contextHandoffSchema>;

// ---------------------------------------------------------------------------
// Missing-field behaviour
// ---------------------------------------------------------------------------

/**
 * What happens when a field has no value. `required` blocks the handoff;
 * `recommended` lets it go ahead with the gap stated — the writer is told,
 * in these words, not to fill it in.
 */
export const MISSING_FIELD_POLICY: Record<
  HandoffField,
  {
    level: 'required' | 'recommended' | 'never-missing';
    behaviour: string;
    fix: { label: string; href: string } | null;
  }
> = {
  recommendationId: { level: 'never-missing', behaviour: '', fix: null },
  opportunityId: { level: 'never-missing', behaviour: '', fix: null },
  action: { level: 'never-missing', behaviour: '', fix: null },
  reason: { level: 'never-missing', behaviour: '', fix: null },
  expectedOutcome: { level: 'never-missing', behaviour: '', fix: null },
  business: {
    level: 'required',
    behaviour:
      'Without knowing what the business does or sells, any copy would be invented — the brief stops here.',
    fix: { label: 'Describe your business', href: '/dashboard/business' },
  },
  evidence: {
    level: 'recommended',
    behaviour:
      'No evidence to cite: the copy makes no claims about the market, competitors or results.',
    fix: null,
  },
  goal: {
    level: 'recommended',
    behaviour:
      'No business goal recorded: the copy works toward the expected outcome only, without naming a wider goal.',
    fix: { label: 'Add your goals', href: '/dashboard/business' },
  },
  audience: {
    level: 'recommended',
    behaviour:
      'No audience recorded: the copy speaks to the business’s customers in general, without inventing a persona.',
    fix: { label: 'Describe your audience', href: '/dashboard/business' },
  },
  channel: {
    level: 'recommended',
    behaviour:
      'No channel named: the person picks the format; nothing is assumed about the network.',
    fix: null,
  },
  cta: {
    level: 'recommended',
    behaviour:
      'No link to send people to: the call to action names the next step without a URL — no address is made up.',
    fix: { label: 'Add your website', href: '/dashboard/business' },
  },
  brandVoice: {
    level: 'recommended',
    behaviour:
      'No brand voice yet: Content Studio writes plainly and builds one from your materials on first use.',
    fix: { label: 'Set your brand voice', href: '/dashboard/business' },
  },
  memory: {
    level: 'recommended',
    behaviour:
      'Nothing learned from results yet that bears on this: no "what has worked" claims are made.',
    fix: null,
  },
};

// ---------------------------------------------------------------------------
// Building it
// ---------------------------------------------------------------------------

export interface HandoffInput {
  recommendation: {
    id: string;
    opportunityId: string;
    status: string;
    type: string;
    title: string;
    action: string;
    steps: string[];
    rationale: string;
    expectedOutcome: string;
    outcomeMetric: string | null;
    channel: string | null;
    contentType: string | null;
    audience: string | null;
    details: unknown;
    confidence: 'LOW' | 'MEDIUM' | 'HIGH';
    confidenceReason: string | null;
    executable: boolean;
    blockers: string[];
    evidence: {
      label: string;
      detail: string;
      url: string | null;
      observedAt: Date | null;
    }[];
  };
  business: {
    name: string;
    description: string | null;
    offerings: string | null;
    industry: string | null;
    website: string | null;
    goals: string | null;
    audience: string | null;
    campaigns: {
      name: string;
      goal: string | null;
      audience: string | null;
      themes: string[];
    }[];
    connected: string[];
    voice: {
      summary: string | null;
      tone: string[];
      phrases: string[];
      avoid: string[];
      formatting: string | null;
    } | null;
    memory: {
      insight: string;
      type: string;
      confidence: 'LOW' | 'MEDIUM' | 'HIGH';
      freshness: string;
    }[];
  };
  now?: Date;
}

const ACCEPTED = ['ACCEPTED', 'EDITED', 'IN_PROGRESS'];

const CHANNEL_PLATFORM: Record<string, SocialPlatformKey> = {
  LinkedIn: 'LINKEDIN',
  Instagram: 'INSTAGRAM',
  X: 'X',
  Facebook: 'FACEBOOK',
};

const nonEmpty = (v: string | null | undefined) =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

const words = (t: string) =>
  new Set(
    t
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );

/** Words that name a format, so a learned pattern about it can be recognised. */
const FORMAT_WORDS: Record<string, string[]> = {
  CAROUSEL: ['carousel'],
  TWEET_THREAD: ['thread'],
  BLOG: ['article', 'blog'],
  EMAIL: ['email', 'newsletter'],
  IMAGE_POST: ['image', 'photo', 'visual'],
  AD: [' ad ', ' ads ', 'advert'],
};

/** Words in any recommendation that say nothing about its topic. */
const GENERIC_WORDS = new Set([
  'post',
  'posts',
  'publish',
  'your',
  'this',
  'that',
  'with',
  'about',
  'giving',
  'view',
  'content',
  'week',
  'linkedin',
  'instagram',
]);

/** Learned patterns that bear on this piece, and why. Low-confidence or stale ones are left out. */
export function relevantMemory(
  memory: HandoffInput['business']['memory'],
  r: HandoffInput['recommendation'],
  limit = 4,
): ContextHandoff['memory'] {
  // Topic words only: what the piece is about, not how any post is phrased.
  const about = new Set(
    [...words(`${r.title} ${r.action}`)].filter((w) => !GENERIC_WORDS.has(w)),
  );
  const formatWords = FORMAT_WORDS[r.contentType ?? ''] ?? [];
  const channel = (r.channel ?? '').toLowerCase();
  return memory
    .filter((m) => m.confidence !== 'LOW' && m.freshness !== 'stale')
    .map((m) => {
      const text = m.insight.toLowerCase();
      const relevance =
        channel && text.includes(channel)
          ? `about ${r.channel}, where this runs`
          : formatWords.some((f) => text.includes(f))
            ? 'about this format'
            : [...words(m.insight)].some((w) => about.has(w))
              ? 'about this topic'
              : [
                    'CONTENT_LENGTH',
                    'TIMING',
                    'HASHTAG',
                    'CONTENT_FORMAT',
                  ].includes(m.type)
                ? 'how your content performs in general'
                : null;
      return relevance
        ? {
            insight: m.insight,
            type: m.type,
            confidence: m.confidence,
            relevance,
          }
        : null;
    })
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .slice(0, limit);
}

export function buildContextHandoff(input: HandoffInput): ContextHandoff {
  const r = input.recommendation;
  const b = input.business;
  const now = input.now ?? new Date();
  const details =
    r.details && typeof r.details === 'object'
      ? (r.details as Record<string, unknown>)
      : {};

  // GOAL: the business's own goal; else the goal of a campaign it relates to.
  const topicWords = words(
    `${r.title} ${r.action} ${String(details.topic ?? '')}`,
  );
  const campaign = b.campaigns.find(
    (c) =>
      c.goal &&
      c.themes.some((t) => [...words(t)].some((w) => topicWords.has(w))),
  );
  const goal = nonEmpty(b.goals)
    ? { value: b.goals!.trim(), source: 'business_profile' as const }
    : campaign?.goal
      ? { value: campaign.goal, source: 'campaign' as const }
      : null;

  // AUDIENCE: the recommendation's own; else the business's stated buyer.
  const audience = nonEmpty(r.audience)
    ? { value: r.audience!.trim(), source: 'recommendation' as const }
    : nonEmpty(b.audience)
      ? { value: b.audience!.trim(), source: 'business_profile' as const }
      : null;

  // CHANNEL
  const contentType = (CONTENT_TYPES as readonly string[]).includes(
    r.contentType ?? '',
  )
    ? (r.contentType as ContentTypeKey)
    : null;
  const platform = r.channel ? (CHANNEL_PLATFORM[r.channel] ?? null) : null;
  const channel =
    r.channel || contentType
      ? {
          channel: r.channel,
          contentType,
          platform,
          publishing: r.channel
            ? b.connected.includes(r.channel)
              ? ('aura' as const)
              : ('manual' as const)
            : null,
        }
      : null;

  // CTA: whether the format wants one, how it is written, where it goes.
  const playbook = contentType ? playbookFor(contentType, platform) : null;
  const ctaRule = playbook?.rules.find((x) => x.includes('`cta`')) ?? null;
  const website = nonEmpty(b.website);
  const cta = {
    expected: playbook ? playbook.limits.ctaExpected : true,
    guidance: ctaRule ? ctaRule.replace(/`cta`:\s*/, '') : null,
    destination: website
      ? { value: website, source: 'business_profile' as const }
      : null,
  };

  const voice =
    b.voice &&
    (nonEmpty(b.voice.summary) || b.voice.tone.length || b.voice.phrases.length)
      ? {
          summary: nonEmpty(b.voice.summary),
          tone: b.voice.tone.filter(Boolean),
          phrases: b.voice.phrases.filter(Boolean),
          avoid: b.voice.avoid.filter(Boolean),
          formatting: nonEmpty(b.voice.formatting),
        }
      : null;

  const memory = relevantMemory(b.memory, r);

  // --- What is missing ------------------------------------------------------
  const absent: HandoffField[] = [];
  if (!nonEmpty(b.description) && !nonEmpty(b.offerings))
    absent.push('business');
  if (r.evidence.length === 0) absent.push('evidence');
  if (!goal) absent.push('goal');
  if (!audience) absent.push('audience');
  if (!channel) absent.push('channel');
  if (cta.expected && !cta.destination) absent.push('cta');
  if (!voice) absent.push('brandVoice');
  if (memory.length === 0) absent.push('memory');
  const missing = absent.map((field) => {
    const p = MISSING_FIELD_POLICY[field];
    return {
      field,
      level: p.level as 'required' | 'recommended',
      behaviour: p.behaviour,
      fix: p.fix,
    };
  });

  // --- Can it go ahead? -----------------------------------------------------
  const accepted = ACCEPTED.includes(r.status);
  const blockedBy: string[] = [];
  if (!accepted) {
    blockedBy.push(
      r.status === 'GENERATED' || r.status === 'PRESENTED'
        ? 'It has not been accepted yet. Accept or edit it first.'
        : `It is ${r.status.toLowerCase().replace('_', ' ')} — there is nothing to hand over.`,
    );
  }
  for (const blocker of r.blockers) {
    // Accepting is the review a low-confidence recommendation needs; until
    // then, "accept it first" above already says so.
    if (blocker === LOW_CONFIDENCE_BLOCKER) continue;
    blockedBy.push(blocker);
  }
  for (const m of missing) {
    if (m.level === 'required') blockedBy.push(m.behaviour);
  }
  const readiness: ContextHandoff['readiness'] = blockedBy.length
    ? 'blocked'
    : missing.length
      ? 'ready_with_gaps'
      : 'ready';

  return contextHandoffSchema.parse({
    version: CONTEXT_HANDOFF_VERSION,
    recommendationId: r.id,
    opportunityId: r.opportunityId,
    status: r.status,
    accepted,
    type: r.type,
    business: {
      name: b.name,
      description: nonEmpty(b.description),
      offerings: nonEmpty(b.offerings),
      industry: nonEmpty(b.industry),
      website,
    },
    goal,
    audience,
    channel,
    action: {
      title: r.title,
      action: r.action,
      steps: r.steps.filter((s) => s.trim()),
      angle: nonEmpty(typeof details.angle === 'string' ? details.angle : null),
    },
    reason: {
      why: plainWhy(r.rationale) || r.rationale,
      confidence: r.confidence,
      confidenceReason: nonEmpty(r.confidenceReason),
    },
    evidence: r.evidence.map((e) => ({
      label: e.label,
      detail: e.detail,
      url: e.url,
      observedAt: e.observedAt?.toISOString() ?? null,
    })),
    expectedOutcome: {
      outcome: r.expectedOutcome,
      metric: nonEmpty(r.outcomeMetric),
    },
    cta,
    brandVoice: voice,
    memory,
    missing,
    readiness,
    blockedBy,
    generatedAt: now.toISOString(),
  });
}

/** Validate a payload from elsewhere (another service, a stored copy). */
export function validateContextHandoff(
  payload: unknown,
): { ok: true; handoff: ContextHandoff } | { ok: false; errors: string[] } {
  const parsed = contextHandoffSchema.safeParse(payload);
  return parsed.success
    ? { ok: true, handoff: parsed.data }
    : {
        ok: false,
        errors: parsed.error.issues.map(
          (i) => `${i.path.join('.') || '(payload)'}: ${i.message}`,
        ),
      };
}

// ---------------------------------------------------------------------------
// Content Studio
// ---------------------------------------------------------------------------

/** Content Studio's brief limit (generationSourceSchema). */
export const CONTENT_BRIEF_LIMIT = 2000;

/**
 * The brief Content Studio writes from. Content Studio already reads the
 * business, its audience, goals, brand voice and learned patterns from the
 * Business Context on every draft; the brief carries what only the
 * recommendation knows, the CTA requirement, and — explicitly — what is NOT
 * provided, so the writer leaves it out instead of making it up.
 */
export function handoffBrief(h: ContextHandoff): string {
  const lines: string[] = [
    h.action.title,
    h.action.action,
    ...h.action.steps.map((s) => `- ${s}`),
  ];
  // The engine often puts the angle in a step already; say it once.
  if (
    h.action.angle &&
    !h.action.steps.some((x) => x.includes(h.action.angle!))
  ) {
    lines.push(`Angle: ${h.action.angle}`);
  }
  if (h.audience) lines.push(`For: ${h.audience.value}`);
  lines.push(`Why: ${h.reason.why}`);
  if (h.goal) lines.push(`Business goal: ${h.goal.value}`);
  lines.push(`Expected outcome: ${h.expectedOutcome.outcome}`);
  if (h.evidence.length) {
    lines.push(
      `Evidence (cite only this): ${h.evidence
        .slice(0, 3)
        .map((e) => e.label)
        .join('; ')}`,
    );
  }
  if (h.cta.expected) {
    lines.push(
      h.cta.destination
        ? `CTA: send people to ${h.cta.destination.value}.`
        : 'CTA: name the next step, with no URL.',
    );
  }
  if (h.memory.length) {
    lines.push(`What has worked: ${h.memory.map((m) => m.insight).join('; ')}`);
  }
  const notProvided = h.missing
    .filter((m) => ['goal', 'audience', 'evidence', 'memory'].includes(m.field))
    .map((m) => m.field);
  if (notProvided.length) {
    lines.push(`Not provided — do not invent: ${notProvided.join(', ')}.`);
  }
  // Within Content Studio's limit, dropping the least essential lines first.
  let brief = lines.join('\n');
  while (brief.length > CONTENT_BRIEF_LIMIT && lines.length > 4) {
    const i = lines.findIndex(
      (l) => l.startsWith('- ') || l.startsWith('What has worked'),
    );
    lines.splice(i === -1 ? lines.length - 2 : i, 1);
    brief = lines.join('\n');
  }
  return brief.slice(0, CONTENT_BRIEF_LIMIT);
}

/**
 * The Content Studio generation request for this handoff — validated against
 * Content Studio's own request schema, so Sprint 9 can post it as it is.
 * Null when the handoff is blocked or names no format.
 */
export function handoffToContentRequest(
  h: ContextHandoff,
): z.infer<typeof generateContentSchema> | null {
  if (h.readiness === 'blocked' || !h.channel?.contentType) return null;
  return generateContentSchema.parse({
    type: h.channel.contentType,
    ...(h.channel.platform ? { platform: h.channel.platform } : {}),
    source: { kind: 'BRIEF', brief: handoffBrief(h) },
    recommendationId: h.recommendationId,
  });
}
