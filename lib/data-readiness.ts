/**
 * DATA READINESS — what Aura needs before it can recommend anything, and what
 * it says when it does not have it.
 *
 * Six scenarios, each either BLOCKING (no recommendation is made or shown —
 * anything Aura wrote would be generic or invented) or LIMITING (Aura can
 * still recommend, and says what it is missing):
 *
 *   business_context      what the business does (blocking); its audience
 *                         and goals (limiting)
 *   no_channels           where it publishes (blocking: every content
 *                         suggestion needs a channel, and Aura will not guess)
 *   insufficient_signals  nothing to watch, or nothing seen yet (blocking)
 *   no_opportunities      watching, but nothing worth acting on yet
 *                         (blocking — honestly empty, not padded)
 *   low_confidence        only early signs (limiting: shown as needs-review)
 *   no_connected_channel  nothing connected (limiting: Aura can suggest, not
 *                         publish or measure)
 *   no_performance_data   no results yet (limiting: Aura cannot learn what
 *                         works for this business)
 *
 * Every scenario has ONE next step, and missing business information links to
 * the exact question in the Business Context workflow
 * (`/dashboard/business?ask=<field>#aura-questions`).
 *
 * The FALLBACK: when anything blocks, Aura shows what it needs, in order —
 * never a generic recommendation to fill the page.
 *
 * Pure and client-safe; loaded by server/recommendations/readiness.service.ts.
 */

export const READINESS_SCENARIOS = [
  'business_context',
  'no_channels',
  'insufficient_signals',
  'no_opportunities',
  'low_confidence',
  'no_connected_channel',
  'no_performance_data',
] as const;
export type ReadinessScenario = (typeof READINESS_SCENARIOS)[number];

export interface ReadinessInput {
  business: {
    description: string | null;
    offerings: string | null;
    audience: string | null;
    goals: string | null;
    /** Where it says it publishes. */
    channels: string[];
    /** Where Aura can publish and measure. */
    connected: string[];
  };
  sources: {
    /** Topics Aura follows in the market. */
    trendKeywords: number;
    competitorsTracked: number;
  };
  /** Current signals from outside the business profile (trends, competitors, results, learnings). */
  currentSignals: number;
  opportunities: { active: number; lowConfidence: number };
  results: { analyticsReports: number; publishedPosts: number };
}

export interface NextStep {
  label: string;
  /** Somewhere to go… */
  href?: string;
  /** …or something Aura can do now. */
  action?: 'detect_opportunities';
}

export interface ReadinessItem {
  scenario: ReadinessScenario;
  severity: 'blocking' | 'limiting';
  title: string;
  message: string;
  next: NextStep | null;
}

export interface Readiness {
  /** ready: nothing missing · limited: can recommend, with gaps · blocked: cannot recommend yet. */
  state: 'ready' | 'limited' | 'blocked';
  /** Whether Aura may make or show recommendations at all. */
  canRecommend: boolean;
  /** Blocking first, then limiting — in the order to deal with them. */
  items: ReadinessItem[];
  /** The one thing to do first, when anything blocks. */
  primary: ReadinessItem | null;
}

const has = (v: string | null | undefined) => Boolean(v && v.trim());

/** The Business Context question for a field — the "missing information" workflow. */
export function askFor(field: string): string {
  return `/dashboard/business?ask=${encodeURIComponent(field)}#aura-questions`;
}

export function assessReadiness(input: ReadinessInput): Readiness {
  const { business: b, sources: src } = input;
  const items: ReadinessItem[] = [];

  // --- Business context ------------------------------------------------------
  if (!has(b.description) && !has(b.offerings)) {
    items.push({
      scenario: 'business_context',
      severity: 'blocking',
      title: 'Tell Aura what your business does',
      message:
        'Without knowing what you do or sell, anything Aura suggested would be generic — so it suggests nothing.',
      next: {
        label: 'Describe your business',
        href: askFor('identity.description'),
      },
    });
  } else {
    if (!has(b.audience)) {
      items.push({
        scenario: 'business_context',
        severity: 'limiting',
        title: 'Who are your customers?',
        message:
          'Aura suggests for your customers in general until it knows who they are.',
        next: {
          label: 'Describe your audience',
          href: askFor('audience.stated'),
        },
      });
    }
    if (!has(b.goals)) {
      items.push({
        scenario: 'business_context',
        severity: 'limiting',
        title: 'What are you trying to achieve?',
        message:
          'Without your goals, Aura cannot tell which opportunities matter most to you.',
        next: { label: 'Add your goals', href: askFor('objectives.goals') },
      });
    }
  }

  // --- Channels --------------------------------------------------------------
  if (b.channels.length === 0) {
    items.push({
      scenario: 'no_channels',
      severity: 'blocking',
      title: 'Tell Aura where you publish',
      message:
        'Every suggestion has to be something you can actually do. Aura won’t guess your channels — LinkedIn, Instagram, a blog, a newsletter.',
      next: {
        label: 'Add where you publish',
        href: askFor('channels.preferred'),
      },
    });
  }

  // --- Signals ---------------------------------------------------------------
  const watching = src.trendKeywords + src.competitorsTracked;
  if (watching === 0 && input.currentSignals === 0) {
    items.push({
      scenario: 'insufficient_signals',
      severity: 'blocking',
      title: 'Give Aura something to watch',
      message:
        'Aura isn’t following any topics or competitors yet, so it has nothing to base a suggestion on.',
      next: {
        label: 'Choose topics to follow',
        href: '/dashboard/settings/trends',
      },
    });
  } else if (input.currentSignals === 0) {
    items.push({
      scenario: 'insufficient_signals',
      severity: 'blocking',
      title: 'Nothing new seen yet',
      message:
        'Aura is set up to watch your market, but has no current signals — it may not have checked recently.',
      next: {
        label: 'Check for new opportunities',
        action: 'detect_opportunities',
      },
    });
  }

  // --- Opportunities ---------------------------------------------------------
  const signalsOk = !items.some((i) => i.scenario === 'insufficient_signals');
  if (signalsOk && input.opportunities.active === 0) {
    items.push({
      scenario: 'no_opportunities',
      severity: 'blocking',
      title: 'Nothing worth acting on right now',
      message:
        'Aura checked what it watches and found no opportunity strong enough to suggest. It would rather say so than suggest something generic.',
      next: {
        label: 'Check for new opportunities',
        action: 'detect_opportunities',
      },
    });
  } else if (
    input.opportunities.active > 0 &&
    input.opportunities.lowConfidence === input.opportunities.active
  ) {
    items.push({
      scenario: 'low_confidence',
      severity: 'limiting',
      title: 'Only early signs so far',
      message:
        'Everything Aura has found rests on thin evidence. Anything it suggests is marked “needs your review”, never as a sure thing.',
      next: {
        label: 'Look at the opportunities',
        href: '/dashboard/opportunities',
      },
    });
  }

  // --- Connected channels ------------------------------------------------------
  if (b.channels.length > 0 && b.connected.length === 0) {
    items.push({
      scenario: 'no_connected_channel',
      severity: 'limiting',
      title: 'No channel connected',
      message:
        'Aura can suggest posts, but not publish them or see how they did. You’ll post by hand until a channel is connected.',
      next: { label: 'Connect a channel', href: '/dashboard/connectors' },
    });
  }

  // --- Performance data ------------------------------------------------------
  if (
    input.results.analyticsReports === 0 &&
    input.results.publishedPosts === 0
  ) {
    items.push({
      scenario: 'no_performance_data',
      severity: 'limiting',
      title: 'No results yet',
      message:
        'Aura can’t tell what works for you until something is published and measured — so it won’t claim to know.',
      next: { label: 'See results', href: '/dashboard/analytics' },
    });
  }

  const blocking = items.filter((i) => i.severity === 'blocking');
  const ordered = [
    ...blocking,
    ...items.filter((i) => i.severity === 'limiting'),
  ];
  return {
    state: blocking.length ? 'blocked' : items.length ? 'limited' : 'ready',
    canRecommend: blocking.length === 0,
    items: ordered,
    primary: blocking[0] ?? null,
  };
}

/**
 * Whether Aura may write a recommendation at all — the business-side checks
 * only (what it does, where it publishes). Used by the automatic pass before
 * it writes anything, so nothing generic is produced to fill the page.
 */
export function mayWriteRecommendations(b: ReadinessInput['business']): {
  ok: boolean;
  reason: string | null;
} {
  if (!has(b.description) && !has(b.offerings)) {
    return {
      ok: false,
      reason: 'Aura does not know what the business does yet.',
    };
  }
  if (b.channels.length === 0) {
    return {
      ok: false,
      reason: 'The business has not said where it publishes.',
    };
  }
  return { ok: true, reason: null };
}
