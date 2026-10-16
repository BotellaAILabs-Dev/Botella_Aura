import type { AuraModuleId } from '@/lib/aura-modules';
import {
  creationProvenance,
  provenancePrompt,
  type CreationProvenance,
} from '@/lib/recommendation-creation';
import type {
  ContextHandoff,
  HandoffField,
  ValueSource,
} from '@/lib/recommendation-context-handoff';
import { MISSING_FIELD_POLICY } from '@/lib/recommendation-context-handoff';
import type { ContentTypeKey } from '@/lib/validations/content';

/**
 * CAMPAIGN & OUTREACH CREATION HANDOFFS — the contextual creation model
 * (Content Studio's, lib/recommendation-creation.ts) extended to the two other
 * workflows that create from a recommendation.
 *
 * Both are built from the same Context Handoff (lib/recommendation-context-
 * handoff.ts), so they map the same things the same way:
 *
 *   recommendation context   who/what/why — the provenance every created item
 *                            keeps (creationProvenance)
 *   audience                 who it is for            (with where it came from)
 *   goal                     the business goal it serves, and the expected outcome
 *   CTA                      whether one is expected, how it is written, and
 *                            where it sends people — never an invented URL
 *   channel                  where it runs (network, format, Aura or by hand)
 *   content requirements     what each workflow must produce to honour it
 *
 * What it produces, per workflow:
 *
 *   prefill    the workflow's own creation form, filled in and editable
 *   context    the CreationContext stored on what is created (the campaign;
 *              each outreach message), read by the planner / drafter now and
 *              by Sprint 10's execution later
 *
 * Nothing is invented: a value Aura does not have stays null and is listed in
 * `gaps` with what that means (MISSING_FIELD_POLICY). Execution of anything
 * created this way is held by lib/execution-gate.ts. Pure and client-safe.
 */

export const CREATION_HANDOFF_VERSION = 1 as const;

export type CreationTarget = Extract<AuraModuleId, 'campaigns' | 'outreach'>;

interface Sourced {
  value: string;
  source: ValueSource;
}

export interface CampaignRequirements {
  /** Formats the recommendation names (the planner may add others around them). */
  contentTypes: ContentTypeKey[];
  /** The network the content is for, when the recommendation names one. */
  platform: string | null;
  /** The angle and key message every piece in the campaign carries. */
  keyMessage: string;
  angle: string | null;
  /** The recommendation's own steps — the shape of the campaign. */
  steps: string[];
  /** Modules to include, from where the recommendation is carried out. */
  modules: { content: boolean; outreach: boolean; discovery: boolean; engagement: boolean };
  /** Claims may cite only this evidence. */
  evidence: string[];
  /** Write in the brand voice (when there is one). */
  brandVoice: string | null;
}

export interface OutreachRequirements {
  /** Outreach is a LinkedIn connection note, then a follow-up once accepted. */
  channel: 'LinkedIn';
  messageTypes: ('CONNECTION_NOTE' | 'FOLLOWUP')[];
  /** LinkedIn's limit for a connection note. */
  connectionNoteLimit: 300;
  keyMessage: string;
  angle: string | null;
  /** Each message is about the person: their own signal, not a broadcast. */
  personalisation: string;
  evidence: string[];
  brandVoice: string | null;
}

export interface CreationContext {
  version: typeof CREATION_HANDOFF_VERSION;
  target: CreationTarget;
  /** The recommendation context: which suggestion, why, on what evidence. */
  recommendation: CreationProvenance;
  audience: Sourced | null;
  goal: Sourced | null;
  outcome: { outcome: string; metric: string | null };
  cta: {
    expected: boolean;
    /** How the call to action is written here. */
    guidance: string;
    /** Where it sends people: the business's own site, or null — never made up. */
    destination: Sourced | null;
  };
  channel: {
    channel: string | null;
    contentType: ContentTypeKey | null;
    platform: string | null;
    publishing: 'aura' | 'manual' | null;
  } | null;
  requirements: CampaignRequirements | OutreachRequirements;
  /** What Aura does not have, and what the workflow does without it. */
  gaps: { field: HandoffField; behaviour: string }[];
  /** Created under the execution gate (lib/execution-gate.ts). */
  executionGate: 'sprint-10';
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const GAP_FIELDS: HandoffField[] = ['goal', 'audience', 'channel', 'cta', 'evidence', 'brandVoice'];

function gapsOf(h: ContextHandoff): CreationContext['gaps'] {
  return h.missing
    .filter((m) => GAP_FIELDS.includes(m.field))
    .map((m) => ({ field: m.field, behaviour: m.behaviour || MISSING_FIELD_POLICY[m.field].behaviour }));
}

const voiceOf = (h: ContextHandoff) =>
  h.brandVoice?.summary ??
  (h.brandVoice?.tone.length ? `Tone: ${h.brandVoice.tone.join(', ')}` : null);

const evidenceOf = (h: ContextHandoff) => h.evidence.slice(0, 6).map((e) => e.label);

/** The CTA for a campaign: the recommendation's own rule, or a plain default. */
function campaignCta(h: ContextHandoff): CreationContext['cta'] {
  return {
    expected: h.cta.expected,
    guidance:
      h.cta.guidance ??
      (h.cta.expected
        ? 'Each piece ends with one clear next step toward the campaign goal.'
        : 'No call to action is expected for this format.'),
    destination: h.cta.destination,
  };
}

/** Outreach CTAs are always soft, and a link never goes in a connection note. */
function outreachCta(h: ContextHandoff): CreationContext['cta'] {
  return {
    expected: true,
    guidance:
      'Invite a conversation, never a hard sell. The connection note carries no link; the follow-up may offer one next step' +
      (h.cta.destination ? ' (and may point to the business’s own site).' : ' — with no URL, since none is recorded.'),
    destination: h.cta.destination,
  };
}

function base(h: ContextHandoff, target: CreationTarget, now: Date) {
  return {
    version: CREATION_HANDOFF_VERSION,
    target,
    recommendation: creationProvenance(h, now),
    audience: h.audience,
    goal: h.goal,
    outcome: { outcome: h.expectedOutcome.outcome, metric: h.expectedOutcome.metric },
    channel: h.channel
      ? {
          channel: h.channel.channel,
          contentType: h.channel.contentType,
          platform: h.channel.platform,
          publishing: h.channel.publishing,
        }
      : null,
    gaps: gapsOf(h),
    executionGate: 'sprint-10' as const,
    createdAt: now.toISOString(),
  };
}

export interface CampaignCreationHandoff {
  /** The campaign form, filled in (lib/validations/campaign.ts). */
  prefill: {
    name: string;
    goal: string;
    targetAudience: string;
    themes: string[];
    durationDays: number;
    modules: CampaignRequirements['modules'];
  };
  context: CreationContext;
}

/**
 * A campaign planned from a recommendation. `related` = the modules the
 * recommendation is also carried out in (routeRecommendation), which decide
 * whether outreach and lead discovery belong in the campaign.
 */
export function campaignCreationHandoff(
  h: ContextHandoff,
  options: { related?: AuraModuleId[]; now?: Date } = {},
): CampaignCreationHandoff {
  const now = options.now ?? new Date();
  const related = options.related ?? [];
  const audienceLed = related.includes('outreach') || related.includes('lead-discovery') || h.type === 'AUDIENCE';
  const requirements: CampaignRequirements = {
    contentTypes: h.channel?.contentType ? [h.channel.contentType] : [],
    platform: h.channel?.platform ?? null,
    keyMessage: h.action.title,
    angle: h.action.angle,
    steps: h.action.steps.slice(0, 8),
    modules: { content: true, outreach: audienceLed, discovery: audienceLed, engagement: false },
    evidence: evidenceOf(h),
    brandVoice: voiceOf(h),
  };
  const goalLine = [h.goal?.value, h.expectedOutcome.outcome].filter(Boolean).join(' — ');
  return {
    prefill: {
      name: h.action.title.slice(0, 120),
      goal: (goalLine || `${h.action.action} ${h.expectedOutcome.outcome}`).slice(0, 2000),
      targetAudience: (h.audience?.value ?? '').slice(0, 1000),
      themes: [h.action.angle, h.action.title]
        .filter((x): x is string => Boolean(x))
        .map((x) => x.slice(0, 80))
        .slice(0, 3),
      durationDays: 30,
      modules: requirements.modules,
    },
    context: { ...base(h, 'campaigns', now), cta: campaignCta(h), requirements },
  };
}

export interface OutreachCreationHandoff {
  /** What the outreach creation page shows and drafts from. */
  prefill: {
    audience: string | null;
    angle: string | null;
    keyMessage: string;
    goal: string | null;
  };
  context: CreationContext;
}

export function outreachCreationHandoff(
  h: ContextHandoff,
  options: { now?: Date } = {},
): OutreachCreationHandoff {
  const now = options.now ?? new Date();
  const requirements: OutreachRequirements = {
    channel: 'LinkedIn',
    messageTypes: ['CONNECTION_NOTE', 'FOLLOWUP'],
    connectionNoteLimit: 300,
    keyMessage: h.action.title,
    angle: h.action.angle,
    personalisation:
      'Open with the lead’s own recent signal; the suggestion decides the angle, not the opening line.',
    evidence: evidenceOf(h),
    brandVoice: voiceOf(h),
  };
  return {
    prefill: {
      audience: h.audience?.value ?? null,
      angle: h.action.angle,
      keyMessage: h.action.title,
      goal: h.goal?.value ?? h.expectedOutcome.outcome,
    },
    context: {
      ...base(h, 'outreach', now),
      // Outreach always runs on LinkedIn, whatever channel the suggestion named.
      channel: { channel: 'LinkedIn', contentType: null, platform: 'LINKEDIN', publishing: 'manual' },
      cta: outreachCta(h),
      requirements,
    },
  };
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

/** A stored creation context, if the value is one (older items have none). */
export function readCreationContext(value: unknown): CreationContext | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<CreationContext>;
  return v.version === CREATION_HANDOFF_VERSION &&
    (v.target === 'campaigns' || v.target === 'outreach') &&
    v.recommendation
    ? (v as CreationContext)
    : null;
}

/**
 * The part of a planner's or drafter's prompt that carries the creation
 * context: the recommendation (provenancePrompt), then the CTA, the channel
 * and the requirements. The person's own edits to the form still decide the
 * wording; this keeps the reason, evidence and rules in view.
 */
export function creationContextPrompt(ctx: CreationContext): string {
  const r = ctx.requirements;
  const lines = [
    provenancePrompt(ctx.recommendation),
    ctx.outcome.metric ? `Measured by: ${ctx.outcome.metric}` : '',
    `Call to action: ${ctx.cta.guidance}${ctx.cta.destination ? ` Destination: ${ctx.cta.destination.value}` : ' Never invent a URL.'}`,
    ctx.channel?.channel ? `Channel: ${ctx.channel.channel}${ctx.channel.contentType ? ` (${ctx.channel.contentType})` : ''}` : '',
    `Key message: ${r.keyMessage}${r.angle ? ` — angle: ${r.angle}` : ''}`,
    'steps' in r && r.steps.length ? `Shape: ${r.steps.join(' · ')}` : '',
    'contentTypes' in r && r.contentTypes.length ? `Formats the suggestion names: ${r.contentTypes.join(', ')}` : '',
    'personalisation' in r ? r.personalisation : '',
    r.brandVoice ? `Brand voice: ${r.brandVoice}` : '',
    ctx.gaps.length ? `Not known (do not fill in): ${ctx.gaps.map((g) => g.field).join(', ')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}
