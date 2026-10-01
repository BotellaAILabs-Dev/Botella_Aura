import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import { businessContextSchema } from '@/lib/business-context';
import { snapshotSchema } from '@/lib/business-context-snapshot';
import {
  buildBusinessContext,
  type BusinessContextSources,
} from '@/server/business-context/build';
import { businessContextToPrompt } from '@/server/business-context/business-context.service';
import {
  checkCoverage,
  type RawSources,
} from '@/server/business-context/coverage';
import {
  buildSnapshot,
  snapshotToPrompt,
  viewSnapshot,
} from '@/server/business-context/snapshot';

/**
 * Connecting Aura's existing sources to the Business Context layer.
 *
 * Pins the newly mapped sources (campaigns, content history, analytics,
 * competitor notes, the legacy logo) and the coverage check that proves no
 * existing business information is lost — including that it DOES report a
 * loss when one happens, which is what makes its "nothing lost" believable.
 */

const NOW = new Date('2026-10-01T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function sources(): BusinessContextSources {
  return {
    company: {
      id: 'c1',
      name: 'Verdant Roastery',
      website: 'https://verdant.coffee',
      industry: 'Food & beverage',
      brandVoiceNotes: 'Friendly, no jargon',
      brandVoiceProfile: null,
      logoUrl: 'https://cdn.example/logo.png',
      updatedAt: daysAgo(1),
      preferences: {
        business: {
          description: 'We roast single-origin coffee in small batches.',
          offerings: 'Whole bean subscriptions',
        },
        marketingProfile: {
          marketMode: 'B2C',
          audience: 'People who already own a grinder.',
          goals: '200 new subscribers',
        },
        autopilot: { enabled: true },
      },
    },
    market: {
      competitors: [
        {
          name: 'Acme Coffee',
          url: null,
          trackingEnabled: true,
          updatedAt: daysAgo(3),
          notes: 'Undercuts on price every January.',
        },
      ],
      trendConfig: null,
    },
    plan: null,
    campaigns: [
      {
        name: 'Holiday gift boxes',
        status: 'ACTIVE',
        goal: 'Sell 300 gift boxes by December 20',
        targetAudience: 'People buying for a coffee lover',
        themes: ['gifting', 'origin stories'],
        endDate: new Date('2026-12-20'),
        updatedAt: daysAgo(4),
      },
      {
        name: 'Old launch',
        status: 'COMPLETED',
        goal: null,
        targetAudience: null,
        themes: [],
        endDate: null,
      },
    ],
    history: {
      recentContent: [
        {
          title: 'Why we rest beans for 30 days',
          type: 'LINKEDIN_POST',
          status: 'PUBLISHED',
          publishedAt: daysAgo(5),
          scheduledFor: null,
          updatedAt: daysAgo(5),
        },
        {
          title: '',
          type: 'IMAGE_POST',
          status: 'APPROVED',
          publishedAt: null,
          scheduledFor: null,
          updatedAt: daysAgo(2),
        },
      ],
      analytics: {
        periodStart: daysAgo(30),
        periodEnd: daysAgo(0),
        metrics: {
          postsPublished: 6,
          totalEngagement: 412,
          note: 'not a number',
        },
        generatedAt: daysAgo(1),
      },
    },
  };
}

const build = (src = sources()) => buildBusinessContext(src, NOW);

// ---------------------------------------------------------------------------

describe('newly connected sources', () => {
  it('maps running campaigns, ignoring finished ones', () => {
    const ctx = build();
    expect(ctx.objectives.campaigns).toEqual([
      {
        name: 'Holiday gift boxes',
        status: 'ACTIVE',
        goal: 'Sell 300 gift boxes by December 20',
        audience: 'People buying for a coffee lover',
        themes: ['gifting', 'origin stories'],
        endDate: new Date('2026-12-20').toISOString(),
      },
    ]);
    expect(ctx.meta.facts['objectives.campaigns']).toMatchObject({
      sourceType: 'user_provided',
      trusted: true,
    });
  });

  it('maps recent content and analytics as system-generated records', () => {
    const ctx = build();
    expect(ctx.history.recentContent.map((c) => c.title)).toEqual([
      'Why we rest beans for 30 days',
    ]);
    expect(ctx.history.performance?.metrics).toEqual({
      postsPublished: 6,
      totalEngagement: 412,
    });
    expect(ctx.meta.facts['history.performance']).toMatchObject({
      sourceType: 'system_generated',
      confidence: 'high',
    });
  });

  it('carries competitor notes and the legacy logo', () => {
    const ctx = build();
    expect(ctx.market.competitors[0]?.notes).toBe(
      'Undercuts on price every January.',
    );
    expect(ctx.identity.visual).toEqual({
      logoUrl: 'https://cdn.example/logo.png',
    });
  });

  it('still validates against the schema', () => {
    expect(businessContextSchema.safeParse(build()).success).toBe(true);
  });

  it('renders campaigns and history for planning, and keeps them out of content', () => {
    const planning = businessContextToPrompt(build(), 'planning');
    expect(planning).toContain('RUNNING CAMPAIGNS:');
    expect(planning).toContain(
      'Holiday gift boxes — goal: Sell 300 gift boxes',
    );
    expect(planning).toContain('do not repeat these topics');
    expect(planning).toContain('Why we rest beans for 30 days');
    expect(planning).toContain(
      'Their notes on Acme Coffee: Undercuts on price',
    );
    const content = businessContextToPrompt(build(), 'content');
    expect(content).not.toContain('RUNNING CAMPAIGNS');
  });
});

describe('snapshot picks up the new sources', () => {
  it('adds running campaigns to goals and a history section', () => {
    const s = buildSnapshot(build(), [], NOW);
    expect(snapshotSchema.safeParse(s).success).toBe(true);
    expect(s.goals?.campaigns[0]?.name).toBe('Holiday gift boxes');
    expect(s.history?.recentTopics).toEqual(['Why we rest beans for 30 days']);
    expect(snapshotToPrompt(s)).toContain('Recently published (do not repeat)');
  });

  it('gives content generation the history so it does not repeat itself', () => {
    expect(
      viewSnapshot(buildSnapshot(build(), [], NOW), 'content').history,
    ).not.toBeNull();
    expect(
      viewSnapshot(buildSnapshot(build(), [], NOW), 'engagement').history,
    ).toBeNull();
  });

  it('leaves out an analytics period that is out of date', () => {
    const src = sources();
    src.history!.analytics!.generatedAt = daysAgo(80);
    const s = buildSnapshot(build(src), [], NOW);
    expect(s.history?.performance).toBeNull();
    expect(s.omitted.some((o) => o.field === 'history.performance')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

function raw(overrides: Partial<RawSources> = {}): RawSources {
  const src = sources();
  return {
    company: { ...src.company, logoUrl: src.company.logoUrl ?? null },
    outreach: null,
    discovery: [],
    competitors: [
      { name: 'Acme Coffee', notes: 'Undercuts on price every January.' },
    ],
    trend: null,
    latestPlanInputs: null,
    activeCampaigns: [{ name: 'Holiday gift boxes' }],
    connectorIds: [],
    linkedInActive: false,
    knowledgeChunks: 0,
    realMemories: 0,
    recentContentTitles: ['Why we rest beans for 30 days'],
    hasAnalytics: true,
    ...overrides,
  };
}

describe('coverage check — no business information lost', () => {
  it('finds every stored value in the context it was built from', () => {
    const checks = checkCoverage(raw(), build());
    expect(checks.filter((c) => c.status === 'lost')).toEqual([]);
    expect(checks.find((c) => c.field === 'offerings')?.status).toBe(
      'reachable',
    );
    expect(checks.find((c) => c.source === 'Campaign')?.status).toBe(
      'reachable',
    );
  });

  it('reports a value the context does not carry as LOST', () => {
    const src = sources();
    (
      src.company.preferences as { business: Record<string, unknown> }
    ).business.offerings = undefined;
    const checks = checkCoverage(raw(), build(src));
    expect(checks.find((c) => c.field === 'offerings')).toMatchObject({
      status: 'lost',
    });
  });

  it('reports an unknown preferences key instead of ignoring it', () => {
    const r = raw();
    (r.company.preferences as Record<string, unknown>).mysteryField = 'x';
    const checks = checkCoverage(r, build());
    expect(checks.find((c) => c.field === 'mysteryField')?.status).toBe('lost');
    expect(checks.find((c) => c.field === 'autopilot')?.status).toBe(
      'intentional',
    );
  });

  it('reports a stored voice profile that no longer parses', () => {
    const r = raw();
    r.company.brandVoiceProfile = { sentenceLength: 'enormous' };
    expect(
      checkCoverage(r, build()).find((c) => c.field === 'brandVoiceProfile')
        ?.status,
    ).toBe('lost');
  });

  it('treats a plan value overridden by settings as superseded, not lost', () => {
    const src = sources();
    src.plan = {
      inputs: { audience: 'Cafe owners buying wholesale' },
      month: new Date('2026-10-01'),
      updatedAt: daysAgo(1),
    };
    const checks = checkCoverage(
      raw({ latestPlanInputs: src.plan.inputs }),
      build(src),
    );
    expect(
      checks.find((c) => c.source === 'MarketingPlan' && c.field === 'audience')
        ?.status,
    ).toBe('superseded');
  });

  it('accounts for discovery profiles beyond the three the audience reads', () => {
    const discovery = Array.from({ length: 4 }, (_, i) => ({
      name: `P${i}`,
      criteria: { roleTitles: [`Role ${i}`] },
    }));
    const src = sources();
    src.targeting = {
      outreach: null,
      discoveryProfiles: discovery.slice(0, 3),
    };
    const checks = checkCoverage(raw({ discovery }), build(src));
    expect(checks.find((c) => c.field === 'criteria (P3)')?.status).toBe(
      'intentional',
    );
    expect(checks.filter((c) => c.status === 'lost')).toEqual([]);
  });

  it('separates publishing channels from other connected tools', () => {
    const src = sources();
    src.connections = {
      connectorIds: ['ga4', 'mailchimp'],
      linkedInConnected: false,
      lastSyncedAt: daysAgo(1),
    };
    const checks = checkCoverage(
      raw({ connectorIds: ['ga4', 'mailchimp'] }),
      build(src),
    );
    expect(checks.find((c) => c.field === 'ga4')?.status).toBe('intentional');
    expect(checks.find((c) => c.field === 'mailchimp')?.status).toBe(
      'reachable',
    );
  });
});
