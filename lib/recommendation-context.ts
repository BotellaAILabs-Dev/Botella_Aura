import {
  AURA_MODULES,
  moduleHandoff,
  routeRecommendation,
  type AuraModuleId,
  type ModuleHandoffs,
  type RoutableRecommendation,
} from '@/lib/aura-modules';
import { plainWhy } from '@/lib/aura-suggests';

/**
 * A recommendation as it travels with a person between Aura's modules: what
 * it is, why, what it should achieve, which module carries it out, which
 * others help, and what each of those modules receives (lib/aura-modules.ts).
 *
 * The context bar shows it on every module page the person visits while
 * working on the recommendation; a module that creates something (Content
 * Studio, Campaigns) uses its hand-off to fill in its form and remembers the
 * recommendation on what it creates. Pure and client-safe.
 */
export interface RecommendationContext {
  id: string;
  title: string;
  action: string;
  why: string;
  expectedOutcome: string;
  status: string;
  /** Still something to act on (not skipped, rejected, expired …). */
  actionable: boolean;
  channel: string | null;
  audience: string | null;
  /** The first few pieces of evidence, by label. */
  evidence: string[];
  /** Where it is carried out, and where else helps. */
  primary: ContextDestination;
  related: ContextDestination[];
  /** Back to the suggestion itself. */
  backHref: string;
}

export interface ContextDestination {
  module: AuraModuleId;
  label: string;
  verb: string;
  href: string;
  /** What to do in this module for this recommendation, in a line. */
  hint: string;
  handoff: ModuleHandoffs[AuraModuleId];
}

const ACTIONABLE = [
  'GENERATED',
  'PRESENTED',
  'ACCEPTED',
  'EDITED',
  'IN_PROGRESS',
];

/** What to do in a module for this recommendation — from its hand-off, never invented. */
export function moduleHint(
  module: AuraModuleId,
  r: RoutableRecommendation,
  isPrimary: boolean,
): string {
  const h = moduleHandoff(module, r) as Record<string, unknown>;
  const s = (k: string) =>
    typeof h[k] === 'string' && h[k] ? (h[k] as string) : null;
  switch (module) {
    case 'content-studio':
      return isPrimary
        ? 'The brief below is filled in from the suggestion — edit it, then generate.'
        : 'Write the piece this suggestion calls for.';
    case 'campaigns':
      return isPrimary
        ? 'The campaign is filled in from the suggestion — check it, then plan.'
        : 'Plan this as a campaign if it needs more than one piece.';
    case 'competitors':
      return s('competitor')
        ? `Look at what ${s('competitor')} changed before you respond.`
        : 'Look at what your competitors changed before you respond.';
    case 'lead-discovery':
      return s('audience')
        ? `Find people who match: ${s('audience')}.`
        : 'Find people this suggestion is aimed at.';
    case 'outreach':
      return s('audience')
        ? `Reach out to ${s('audience')} directly.`
        : 'Reach out to the people this is for.';
    case 'analytics':
      return s('metric')
        ? `Watch ${s('metric')} — this suggestion is meant to move it.`
        : 'Check the results this suggestion is meant to move.';
    case 'memory':
      return 'See what has worked for you before, and build on it.';
    case 'content-plan':
      return 'Add it to your content plan.';
    case 'connectors':
      return s('channel')
        ? `Connect ${s('channel')}.`
        : 'Connect the channel this suggestion needs.';
    case 'business-profile':
      return s('audience')
        ? `Add “${s('audience')}” to your business profile.`
        : 'Update your business profile.';
  }
}

export function toRecommendationContext(
  r: RoutableRecommendation & {
    status: string;
    evidence: { label: string }[];
  },
): RecommendationContext {
  const route = routeRecommendation(r);
  const dest = (
    d: (typeof route)['primary'],
    isPrimary: boolean,
  ): ContextDestination => ({
    module: d.module,
    label: d.label,
    verb: d.verb,
    href: d.href,
    hint: moduleHint(d.module, r, isPrimary),
    handoff: moduleHandoff(d.module, r),
  });
  return {
    id: r.id,
    title: r.title,
    action: r.action,
    why: plainWhy(r.rationale),
    expectedOutcome: r.expectedOutcome,
    status: r.status,
    actionable: ACTIONABLE.includes(r.status),
    channel: r.channel,
    audience: r.audience,
    evidence: r.evidence.slice(0, 3).map((e) => e.label),
    primary: dest(route.primary, true),
    related: route.related.map((d) => dest(d, false)),
    backHref: '/dashboard/suggestions',
  };
}

/** The label of the module a path belongs to, for "You’re in …". */
export function moduleLabel(id: AuraModuleId): string {
  return AURA_MODULES[id].label;
}
