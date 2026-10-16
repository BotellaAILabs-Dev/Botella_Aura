import {
  AURA_MODULES,
  CREATION_KIND,
  moduleHref,
  routeRecommendation,
  type AuraModuleId,
  type CreationKind,
  type RoutableRecommendation,
} from '@/lib/aura-modules';
import { plainBlocker, plainWhy } from '@/lib/aura-suggests';
import type { ContextHandoff } from '@/lib/recommendation-context-handoff';
import { LOW_CONFIDENCE_BLOCKER } from '@/lib/recommendation-rules';
import {
  ACCEPTED_RECOMMENDATION_STATUSES,
  OPEN_RECOMMENDATION_STATUSES,
  type RecommendationStatus,
} from '@/lib/recommendations';

/**
 * RECOMMENDATION → CREATION.
 *
 * When a person says yes to a recommendation, Aura already knows what is to be
 * made and why. This decides, for any recommendation, what "Create" means and
 * whether it can happen now — one answer used by Aura Suggests, Content
 * Studio, the other creation workflows and the API, so they never disagree.
 *
 * What gets created, by where the recommendation is carried out
 * (CREATION_KIND in lib/aura-modules.ts, routed by the engine's action):
 *
 *   content    post · article · response-post · comparison-article ·
 *              targeted-post · recovery-post  (types CONTENT,
 *              COMPETITIVE_RESPONSE, AUDIENCE)        → a draft in Content Studio
 *   workflow   series (type CAMPAIGN)                  → a campaign plan
 *              apply-pattern · plan-it (OPTIMIZATION, OTHER) → a month's content plan
 *              outreach, where the suggestion is aimed at people (targeted-post,
 *              AUDIENCE: related)                       → outreach drafts for chosen leads
 *   action     connect-channel (CHANNEL) · update-audience → nothing to create:
 *              the suggestion is done in Connections / About my business
 *
 * Whether it can happen now (`state`):
 *
 *   ready          said yes (accepted, edited or in progress), nothing in the way
 *   accept_first   still open: creating from it also says yes to it
 *   needs_info     something required is missing — what, and where to add it
 *   not_creatable  an `action` suggestion: no content; the button goes where
 *                  it IS done
 *   closed         skipped, turned down, withdrawn, expired or done
 *
 * Pure and client-safe.
 */

export type CreationState =
  'ready' | 'accept_first' | 'needs_info' | 'not_creatable' | 'closed';

export interface CreationPlan {
  recommendationId: string;
  kind: CreationKind;
  /** Where it is carried out. */
  module: AuraModuleId;
  moduleLabel: string;
  /** The button: "Create content", "Plan the campaign", "Connect LinkedIn". */
  label: string;
  /** Into that workflow, carrying `?rec=` (and its prefill). */
  href: string;
  /** "a content draft", "a campaign plan", … — null for an action. */
  creates: string | null;
  state: CreationState;
  /** Can a person start creating from it now (saying yes on the way if needed)? */
  canCreate: boolean;
  /** Creating says yes to it first. */
  acceptsOnCreate: boolean;
  /** Why it cannot, or what creating will do — in plain words. Null when ready. */
  message: string | null;
  /** Where to fix what is in the way, or go instead. */
  fix: { label: string; href: string } | null;
}

export interface CreatableRecommendation extends RoutableRecommendation {
  status: RecommendationStatus;
  blockers: string[];
}

/** What a workflow other than the primary one creates, when used from it. */
const CREATES: Record<AuraModuleId, string | null> = {
  'content-studio': 'a content draft',
  campaigns: 'a campaign plan',
  'content-plan': 'a month’s content plan',
  outreach: 'outreach drafts',
  analytics: null,
  memory: null,
  competitors: null,
  'lead-discovery': null,
  connectors: null,
  'business-profile': null,
};

const CLOSED_WORDS: Partial<Record<RecommendationStatus, string>> = {
  SKIPPED: 'You skipped this suggestion',
  REJECTED: 'You turned this suggestion down',
  WITHDRAWN: 'This suggestion was withdrawn',
  EXPIRED: 'This suggestion has expired',
  COMPLETED: 'This suggestion is already done',
};

const SUGGESTIONS = {
  label: 'See Aura Suggests',
  href: '/dashboard/suggestions',
};

/**
 * What creating from `r` means, and whether it can happen now.
 *
 * `module` asks about one workflow in particular (Content Studio opened from
 * a "related" link, say); by default it is where the recommendation is
 * carried out. A workflow that creates can always be used — writing one piece
 * of a planned series is real work — but an action suggestion has nothing to
 * write, whichever page it is opened in.
 *
 * `handoff` adds what the Context Handoff found missing; a required gap
 * (what the business does) stops creation until it is added.
 */
export function creationPlan(
  r: CreatableRecommendation,
  options: {
    module?: AuraModuleId;
    handoff?: Pick<ContextHandoff, 'missing'> | null;
  } = {},
): CreationPlan {
  const route = routeRecommendation(r);
  const primary = route.primary;
  const target = options.module ?? primary.module;
  const kind = CREATION_KIND[target];
  const primaryKind = CREATION_KIND[primary.module];
  const isPrimary = target === primary.module;

  const base = {
    recommendationId: r.id,
    kind: primaryKind === 'action' ? 'action' : kind,
    module: target,
    moduleLabel: AURA_MODULES[target].label,
    label: isPrimary ? primary.verb : `Open ${AURA_MODULES[target].label}`,
    href: isPrimary ? primary.href : moduleHref(target, r),
    creates: primaryKind === 'action' ? null : CREATES[target],
  } satisfies Partial<CreationPlan>;
  const plan = (
    state: CreationState,
    message: string | null,
    fix: CreationPlan['fix'],
  ): CreationPlan => ({
    ...base,
    state,
    canCreate: state === 'ready' || state === 'accept_first',
    acceptsOnCreate: state === 'accept_first',
    message,
    fix,
  });

  const closed = CLOSED_WORDS[r.status];
  if (closed) {
    return plan(
      'closed',
      r.status === 'COMPLETED'
        ? `${closed} — there is nothing left to create from it.`
        : `${closed}, so there is nothing to create from it.`,
      SUGGESTIONS,
    );
  }

  // Nothing to write: say where it IS done, with the button to go there.
  if (primaryKind === 'action' || kind === 'action') {
    return plan(
      'not_creatable',
      primaryKind === 'action'
        ? `This suggestion doesn’t need new content — it’s done in ${primary.label}.`
        : `This suggestion is carried out in ${primary.label}, not ${AURA_MODULES[target].label}.`,
      { label: primary.verb, href: primary.href },
    );
  }

  // Outreach is personal messages to particular people: only a suggestion
  // carried out (or related to work) there is eligible — not every post.
  if (
    target === 'outreach' &&
    primary.module !== 'outreach' &&
    !route.related.some((d) => d.module === 'outreach')
  ) {
    return plan(
      'not_creatable',
      'This suggestion isn’t aimed at particular people, so there is no outreach to draft from it.',
      { label: primary.verb, href: primary.href },
    );
  }

  // Required information first: without what the business does, nothing
  // written for it can be specific.
  const required = (options.handoff?.missing ?? []).find(
    (m) => m.level === 'required',
  );
  if (required) {
    return plan('needs_info', required.behaviour, required.fix ?? null);
  }
  // A channel the business does not use, an integration Aura lacks: fixed by
  // editing the suggestion. (Low confidence is not in the way — saying yes is
  // the review it needs.)
  const blocker = r.blockers.find((b) => b !== LOW_CONFIDENCE_BLOCKER);
  if (blocker) {
    return plan('needs_info', plainBlocker(blocker), {
      label: 'Edit the suggestion',
      href: '/dashboard/suggestions',
    });
  }

  if (OPEN_RECOMMENDATION_STATUSES.includes(r.status)) {
    return plan(
      'accept_first',
      'Creating from this suggestion also says yes to it.',
      null,
    );
  }
  if (
    ACCEPTED_RECOMMENDATION_STATUSES.includes(r.status) ||
    r.status === 'IN_PROGRESS'
  ) {
    return plan('ready', null, null);
  }
  return plan(
    'closed',
    'There is nothing to create from this suggestion.',
    SUGGESTIONS,
  );
}

// ---------------------------------------------------------------------------
// Prefill for the other creation workflows
// ---------------------------------------------------------------------------

/** The Content plan's channels (lib/validations/planner.ts), kept here to stay client-safe. */
const PLAN_CHANNELS = [
  'LinkedIn',
  'Blog',
  'Newsletter',
  'X',
  'Instagram',
  'YouTube',
];

/**
 * A month's content plan brief, from what the recommendation already knows —
 * so planning it asks for nothing Aura has. Fields Aura does not have are
 * left out, so the person's own (or the workspace's) values stay.
 */
export function planBriefFrom(h: ContextHandoff): {
  businessGoals: string;
  campaignObjectives: string;
  topics: string[];
  audience?: string;
  channels?: string[];
} {
  const goal = h.goal?.value ?? '';
  return {
    // The plan needs a sentence of goal; the suggestion's own reason is one.
    businessGoals: (goal.length >= 10
      ? goal
      : `${h.action.title}. ${plainWhy(h.reason.why)}`
    ).slice(0, 1500),
    campaignObjectives: h.expectedOutcome.outcome.slice(0, 1500),
    topics: [(h.action.angle ?? h.action.title).slice(0, 80)],
    ...(h.audience ? { audience: h.audience.value.slice(0, 400) } : {}),
    ...(h.channel?.channel && PLAN_CHANNELS.includes(h.channel.channel)
      ? { channels: [h.channel.channel] }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// What a created piece remembers
// ---------------------------------------------------------------------------

/**
 * The recommendation's context, kept on whatever is created from it.
 *
 * Taken from the Context Handoff on the server — not from the editable brief —
 * so it survives the person rewriting the brief, and the draft can always say
 * which suggestion it came from, which opportunity, why, and on what evidence.
 */
export interface CreationProvenance {
  recommendationId: string;
  opportunityId: string;
  title: string;
  type: string;
  why: string;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  evidence: { label: string; url: string | null }[];
  expectedOutcome: string;
  goal: string | null;
  audience: string | null;
  channel: string | null;
  business: { name: string; description: string | null };
  /** Handoff version, readiness and what it could not provide. */
  handoff: { version: number; readiness: string; missing: string[] };
  createdAt: string;
}

export function creationProvenance(
  h: ContextHandoff,
  now: Date = new Date(),
): CreationProvenance {
  return {
    recommendationId: h.recommendationId,
    opportunityId: h.opportunityId,
    title: h.action.title,
    type: h.type,
    why: plainWhy(h.reason.why) || h.reason.why,
    confidence: h.reason.confidence,
    evidence: h.evidence
      .slice(0, 6)
      .map((e) => ({ label: e.label, url: e.url })),
    expectedOutcome: h.expectedOutcome.outcome,
    goal: h.goal?.value ?? null,
    audience: h.audience?.value ?? null,
    channel: h.channel?.channel ?? null,
    business: { name: h.business.name, description: h.business.description },
    handoff: {
      version: h.version,
      readiness: h.readiness,
      missing: h.missing.map((m) => m.field),
    },
    createdAt: now.toISOString(),
  };
}

/**
 * The part of the writer's prompt that carries the recommendation, built from
 * the provenance (so from the server's record, not the editable brief). The
 * brief still decides the angle and wording; this makes sure the reason, the
 * evidence and the outcome reach the writer even if the brief was cut down.
 */
export function provenancePrompt(p: CreationProvenance): string {
  return [
    `WRITTEN FOR AURA'S SUGGESTION: "${p.title}"`,
    `Why: ${p.why}`,
    p.evidence.length
      ? `Evidence (cite only this; invent nothing beyond it): ${p.evidence
          .map((e) => e.label)
          .join('; ')}`
      : 'Evidence: none recorded — make no factual claims beyond the brief and company knowledge.',
    `Expected outcome: ${p.expectedOutcome}`,
    p.goal ? `Business goal it serves: ${p.goal}` : '',
    p.audience ? `For: ${p.audience}` : '',
    'Where the brief above differs on angle or wording, follow the brief.',
  ]
    .filter(Boolean)
    .join('\n');
}
