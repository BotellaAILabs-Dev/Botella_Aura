import type { RecommendationType } from '@/lib/recommendations';

/**
 * Aura's modules, and how a recommendation reaches the right one.
 *
 *   AURA_MODULES        what each module can do, where a recommendation lands
 *                       in it, what context it accepts, and how far the
 *                       hand-off goes today
 *   routeRecommendation which module carries a recommendation out (and which
 *                       others are related), by the action the engine chose,
 *                       falling back to the recommendation's type
 *   moduleHandoff       the typed data a module receives — what a creation /
 *                       execution workflow will consume when it is built
 *
 * Every destination carries `?rec=<id>`, so the module (and the context bar
 * that follows the person between modules) knows which recommendation they
 * are working on. Pure and client-safe.
 */

export const AURA_MODULE_IDS = [
  'content-studio',
  'campaigns',
  'outreach',
  'analytics',
  'memory',
  'competitors',
  'lead-discovery',
  'content-plan',
  'connectors',
  'business-profile',
] as const;
export type AuraModuleId = (typeof AURA_MODULE_IDS)[number];

/** What a module can take from a recommendation. */
export type ContextField =
  | 'brief'
  | 'channel'
  | 'contentType'
  | 'audience'
  | 'goal'
  | 'themes'
  | 'competitor'
  | 'metric'
  | 'pattern';

export interface AuraModule {
  id: AuraModuleId;
  label: string;
  /** What it does for the business, in a line. */
  description: string;
  /** The module's home. */
  route: string;
  /** Where a recommendation lands: a creation form when there is one. */
  entryRoute: string;
  /** What the module can do today. */
  capabilities: string[];
  /** Context it can use from a recommendation. */
  accepts: ContextField[];
  /**
   * How far the hand-off goes today:
   *   prefill — the module's creation form opens filled in from the
   *             recommendation, and what it creates remembers it
   *   context — the module opens with the recommendation in view (the
   *             context bar); the person carries it out there
   */
  handoff: 'prefill' | 'context';
  /** What it creates, when it creates something. */
  creates: string | null;
}

export const AURA_MODULES: Record<AuraModuleId, AuraModule> = {
  'content-studio': {
    id: 'content-studio',
    label: 'Content Studio',
    description:
      'Write posts, threads, articles, emails and ads in your voice.',
    route: '/dashboard/content',
    entryRoute: '/dashboard/content/new',
    capabilities: [
      'Write a post, carousel, thread, article, email or ad',
      'Write for a specific platform and audience',
      'Rewrite, shorten, change tone, make a graphic',
    ],
    accepts: ['brief', 'channel', 'contentType', 'audience'],
    handoff: 'prefill',
    creates: 'a content draft',
  },
  campaigns: {
    id: 'campaigns',
    label: 'Campaigns',
    description: 'Turn one goal into a dated, multi-week plan.',
    route: '/dashboard/campaigns',
    entryRoute: '/dashboard/campaigns/new',
    capabilities: [
      'Plan a campaign around one goal',
      'Schedule content, outreach and lead discovery together',
    ],
    accepts: ['goal', 'audience', 'themes'],
    handoff: 'prefill',
    creates: 'a campaign plan',
  },
  outreach: {
    id: 'outreach',
    label: 'Outreach',
    description: 'Personal messages to the people worth contacting.',
    route: '/dashboard/outreach',
    // Drafting outreach for chosen leads from a recommendation
    // (lib/creation-handoff.ts); sending waits for execution (lib/execution-gate.ts).
    entryRoute: '/dashboard/outreach/new',
    capabilities: ['Draft personal outreach to leads', 'Track replies'],
    accepts: ['audience', 'brief', 'goal'],
    handoff: 'prefill',
    creates: 'outreach drafts',
  },
  analytics: {
    id: 'analytics',
    label: 'Results',
    description: 'What your marketing achieved, and what changed.',
    route: '/dashboard/analytics',
    entryRoute: '/dashboard/analytics',
    capabilities: ['See results over time', 'Compare channels and formats'],
    accepts: ['metric'],
    handoff: 'context',
    creates: null,
  },
  memory: {
    id: 'memory',
    label: 'What works for you',
    description: 'Patterns Aura has learned from your results.',
    route: '/dashboard/memory',
    entryRoute: '/dashboard/memory',
    capabilities: ['See what has worked before', 'Apply a learned pattern'],
    accepts: ['pattern'],
    handoff: 'context',
    creates: null,
  },
  competitors: {
    id: 'competitors',
    label: 'Competitors',
    description: 'What your competitors are changing.',
    route: '/dashboard/competitors',
    entryRoute: '/dashboard/competitors',
    capabilities: ['See a competitor’s recent changes', 'Compare positioning'],
    accepts: ['competitor'],
    handoff: 'context',
    creates: null,
  },
  'lead-discovery': {
    id: 'lead-discovery',
    label: 'Lead discovery',
    description: 'Find people who match who you sell to.',
    route: '/dashboard/leads',
    entryRoute: '/dashboard/leads/discover',
    capabilities: [
      'Find people matching an audience',
      'Score them against who you sell to',
    ],
    accepts: ['audience'],
    handoff: 'context',
    creates: null,
  },
  'content-plan': {
    id: 'content-plan',
    label: 'Content plan',
    description: 'A month of dated, ready-to-write posts.',
    route: '/dashboard/planner',
    entryRoute: '/dashboard/planner',
    capabilities: ['Plan a month of content around your goals'],
    accepts: ['brief', 'themes'],
    handoff: 'context',
    creates: null,
  },
  connectors: {
    id: 'connectors',
    label: 'Connections',
    description: 'Connect the channels Aura publishes to and measures.',
    route: '/dashboard/connectors',
    entryRoute: '/dashboard/connectors',
    capabilities: ['Connect a channel so Aura can publish and measure it'],
    accepts: ['channel'],
    handoff: 'context',
    creates: null,
  },
  'business-profile': {
    id: 'business-profile',
    label: 'About my business',
    description: 'What Aura knows about your business.',
    route: '/dashboard/business',
    entryRoute: '/dashboard/business',
    capabilities: ['Add an audience, goal or channel'],
    accepts: ['audience', 'goal'],
    handoff: 'context',
    creates: null,
  },
};

/**
 * What carrying a recommendation out in each module amounts to:
 *
 *   content   it creates content — Content Studio writes the piece
 *   workflow  it creates through another Aura workflow — a campaign plan, a
 *             month's content plan — which may then produce content
 *   action    nothing is created — connect a channel, add an audience, look
 *             at results or a competitor
 *
 * lib/recommendation-creation.ts turns this into what a person can do.
 */
export type CreationKind = 'content' | 'workflow' | 'action';

export const CREATION_KIND: Record<AuraModuleId, CreationKind> = {
  'content-studio': 'content',
  campaigns: 'workflow',
  'content-plan': 'workflow',
  // Outreach drafts for chosen leads (lib/creation-handoff.ts).
  outreach: 'workflow',
  analytics: 'action',
  memory: 'action',
  competitors: 'action',
  'lead-discovery': 'action',
  connectors: 'action',
  'business-profile': 'action',
};

// ---------------------------------------------------------------------------
// Which module carries a recommendation out
// ---------------------------------------------------------------------------

interface Route {
  primary: AuraModuleId;
  /** What the person does there, as a button. */
  verb: string;
  related: AuraModuleId[];
}

/** By the action the engine chose (lib/recommendation-engine.ts). */
export const ROUTE_BY_ACTION: Record<string, Route> = {
  post: { primary: 'content-studio', verb: 'Create content', related: [] },
  article: {
    primary: 'content-studio',
    verb: 'Write the article',
    related: [],
  },
  series: {
    primary: 'campaigns',
    verb: 'Plan the series',
    related: ['content-studio'],
  },
  'response-post': {
    primary: 'content-studio',
    verb: 'Create content',
    related: ['competitors'],
  },
  'comparison-article': {
    primary: 'content-studio',
    verb: 'Write the comparison',
    related: ['competitors'],
  },
  'targeted-post': {
    primary: 'content-studio',
    verb: 'Create content',
    related: ['lead-discovery', 'outreach'],
  },
  'update-audience': {
    primary: 'business-profile',
    verb: 'Add the audience',
    related: ['lead-discovery'],
  },
  'connect-channel': { primary: 'connectors', verb: 'Connect', related: [] },
  'recovery-post': {
    primary: 'content-studio',
    verb: 'Create content',
    related: ['analytics', 'memory'],
  },
  'apply-pattern': {
    primary: 'content-plan',
    verb: 'Add to your plan',
    related: ['memory', 'campaigns'],
  },
  'plan-it': { primary: 'content-plan', verb: 'Add to your plan', related: [] },
};

/** When the engine's action is not known (older or hand-made recommendations). */
export const ROUTE_BY_TYPE: Record<RecommendationType, Route> = {
  CONTENT: { primary: 'content-studio', verb: 'Create content', related: [] },
  CAMPAIGN: {
    primary: 'campaigns',
    verb: 'Plan the campaign',
    related: ['content-studio'],
  },
  COMPETITIVE_RESPONSE: {
    primary: 'content-studio',
    verb: 'Create content',
    related: ['competitors'],
  },
  AUDIENCE: {
    primary: 'content-studio',
    verb: 'Create content',
    related: ['lead-discovery', 'outreach'],
  },
  CHANNEL: { primary: 'connectors', verb: 'Connect', related: [] },
  OPTIMIZATION: {
    primary: 'content-plan',
    verb: 'Add to your plan',
    related: ['analytics', 'memory'],
  },
  OTHER: { primary: 'content-plan', verb: 'Add to your plan', related: [] },
};

export interface RoutableRecommendation {
  id: string;
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
}

export interface ModuleDestination {
  module: AuraModuleId;
  label: string;
  /** The button: "Create content", "Connect Instagram", "Open Competitors". */
  verb: string;
  href: string;
  handoff: AuraModule['handoff'];
}

export interface RecommendationRoute {
  primary: ModuleDestination;
  related: ModuleDestination[];
}

function detail(details: unknown, key: string): unknown {
  return details && typeof details === 'object'
    ? (details as Record<string, unknown>)[key]
    : undefined;
}

/** The engine's chosen action, when recorded. */
export function actionOf(r: { details: unknown }): string | null {
  const a = detail(r.details, 'action');
  return typeof a === 'string' ? a : null;
}

export function routeFor(r: {
  type: RecommendationType;
  details: unknown;
}): Route {
  const a = actionOf(r);
  return (a && ROUTE_BY_ACTION[a]) || ROUTE_BY_TYPE[r.type];
}

/** The link into a module, carrying the recommendation (and prefill when the module takes it). */
export function moduleHref(
  module: AuraModuleId,
  r: RoutableRecommendation,
): string {
  const m = AURA_MODULES[module];
  const q = new URLSearchParams({ rec: r.id });
  if (module === 'content-studio') {
    const h = moduleHandoff('content-studio', r);
    q.set('brief', h.brief.slice(0, 1500));
    if (h.contentType) q.set('type', h.contentType);
  }
  return `${m.entryRoute}?${q.toString()}`;
}

export function routeRecommendation(
  r: RoutableRecommendation,
): RecommendationRoute {
  const route = routeFor(r);
  const dest = (module: AuraModuleId, verb: string): ModuleDestination => ({
    module,
    label: AURA_MODULES[module].label,
    verb,
    href: moduleHref(module, r),
    handoff: AURA_MODULES[module].handoff,
  });
  const primaryVerb =
    route.primary === 'connectors' && r.channel
      ? `Connect ${r.channel}`
      : route.verb;
  return {
    primary: dest(route.primary, primaryVerb),
    related: route.related
      .filter((m) => m !== route.primary)
      .map((m) => dest(m, `Open ${AURA_MODULES[m].label}`)),
  };
}

// ---------------------------------------------------------------------------
// What each module receives — the contract for creation/execution workflows
// ---------------------------------------------------------------------------

export interface ModuleHandoffs {
  'content-studio': {
    brief: string;
    contentType: string | null;
    channel: string | null;
    audience: string | null;
  };
  campaigns: {
    name: string;
    goal: string;
    targetAudience: string | null;
    themes: string[];
  };
  outreach: { audience: string | null; angle: string | null };
  analytics: { metric: string | null };
  memory: { pattern: string | null };
  competitors: { competitor: string | null };
  'lead-discovery': { audience: string | null };
  'content-plan': { brief: string; themes: string[] };
  connectors: { channel: string | null };
  'business-profile': { audience: string | null };
}

/** The brief a writer (or a person) works from — everything the recommendation says. */
export function recommendationBrief(r: RoutableRecommendation): string {
  const angle = detail(r.details, 'angle');
  return [
    r.title,
    '',
    r.action,
    ...(r.steps.length ? ['', ...r.steps.map((s) => `- ${s}`)] : []),
    ...(typeof angle === 'string' && angle ? ['', `Angle: ${angle}`] : []),
    ...(r.audience ? ['', `For: ${r.audience}`] : []),
    '',
    `Why: ${r.rationale}`,
    `Goal: ${r.expectedOutcome}`,
  ].join('\n');
}

const str = (v: unknown) =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/** Words worth carrying as campaign themes: the topic, or the angle. */
function themesOf(r: RoutableRecommendation): string[] {
  return [str(detail(r.details, 'topic')), str(detail(r.details, 'angle'))]
    .filter((x): x is string => Boolean(x))
    .map((x) => x.slice(0, 80))
    .slice(0, 3);
}

export function moduleHandoff<M extends AuraModuleId>(
  module: M,
  r: RoutableRecommendation,
): ModuleHandoffs[M] {
  const out: { [K in AuraModuleId]: () => ModuleHandoffs[K] } = {
    'content-studio': () => ({
      brief: recommendationBrief(r),
      contentType: r.contentType,
      channel: r.channel,
      audience: r.audience,
    }),
    campaigns: () => ({
      name: r.title.slice(0, 120),
      goal: `${r.action} ${r.expectedOutcome}`.slice(0, 2000),
      targetAudience: r.audience,
      themes: themesOf(r),
    }),
    outreach: () => ({
      audience: r.audience,
      angle: str(detail(r.details, 'angle')),
    }),
    analytics: () => ({ metric: str(detail(r.details, 'metric')) }),
    memory: () => ({ pattern: str(detail(r.details, 'pattern')) }),
    competitors: () => ({ competitor: str(detail(r.details, 'competitor')) }),
    'lead-discovery': () => ({ audience: r.audience }),
    'content-plan': () => ({
      brief: recommendationBrief(r),
      themes: themesOf(r),
    }),
    connectors: () => ({ channel: r.channel }),
    'business-profile': () => ({ audience: r.audience }),
  };
  return out[module]() as ModuleHandoffs[M];
}

/** The module a dashboard path belongs to, if any. */
export function moduleForPath(pathname: string): AuraModuleId | null {
  const hit = AURA_MODULE_IDS.map((id) => AURA_MODULES[id])
    .filter(
      (m) =>
        pathname === m.route ||
        pathname.startsWith(`${m.route}/`) ||
        pathname === m.entryRoute,
    )
    .sort((a, b) => b.route.length - a.route.length)[0];
  return hit?.id ?? null;
}
