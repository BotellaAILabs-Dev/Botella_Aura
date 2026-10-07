import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  AURA_MODULES,
  AURA_MODULE_IDS,
  ROUTE_BY_ACTION,
  ROUTE_BY_TYPE,
  moduleForPath,
  moduleHandoff,
  recommendationBrief,
  routeFor,
  routeRecommendation,
  type RoutableRecommendation,
} from '@/lib/aura-modules';
import { recommendationActivity } from '@/lib/aura-home';
import { ACTIONS_FOR } from '@/lib/recommendation-engine';
import {
  RECOMMENDATION_ACTIONS,
  RECOMMENDATION_TYPES,
  executionBrief,
} from '@/lib/recommendations';
import { toRecommendationContext } from '@/lib/recommendation-context';

/**
 * Recommendations know which of Aura's modules carries them out, take their
 * context there (?rec=), and hand each module typed data a creation or
 * execution workflow can consume.
 */

const TICKET_MODULES = [
  'content-studio',
  'campaigns',
  'outreach',
  'analytics',
  'memory',
  'competitors',
  'lead-discovery',
] as const;

function rec(o: Partial<RoutableRecommendation> = {}): RoutableRecommendation {
  return {
    id: 'rec42',
    type: 'COMPETITIVE_RESPONSE',
    title: 'Respond to Acme Coffee’s pricing change',
    action: 'Publish a post on LinkedIn giving your own view on this.',
    steps: ['Draft it', 'Post Thursday'],
    rationale: 'Acme cut prices. Based on 1 piece of evidence: Acme pricing.',
    expectedOutcome: 'Buyers comparing options hear your position.',
    channel: 'LinkedIn',
    contentType: 'LINKEDIN_POST',
    audience: 'Home brewers',
    details: {
      action: 'response-post',
      angle: 'Freshness, not price',
      competitor: 'Acme Coffee',
      topic: 'coffee prices',
    },
    ...o,
  };
}

describe('module capability metadata', () => {
  it('covers every module the ticket names, plus the existing workflows', () => {
    for (const m of TICKET_MODULES) expect(AURA_MODULE_IDS).toContain(m);
    for (const id of AURA_MODULE_IDS) {
      const m = AURA_MODULES[id];
      expect(m.id).toBe(id);
      expect(m.label.length).toBeGreaterThan(2);
      expect(m.description.length).toBeGreaterThan(10);
      expect(m.capabilities.length).toBeGreaterThan(0);
      expect(m.accepts.length).toBeGreaterThan(0);
    }
  });

  it('every route and entry point is a real page in Aura', () => {
    for (const id of AURA_MODULE_IDS) {
      for (const route of [
        AURA_MODULES[id].route,
        AURA_MODULES[id].entryRoute,
      ]) {
        expect(route.startsWith('/dashboard')).toBe(true);
        const file = join(
          process.cwd(),
          'app',
          ...route.slice(1).split('/'),
          'page.tsx',
        );
        expect(existsSync(file), `${id}: ${route} has no page`).toBe(true);
      }
    }
  });

  it('modules that create something take a prefill; the rest show the context', () => {
    for (const id of AURA_MODULE_IDS) {
      const m = AURA_MODULES[id];
      expect(m.handoff === 'prefill').toBe(m.creates !== null);
    }
    expect(AURA_MODULES['content-studio'].handoff).toBe('prefill');
    expect(AURA_MODULES.campaigns.handoff).toBe('prefill');
  });
});

describe('which module carries a recommendation out', () => {
  it('every action the engine can choose has a route', () => {
    const engineActions = new Set(
      Object.values(ACTIONS_FOR).flatMap((specs) => specs.map((s) => s.id)),
    );
    for (const a of engineActions) {
      expect(
        ROUTE_BY_ACTION[a],
        `engine action "${a}" has no route`,
      ).toBeDefined();
    }
  });

  it('every recommendation type has a fallback route', () => {
    for (const t of RECOMMENDATION_TYPES)
      expect(ROUTE_BY_TYPE[t]).toBeDefined();
  });

  it('every module the ticket names is reachable from some recommendation', () => {
    const reachable = new Set(
      [
        ...Object.values(ROUTE_BY_ACTION),
        ...Object.values(ROUTE_BY_TYPE),
      ].flatMap((r) => [r.primary, ...r.related]),
    );
    for (const m of TICKET_MODULES) {
      expect(reachable.has(m), `${m} is never a destination`).toBe(true);
    }
  });

  it('the engine’s action decides, ahead of the type', () => {
    expect(routeFor(rec()).primary).toBe('content-studio');
    expect(routeFor(rec({ details: { action: 'series' } })).primary).toBe(
      'campaigns',
    );
    expect(routeFor(rec({ type: 'CAMPAIGN', details: {} })).primary).toBe(
      'campaigns',
    );
    // A post to win a drop back is content, not a plan.
    expect(
      routeFor(
        rec({ type: 'OPTIMIZATION', details: { action: 'recovery-post' } }),
      ).primary,
    ).toBe('content-studio');
  });

  it('the destination names the action, carries the recommendation, and lists related modules', () => {
    const r = routeRecommendation(rec());
    expect(r.primary).toEqual(
      expect.objectContaining({
        module: 'content-studio',
        verb: 'Create content',
        handoff: 'prefill',
      }),
    );
    const url = new URL(r.primary.href, 'https://x');
    expect(url.pathname).toBe('/dashboard/content/new');
    expect(url.searchParams.get('rec')).toBe('rec42');
    expect(url.searchParams.get('type')).toBe('LINKEDIN_POST');
    expect(url.searchParams.get('brief')).toContain(
      'Respond to Acme Coffee’s pricing change',
    );
    expect(r.related.map((d) => [d.module, d.verb])).toEqual([
      ['competitors', 'Open Competitors'],
    ]);
    expect(
      new URL(r.related[0]!.href, 'https://x').searchParams.get('rec'),
    ).toBe('rec42');
  });

  it('connecting a channel names the channel', () => {
    const r = routeRecommendation(
      rec({
        type: 'CHANNEL',
        channel: 'Instagram',
        details: { action: 'connect-channel' },
      }),
    );
    expect(r.primary.verb).toBe('Connect Instagram');
    expect(r.primary.href).toBe('/dashboard/connectors?rec=rec42');
  });

  it('the execution brief carries the module, the button and the related modules', () => {
    const b = executionBrief({
      ...rec(),
      opportunityId: 'opp1',
      relevantUntil: null,
      evidence: [],
    });
    expect(b.module).toBe('content-studio');
    expect(b.verb).toBe('Create content');
    expect(b.related.map((d) => d.module)).toEqual(['competitors']);
    expect(b.href).toContain('rec=rec42');
  });
});

describe('what each module receives — for a later creation/execution workflow', () => {
  it('Content Studio: the full brief, format, channel and audience', () => {
    const h = moduleHandoff('content-studio', rec());
    expect(h).toEqual({
      brief: recommendationBrief(rec()),
      contentType: 'LINKEDIN_POST',
      channel: 'LinkedIn',
      audience: 'Home brewers',
    });
    expect(h.brief).toContain('- Draft it');
    expect(h.brief).toContain('Angle: Freshness, not price');
    expect(h.brief).toContain(
      'Goal: Buyers comparing options hear your position.',
    );
  });

  it('Campaigns: a name, a goal, the audience and themes', () => {
    expect(moduleHandoff('campaigns', rec())).toEqual({
      name: 'Respond to Acme Coffee’s pricing change',
      goal: 'Publish a post on LinkedIn giving your own view on this. Buyers comparing options hear your position.',
      targetAudience: 'Home brewers',
      themes: ['coffee prices', 'Freshness, not price'],
    });
  });

  it('the other modules get what they can use — and nothing invented', () => {
    expect(moduleHandoff('competitors', rec())).toEqual({
      competitor: 'Acme Coffee',
    });
    expect(moduleHandoff('lead-discovery', rec())).toEqual({
      audience: 'Home brewers',
    });
    expect(moduleHandoff('outreach', rec())).toEqual({
      audience: 'Home brewers',
      angle: 'Freshness, not price',
    });
    expect(
      moduleHandoff(
        'analytics',
        rec({ details: { metric: 'Total engagement' } }),
      ),
    ).toEqual({
      metric: 'Total engagement',
    });
    // Not recorded: null, not a guess.
    expect(moduleHandoff('analytics', rec())).toEqual({ metric: null });
    expect(moduleHandoff('memory', rec())).toEqual({ pattern: null });
    expect(moduleHandoff('competitors', rec({ details: {} }))).toEqual({
      competitor: null,
    });
  });
});

describe('keeping the context between modules', () => {
  it('a page is matched to its module', () => {
    expect(moduleForPath('/dashboard/content/new')).toBe('content-studio');
    expect(moduleForPath('/dashboard/content/abc123')).toBe('content-studio');
    expect(moduleForPath('/dashboard/campaigns/new')).toBe('campaigns');
    expect(moduleForPath('/dashboard/leads/discover')).toBe('lead-discovery');
    expect(moduleForPath('/dashboard/competitors')).toBe('competitors');
    expect(moduleForPath('/dashboard/analytics')).toBe('analytics');
    expect(moduleForPath('/dashboard/settings')).toBeNull();
  });

  it('the context says what it is, why, the goal, and what to do in each module', () => {
    const c = toRecommendationContext({
      ...rec(),
      status: 'PRESENTED',
      evidence: [
        { label: 'Acme pricing' },
        { label: 'b' },
        { label: 'c' },
        { label: 'd' },
      ],
    });
    expect(c).toEqual(
      expect.objectContaining({
        id: 'rec42',
        title: 'Respond to Acme Coffee’s pricing change',
        why: 'Acme cut prices.',
        expectedOutcome: 'Buyers comparing options hear your position.',
        actionable: true,
        evidence: ['Acme pricing', 'b', 'c'],
        backHref: '/dashboard/suggestions',
      }),
    );
    expect(c.primary.hint).toMatch(/filled in from the suggestion/);
    expect(c.related[0]!.hint).toBe(
      'Look at what Acme Coffee changed before you respond.',
    );
    expect(c.related[0]!.handoff).toEqual({ competitor: 'Acme Coffee' });
  });

  it('a recommendation already answered is shown as done, not as work', () => {
    for (const status of [
      'SKIPPED',
      'REJECTED',
      'EXPIRED',
      'COMPLETED',
      'WITHDRAWN',
    ]) {
      expect(
        toRecommendationContext({ ...rec(), status, evidence: [] }).actionable,
      ).toBe(false);
    }
  });

  it('a module picking it up is a history action, and reads as one', () => {
    expect(RECOMMENDATION_ACTIONS).toContain('link');
    expect(recommendationActivity('link', 'Post X', 'Content Studio')).toBe(
      'started on “Post X” in Content Studio',
    );
  });
});
