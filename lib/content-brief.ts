import { z } from 'zod';

import { playbookFor } from '@/lib/content-playbook';
import { CONTENT_TYPE_LABELS } from '@/lib/content-ui';
import {
  ASPECT_RATIOS,
  platformSpec,
  platformsForType,
  resolvePlatform,
  SOCIAL_PLATFORMS,
  type SocialPlatformKey,
} from '@/lib/platforms';
import {
  NOT_ACCEPTED_BLOCKER,
  VALUE_SOURCES,
  type ContextHandoff,
} from '@/lib/recommendation-context-handoff';
import {
  CONTENT_TYPES,
  generateContentSchema,
  type ContentTypeKey,
} from '@/lib/validations/content';

/**
 * CONTENT BRIEF — the source of truth for what Aura is expected to create.
 *
 * Sits between the Recommendation Engine and Content Studio. Built from an
 * accepted recommendation's Context Handoff (which already carries the
 * business context, goal, audience, evidence, CTA, brand voice and learned
 * patterns, each with its source) plus what the handoff does not: the
 * opportunity behind it, the key message, the content type and the channel's
 * copy and asset requirements.
 *
 *   recommendation · opportunity · businessContext · marketingGoal ·
 *   targetAudience · channel · recommendedAction · keyMessage · reason ·
 *   evidence · expectedOutcome · cta · brandVoice · relevantMemory ·
 *   contentType · assetRequirements
 *
 * Every field is required, recommended or optional (BRIEF_FIELD_POLICY); a
 * field Aura does not have is null and listed in `missing` with what that
 * means for the writer and where to add it — never filled in. `readiness`
 * says whether it can go to Content Studio, and validateContentBrief() is run
 * before anything is generated from it.
 *
 * Pure and client-safe. Loaded by server/content/content-brief.service.ts,
 * served at GET /api/recommendations/:id/brief.
 */

export const CONTENT_BRIEF_VERSION = 1 as const;

export const BRIEF_FIELDS = [
  'recommendation',
  'opportunity',
  'businessContext',
  'marketingGoal',
  'targetAudience',
  'channel',
  'recommendedAction',
  'keyMessage',
  'reason',
  'evidence',
  'expectedOutcome',
  'cta',
  'brandVoice',
  'relevantMemory',
  'contentType',
  'assetRequirements',
] as const;
export type BriefField = (typeof BRIEF_FIELDS)[number];

export type FieldRequirement = 'required' | 'recommended' | 'optional';

/**
 * Required vs optional, and what happens without each.
 *
 *   required     the brief cannot go to Content Studio without it
 *   recommended  it can; the gap is stated and the writer works without it
 *   optional     nice to have; its absence changes little
 */
export const BRIEF_FIELD_POLICY: Record<
  BriefField,
  {
    requirement: FieldRequirement;
    /** What the writer does without it. */
    whenMissing: string;
    fix: { label: string; href: string } | null;
  }
> = {
  recommendation: {
    requirement: 'required',
    whenMissing: 'There is no recommendation to write from.',
    fix: null,
  },
  opportunity: {
    requirement: 'required',
    whenMissing:
      'The opportunity behind the recommendation is gone, so there is nothing to ground it in.',
    fix: null,
  },
  businessContext: {
    requirement: 'required',
    whenMissing:
      'Without knowing what the business does or sells, any copy would be invented — the brief stops here.',
    fix: {
      label: 'Describe your business',
      href: '/dashboard/business?ask=identity.description',
    },
  },
  marketingGoal: {
    requirement: 'recommended',
    whenMissing:
      'No business goal recorded: the copy works toward the expected outcome only, without naming a wider goal.',
    fix: { label: 'Add your goals', href: '/dashboard/business' },
  },
  targetAudience: {
    requirement: 'recommended',
    whenMissing:
      'No audience recorded: the copy speaks to the business’s customers in general, without inventing a persona.',
    fix: { label: 'Describe your audience', href: '/dashboard/business' },
  },
  channel: {
    requirement: 'recommended',
    whenMissing:
      'No channel named: written for the format’s usual network; nothing else is assumed.',
    fix: null,
  },
  recommendedAction: {
    requirement: 'required',
    whenMissing: 'There is no action to carry out.',
    fix: null,
  },
  keyMessage: {
    requirement: 'required',
    whenMissing: 'There is no message to build the piece around.',
    fix: null,
  },
  reason: {
    requirement: 'required',
    whenMissing: 'There is no reason recorded for doing this.',
    fix: null,
  },
  evidence: {
    requirement: 'recommended',
    whenMissing:
      'No evidence to cite: the copy makes no claims about the market, competitors or results.',
    fix: null,
  },
  expectedOutcome: {
    requirement: 'required',
    whenMissing: 'There is no outcome to aim for.',
    fix: null,
  },
  cta: {
    requirement: 'recommended',
    whenMissing:
      'No link to send people to: the call to action names the next step without a URL — no address is made up.',
    fix: { label: 'Add your website', href: '/dashboard/business' },
  },
  brandVoice: {
    requirement: 'recommended',
    whenMissing:
      'No brand voice yet: Content Studio writes plainly and builds one from your materials on first use.',
    fix: { label: 'Set your brand voice', href: '/dashboard/business' },
  },
  relevantMemory: {
    requirement: 'optional',
    whenMissing:
      'Nothing learned from results yet that bears on this: no "what has worked" claims are made.',
    fix: null,
  },
  contentType: {
    requirement: 'required',
    whenMissing:
      'No format chosen: pick one in Content Studio — Aura does not guess what to make.',
    fix: null,
  },
  assetRequirements: {
    requirement: 'required',
    whenMissing: 'Asset requirements follow from the format — pick one first.',
    fix: null,
  },
};

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

const text = z.string().trim().min(1);
const BRIEF_SOURCES = [...VALUE_SOURCES, 'person', 'platform'] as const;
export type BriefSource = (typeof BRIEF_SOURCES)[number];
const sourced = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, source: z.enum(BRIEF_SOURCES) });

export const contentBriefSchema = z.object({
  version: z.literal(CONTENT_BRIEF_VERSION),
  recommendation: z.object({
    id: text,
    title: text,
    type: text,
    status: text,
    accepted: z.boolean(),
  }),
  opportunity: z
    .object({
      id: text,
      title: text,
      type: text,
      typeLabel: text,
      summary: z.string(),
      angle: text.nullable(),
      /** Where to see it in Aura. */
      href: text,
    })
    .nullable(),
  businessContext: z
    .object({
      name: text,
      description: text.nullable(),
      offerings: text.nullable(),
      industry: text.nullable(),
      website: text.nullable(),
    })
    .nullable(),
  marketingGoal: sourced(text).nullable(),
  targetAudience: sourced(text).nullable(),
  channel: z
    .object({
      /** The channel as the business names it ("LinkedIn"). */
      name: text.nullable(),
      platform: z.enum(SOCIAL_PLATFORMS).nullable(),
      /** Aura can publish there, or it is posted by hand. */
      publishing: z.enum(['aura', 'manual']).nullable(),
      source: z.enum(BRIEF_SOURCES),
      /** How copy is written for this network and format — the playbook. */
      requirements: z.array(text),
    })
    .nullable(),
  recommendedAction: z.object({
    action: text,
    steps: z.array(text),
  }),
  keyMessage: sourced(text).nullable(),
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
    expected: z.boolean(),
    guidance: text.nullable(),
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
  relevantMemory: z.array(
    z.object({
      insight: text,
      type: text,
      confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
      relevance: text,
    }),
  ),
  contentType: z
    .object({
      key: z.enum(CONTENT_TYPES),
      label: text,
      source: z.enum(BRIEF_SOURCES),
    })
    .nullable(),
  assetRequirements: z
    .object({
      copy: z.object({
        maxChars: z.number().int().positive(),
        idealMaxChars: z.number().int().positive(),
        hashtags: z.object({ min: z.number().int(), max: z.number().int() }),
        ctaExpected: z.boolean(),
      }),
      visual: z.object({
        /** required: the post cannot go out without one · recommended · none */
        need: z.enum(['required', 'recommended', 'none']),
        count: z.object({ min: z.number().int(), max: z.number().int() }),
        aspectRatio: z.enum(ASPECT_RATIOS).nullable(),
        ratios: z.array(z.enum(ASPECT_RATIOS)),
        minDimension: z.number().int().nullable(),
        maxFileSizeMb: z.number().nullable(),
        formats: z.array(text),
        direction: text.nullable(),
      }),
      notes: z.array(text),
    })
    .nullable(),

  /** Each field: how much it matters, and whether it is here. */
  fields: z.array(
    z.object({
      field: z.enum(BRIEF_FIELDS),
      requirement: z.enum(['required', 'recommended', 'optional']),
      provided: z.boolean(),
    }),
  ),
  /** What is not here, and what that means. */
  missing: z.array(
    z.object({
      field: z.enum(BRIEF_FIELDS),
      requirement: z.enum(['required', 'recommended', 'optional']),
      whenMissing: text,
      fix: z.object({ label: text, href: text }).nullable(),
    }),
  ),
  /**
   *   ready            every required field, nothing recommended missing
   *   ready_with_gaps  every required field; recommended gaps stated
   *   blocked          cannot go to Content Studio: `blockedBy` says why
   */
  readiness: z.enum(['ready', 'ready_with_gaps', 'blocked']),
  blockedBy: z.array(text),
  generatedAt: z.string(),
});

export type ContentBrief = z.infer<typeof contentBriefSchema>;

// ---------------------------------------------------------------------------
// Building it
// ---------------------------------------------------------------------------

export interface BriefOpportunity {
  id: string;
  title: string;
  type: string;
  typeLabel: string;
  summary: string;
  angle: string | null;
}

export interface BuildBriefInput {
  handoff: ContextHandoff;
  /** The opportunity it came from; null if it no longer exists. */
  opportunity: BriefOpportunity | null;
  /**
   * The person's choice in Content Studio, when they make one: fills a format
   * or network the recommendation did not name, or overrides it.
   */
  choice?: { type?: ContentTypeKey; platform?: SocialPlatformKey } | null;
  /** Formats this workspace has turned on; a disabled one is not usable. */
  enabledTypes?: ContentTypeKey[];
}

const PLATFORM_CHANNEL: Record<SocialPlatformKey, string> = {
  LINKEDIN: 'LinkedIn',
  INSTAGRAM: 'Instagram',
  X: 'X',
  FACEBOOK: 'Facebook',
};

/** Formats published without a network: their copy rules do not depend on one. */
const OFF_NETWORK: ContentTypeKey[] = ['BLOG', 'EMAIL'];

/** How many images each format takes, and whether it needs them. */
type VisualRequirements = NonNullable<
  ContentBrief['assetRequirements']
>['visual'];

function visualFor(
  type: ContentTypeKey,
  platform: SocialPlatformKey | null,
): VisualRequirements {
  const spec = platform ? platformSpec(platform) : null;
  const base = {
    aspectRatio: spec?.defaultRatio ?? null,
    ratios: spec?.ratios ?? [],
    minDimension: spec?.minDimension ?? null,
    maxFileSizeMb: spec
      ? Math.round((spec.maxFileSizeBytes / 1_048_576) * 10) / 10
      : null,
    formats:
      spec?.acceptedMimeTypes.map((m) =>
        m.replace('image/', '').toUpperCase(),
      ) ?? [],
    direction: spec?.artDirection ?? null,
  };
  switch (type) {
    case 'IMAGE_POST':
      return { need: 'required', count: { min: 1, max: 1 }, ...base };
    case 'CAROUSEL':
      return { need: 'required', count: { min: 3, max: 10 }, ...base };
    case 'TWEET_THREAD':
      return { need: 'none', count: { min: 0, max: 1 }, ...base };
    case 'EMAIL':
      return {
        need: 'recommended',
        count: { min: 0, max: 1 },
        ...base,
        aspectRatio: '16:9',
      };
    case 'BLOG':
      return {
        need: 'recommended',
        count: { min: 1, max: 1 },
        ...base,
        aspectRatio: '16:9',
      };
    case 'AD':
      return { need: 'required', count: { min: 1, max: 1 }, ...base };
    default:
      return {
        need: spec?.requiresMedia ? 'required' : 'recommended',
        count: { min: spec?.requiresMedia ? 1 : 0, max: 1 },
        ...base,
      };
  }
}

/**
 * The one thing the piece must get across.
 *
 * The recommendation's own angle when it has one, else the opportunity's,
 * else its first concrete step — and only then the action itself. Never
 * invented: every candidate is something Aura already recorded.
 */
function keyMessageFor(
  h: ContextHandoff,
  o: BriefOpportunity | null,
): ContentBrief['keyMessage'] {
  if (h.action.angle)
    return { value: h.action.angle, source: 'recommendation' };
  if (o?.angle?.trim()) return { value: o.angle.trim(), source: 'opportunity' };
  const step = h.action.steps.find((s) => s.trim().length > 15);
  if (step) return { value: step.trim(), source: 'recommendation' };
  return h.action.action
    ? { value: h.action.action, source: 'recommendation' }
    : null;
}

export function buildContentBrief(
  input: BuildBriefInput,
  now: Date = new Date(),
): ContentBrief {
  const { handoff: h, opportunity: o, choice, enabledTypes } = input;

  // Content type: the person's choice, else the recommendation's — and only
  // if this workspace has that format turned on.
  const wanted: { key: ContentTypeKey; source: BriefSource } | null =
    choice?.type
      ? { key: choice.type, source: 'person' }
      : h.channel?.contentType
        ? { key: h.channel.contentType, source: 'recommendation' }
        : null;
  const typeDisabled = Boolean(
    wanted && enabledTypes && !enabledTypes.includes(wanted.key),
  );
  const type = wanted && !typeDisabled ? wanted : null;

  // Network: the person's (if the format can go there), else the
  // recommendation's, else the format's usual one.
  const allowed = type ? platformsForType(type.key) : [];
  const platform: SocialPlatformKey | null = !type
    ? (h.channel?.platform ?? null)
    : OFF_NETWORK.includes(type.key)
      ? null
      : choice?.platform && allowed.includes(choice.platform)
        ? choice.platform
        : h.channel?.platform && allowed.includes(h.channel.platform)
          ? h.channel.platform
          : resolvePlatform(type.key, null);
  const platformSource: BriefSource =
    choice?.platform && platform === choice.platform
      ? 'person'
      : h.channel?.platform && platform === h.channel.platform
        ? 'recommendation'
        : 'platform';

  const playbook = type ? playbookFor(type.key, platform) : null;
  const channelName =
    h.channel?.channel ?? (platform ? PLATFORM_CHANNEL[platform] : null);
  const channel: ContentBrief['channel'] =
    channelName || platform || playbook
      ? {
          name: channelName,
          platform,
          publishing: h.channel?.publishing ?? null,
          source: h.channel?.channel ? 'recommendation' : platformSource,
          requirements: playbook?.rules ?? [],
        }
      : null;

  const assetRequirements: ContentBrief['assetRequirements'] =
    type && playbook
      ? {
          copy: {
            maxChars: playbook.limits.hardMaxChars,
            idealMaxChars: playbook.limits.softMaxChars,
            hashtags: {
              min: playbook.limits.hashtagMin,
              max: playbook.limits.hashtagMax,
            },
            ctaExpected: playbook.limits.ctaExpected,
          },
          visual: visualFor(type.key, platform),
          notes: [
            `${playbook.label}: aim for up to ${playbook.limits.softMaxChars.toLocaleString('en')} characters (hard limit ${playbook.limits.hardMaxChars.toLocaleString('en')}).`,
            ...(h.channel?.publishing === 'manual' && channelName
              ? [`${channelName} is not connected — this is posted by hand.`]
              : []),
          ],
        }
      : null;

  // CTA follows the chosen format, not the recommendation's original one.
  const ctaRule = playbook?.rules.find((x) => x.includes('`cta`')) ?? null;
  const cta: ContentBrief['cta'] = {
    expected: playbook ? playbook.limits.ctaExpected : h.cta.expected,
    guidance: ctaRule ? ctaRule.replace(/`cta`:\s*/, '') : h.cta.guidance,
    destination: h.cta.destination,
  };

  const businessContext: ContentBrief['businessContext'] =
    h.business.description || h.business.offerings ? h.business : null;
  const keyMessage = keyMessageFor(h, o);

  const values: Record<BriefField, boolean> = {
    recommendation: true,
    opportunity: o !== null,
    businessContext: businessContext !== null,
    marketingGoal: h.goal !== null,
    targetAudience: h.audience !== null,
    channel: channel !== null && Boolean(channel.name || channel.platform),
    recommendedAction: Boolean(h.action.action),
    keyMessage: keyMessage !== null,
    reason: Boolean(h.reason.why),
    evidence: h.evidence.length > 0,
    expectedOutcome: Boolean(h.expectedOutcome.outcome),
    cta: !cta.expected || cta.destination !== null,
    brandVoice: h.brandVoice !== null,
    relevantMemory: h.memory.length > 0,
    contentType: type !== null,
    assetRequirements: assetRequirements !== null,
  };

  const missing: ContentBrief['missing'] = BRIEF_FIELDS.filter(
    (f) => !values[f],
  ).map((field) => {
    const p = BRIEF_FIELD_POLICY[field];
    // A format the workspace turned off says so, rather than "none chosen".
    const whenMissing =
      field === 'contentType' && typeDisabled
        ? `${CONTENT_TYPE_LABELS[wanted!.key]} is turned off for this workspace — pick another format, or turn it on in Settings → Content formats.`
        : p.whenMissing;
    return { field, requirement: p.requirement, whenMissing, fix: p.fix };
  });

  const blockedBy: string[] = [];
  if (!h.accepted) {
    blockedBy.push(
      h.status === 'GENERATED' || h.status === 'PRESENTED'
        ? NOT_ACCEPTED_BLOCKER
        : `It is ${h.status.toLowerCase().replace('_', ' ')} — there is nothing to write from it.`,
    );
  }
  // Other things in the way recorded by the handoff (a channel the business
  // does not use), apart from what this brief re-checks itself.
  for (const b of h.blockedBy) {
    if (b === NOT_ACCEPTED_BLOCKER || b.startsWith('It is ')) continue;
    if (b === BRIEF_FIELD_POLICY.businessContext.whenMissing) continue;
    blockedBy.push(b);
  }
  for (const m of missing) {
    if (m.requirement === 'required') blockedBy.push(m.whenMissing);
  }
  const readiness: ContentBrief['readiness'] = blockedBy.length
    ? 'blocked'
    : missing.some((m) => m.requirement === 'recommended')
      ? 'ready_with_gaps'
      : 'ready';

  return contentBriefSchema.parse({
    version: CONTENT_BRIEF_VERSION,
    recommendation: {
      id: h.recommendationId,
      title: h.action.title,
      type: h.type,
      status: h.status,
      accepted: h.accepted,
    },
    opportunity: o
      ? {
          ...o,
          angle: o.angle?.trim() || null,
          href: `/dashboard/opportunities?focus=${o.id}`,
        }
      : null,
    businessContext,
    marketingGoal: h.goal,
    targetAudience: h.audience,
    channel,
    recommendedAction: { action: h.action.action, steps: h.action.steps },
    keyMessage,
    reason: h.reason,
    evidence: h.evidence,
    expectedOutcome: h.expectedOutcome,
    cta,
    brandVoice: h.brandVoice,
    relevantMemory: h.memory,
    contentType: type
      ? {
          key: type.key,
          label: CONTENT_TYPE_LABELS[type.key],
          source: type.source,
        }
      : null,
    assetRequirements,
    fields: BRIEF_FIELDS.map((field) => ({
      field,
      requirement: BRIEF_FIELD_POLICY[field].requirement,
      provided: values[field],
    })),
    missing,
    readiness,
    blockedBy,
    generatedAt: now.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Checking it before anything is generated
// ---------------------------------------------------------------------------

export interface BriefValidation {
  ok: boolean;
  /** Plain reasons it cannot be generated from. */
  errors: string[];
  /** Gaps it can go ahead with, stated. */
  warnings: string[];
}

/**
 * Run before generation. A brief is generated from only if it matches the
 * schema, every required field is present, it is not blocked, and its parts
 * agree with each other (the format can run on the network; the asset
 * requirements are the format's).
 */
export function validateContentBrief(value: unknown): BriefValidation {
  const parsed = contentBriefSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join('.') || 'brief'}: ${i.message}`,
      ),
      warnings: [],
    };
  }
  const b = parsed.data;
  const errors = [...b.blockedBy];
  for (const f of b.fields) {
    if (f.requirement === 'required' && !f.provided) {
      const why = BRIEF_FIELD_POLICY[f.field].whenMissing;
      if (
        !errors.includes(why) &&
        !b.missing.some(
          (m) => m.field === f.field && errors.includes(m.whenMissing),
        )
      ) {
        errors.push(why);
      }
    }
  }
  if (
    b.contentType &&
    b.channel?.platform &&
    !OFF_NETWORK.includes(b.contentType.key)
  ) {
    if (!platformsForType(b.contentType.key).includes(b.channel.platform)) {
      errors.push(
        `A ${b.contentType.label} can’t be written for ${b.channel.platform}.`,
      );
    }
  }
  if (b.contentType && !b.assetRequirements) {
    errors.push(BRIEF_FIELD_POLICY.assetRequirements.whenMissing);
  }
  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: b.missing
      .filter((m) => m.requirement !== 'required')
      .map((m) => m.whenMissing),
  };
}

// ---------------------------------------------------------------------------
// Into Content Studio
// ---------------------------------------------------------------------------

/** Content Studio's brief limit (generationSourceSchema). */
export const BRIEF_TEXT_LIMIT = 2000;

/**
 * The editable brief text Content Studio shows the person: what to make and
 * the message, in their words to change. The full structured brief travels
 * separately (and is what the writer is held to).
 */
export function briefText(b: ContentBrief): string {
  const lines = [
    b.recommendation.title,
    b.recommendedAction.action,
    ...b.recommendedAction.steps.map((s) => `- ${s}`),
  ];
  if (b.keyMessage && !lines.some((l) => l.includes(b.keyMessage!.value))) {
    lines.push(`Key message: ${b.keyMessage.value}`);
  }
  if (b.targetAudience) lines.push(`For: ${b.targetAudience.value}`);
  // Within Content Studio's limit: drop steps first, then the trailing lines.
  let out = lines.join('\n');
  while (out.length > BRIEF_TEXT_LIMIT && lines.length > 2) {
    const step = lines.findIndex((l) => l.startsWith('- '));
    lines.splice(step === -1 ? lines.length - 1 : step, 1);
    out = lines.join('\n');
  }
  return out.slice(0, BRIEF_TEXT_LIMIT);
}

/**
 * The writer's instructions from the brief: everything it holds the piece to,
 * section by section, with gaps stated as "do not invent". The person's
 * edited brief text still decides angle and wording.
 */
export function briefPrompt(b: ContentBrief): string {
  const out: string[] = [
    'CONTENT BRIEF (from Aura’s recommendation — hold the piece to this):',
  ];
  if (b.opportunity)
    out.push(
      `Opportunity: ${b.opportunity.title} (${b.opportunity.typeLabel}).`,
    );
  if (b.keyMessage) out.push(`Key message: ${b.keyMessage.value}`);
  out.push(`Why now: ${b.reason.why}`);
  if (b.marketingGoal) out.push(`Marketing goal: ${b.marketingGoal.value}`);
  if (b.targetAudience) out.push(`Audience: ${b.targetAudience.value}`);
  out.push(`Expected outcome: ${b.expectedOutcome.outcome}`);
  out.push(
    b.evidence.length
      ? `Evidence (cite only this; invent nothing beyond it): ${b.evidence.map((e) => e.label).join('; ')}`
      : 'Evidence: none recorded — make no claims about the market, competitors or results.',
  );
  if (b.cta.expected) {
    out.push(
      b.cta.destination
        ? `Call to action: send people to ${b.cta.destination.value}.`
        : 'Call to action: name the next step, with no URL — none is known.',
    );
  }
  if (b.relevantMemory.length) {
    out.push(
      `What has worked before: ${b.relevantMemory.map((m) => m.insight).join('; ')}`,
    );
  }
  if (b.assetRequirements) {
    const c = b.assetRequirements.copy;
    out.push(
      `Length: up to ${c.idealMaxChars} characters (never over ${c.maxChars}); hashtags ${c.hashtags.min}–${c.hashtags.max}.`,
    );
  }
  const gaps = b.missing
    .filter((m) =>
      [
        'marketingGoal',
        'targetAudience',
        'evidence',
        'relevantMemory',
      ].includes(m.field),
    )
    .map((m) => m.field);
  if (gaps.length)
    out.push(`Not provided — do not invent: ${gaps.join(', ')}.`);
  out.push(
    'Where the brief text above differs on angle or wording, follow it.',
  );
  return out.join('\n');
}

/**
 * The Content Studio generation request for a brief — the same request the
 * page posts, so a brief can go to Content Studio with nothing re-entered.
 * Null unless the brief validates.
 */
export function briefToContentRequest(
  b: ContentBrief,
): z.infer<typeof generateContentSchema> | null {
  if (!validateContentBrief(b).ok || !b.contentType) return null;
  return generateContentSchema.parse({
    type: b.contentType.key,
    ...(b.channel?.platform ? { platform: b.channel.platform } : {}),
    source: { kind: 'BRIEF', brief: briefText(b) },
    recommendationId: b.recommendation.id,
  });
}
