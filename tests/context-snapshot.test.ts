import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Business Context Snapshot.
 *
 * Pins the acceptance criteria: a workflow can request a current snapshot; it
 * contains only relevant, trusted information (everything else is labelled as
 * an assumption or left out); it is rebuilt after the context changes; and the
 * Content and Recommendation workflows each get a view they can consume.
 */

const { db, getBusinessContext, retrieve } = vi.hoisted(() => {
  const agg = (max: Record<string, Date | null>, count = 0) =>
    vi.fn().mockResolvedValue({ _max: max, _count: { _all: count } });
  return {
    db: {
      businessContextSnapshot: {
        findUnique: vi.fn(),
        upsert: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      company: { findUnique: vi.fn() },
      outreachConfig: { findUnique: vi.fn().mockResolvedValue(null) },
      discoveryProfile: { aggregate: agg({ updatedAt: null }) },
      competitorProfile: { aggregate: agg({ updatedAt: null }) },
      companyTrendConfig: { findUnique: vi.fn().mockResolvedValue(null) },
      marketingPlan: { aggregate: agg({ updatedAt: null }) },
      connection: { aggregate: agg({ updatedAt: null }) },
      linkedInConnection: { findFirst: vi.fn().mockResolvedValue(null) },
      websiteConnection: { aggregate: vi.fn().mockResolvedValue({ _max: { updatedAt: null }, _count: { _all: 0 } }) },
      knowledgeChunk: { aggregate: agg({ createdAt: null }) },
      marketingMemory: { aggregate: agg({ generatedAt: null }) },
      campaign: { aggregate: agg({ updatedAt: null }) },
      contentDraft: { aggregate: agg({ updatedAt: null }) },
      analyticsReport: { aggregate: agg({ generatedAt: null }) },
    },
    getBusinessContext: vi.fn(),
    retrieve: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/server/business-context/business-context.service', () => ({
  getBusinessContext,
}));
vi.mock('@/server/knowledge/retrieve', () => ({
  retrieve,
  chunksToContext: () => '',
}));

import {
  SNAPSHOT_TTL_MS,
  SNAPSHOT_VERSION,
  SNAPSHOT_VIEWS,
  snapshotSchema,
} from '@/lib/business-context-snapshot';
import {
  buildBusinessContext,
  type BusinessContextSources,
} from '@/server/business-context/build';
import {
  buildSnapshot,
  snapshotToPrompt,
  viewSnapshot,
} from '@/server/business-context/snapshot';
import {
  computeSourceStamp,
  getContextSnapshot,
  invalidateContextSnapshot,
  refreshReason,
} from '@/server/business-context/snapshot.service';
import type { RetrievedChunk } from '@/server/knowledge/retrieve';

const NOW = new Date('2026-10-01T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const meta = (sourceType: string, at: Date) => ({
  sourceType,
  capturedAt: at.toISOString(),
});

const VOICE = {
  toneDescriptors: ['warm', 'plain'],
  sentenceLength: 'short',
  vocabulary: ['single-origin'],
  commonPhrases: [],
  topicsToAvoid: ['price wars'],
  formatting: { emojiUsage: 'none', hashtagStyle: 'one or two', notes: '' },
  summary: 'Warm, specific, never salesy.',
};

/** A workspace where everything is confirmed and current. */
function trustedSources(): BusinessContextSources {
  return {
    company: {
      id: 'c1',
      name: 'Verdant Roastery',
      website: 'https://verdant.coffee',
      industry: 'Food & beverage',
      brandVoiceNotes: 'Friendly, no jargon',
      brandVoiceProfile: VOICE,
      updatedAt: daysAgo(1),
      preferences: {
        business: {
          description: 'We roast single-origin coffee in small batches.',
          offerings: 'Whole bean subscriptions and gift boxes',
        },
        marketingProfile: {
          marketMode: 'B2C',
          audience: 'People who already own a grinder.',
          goals: '200 new subscribers this quarter',
          channels: ['Instagram', 'Newsletter'],
        },
        factMeta: Object.fromEntries(
          [
            'identity.name',
            'identity.description',
            'identity.offerings',
            'identity.industry',
            'identity.website',
            'audience.marketMode',
            'audience.stated',
            'objectives.goals',
            'channels.preferred',
            'voice.profile',
          ].map((k) => [k, meta('onboarding', daysAgo(5))]),
        ),
      },
    },
    connections: {
      connectorIds: ['mailchimp'],
      linkedInConnected: false,
      lastSyncedAt: daysAgo(1),
    },
    market: {
      competitors: [
        {
          name: 'Acme Coffee',
          url: null,
          trackingEnabled: true,
          updatedAt: daysAgo(3),
        },
      ],
      trendConfig: {
        keywords: ['specialty coffee'],
        competitorNames: ['Globex Beans'],
        geoCountry: null,
        geoRegion: null,
        geoCity: null,
        language: 'en',
        defaultsSeeded: true,
        updatedAt: daysAgo(3),
      },
      trendEditedByUser: true,
    },
    memory: [
      {
        id: 'm1',
        insightType: 'TOPIC',
        insight: 'Origin stories outperform price posts',
        confidence: 'HIGH',
        sampleSize: 40,
        supportingDataSummary: {},
        generatedAt: daysAgo(4),
      },
    ],
  };
}

const ctxOf = (src: BusinessContextSources) => buildBusinessContext(src, NOW);

const chunk = (o: Partial<RetrievedChunk>): RetrievedChunk => ({
  id: 'k',
  title: 'Why us',
  content: 'Every lot is roasted within 48 hours of shipping.',
  sourceType: 'UPLOAD',
  category: 'DIFFERENTIATORS',
  score: 1,
  ...o,
});

// ---------------------------------------------------------------------------

describe('snapshot structure', () => {
  it('carries every required section for a fully described business, and validates', () => {
    const s = buildSnapshot(ctxOf(trustedSources()), [chunk({})], NOW);
    expect(snapshotSchema.safeParse(s).success).toBe(true);
    expect(s.business).toMatchObject({
      name: 'Verdant Roastery',
      description: expect.stringContaining('single-origin'),
    });
    expect(s.products?.offerings).toBe(
      'Whole bean subscriptions and gift boxes',
    );
    expect(s.products?.highlights[0]?.excerpt).toContain('48 hours');
    expect(s.audience).toMatchObject({
      marketMode: 'B2C',
      description: 'People who already own a grinder.',
    });
    expect(s.goals?.current).toBe('200 new subscribers this quarter');
    expect(s.voice).toMatchObject({
      summary: 'Warm, specific, never salesy.',
      tone: ['warm', 'plain'],
      avoid: ['price wars'],
    });
    expect(s.channels).toEqual({
      publishesOn: ['Instagram', 'Newsletter'],
      connected: ['Newsletter'],
    });
    expect(s.learning?.insights[0]?.insight).toContain('Origin stories');
    expect(s.market?.competitors).toContain('Acme Coffee');
    expect(s.gaps).toEqual([]);
  });

  it('carries source and confidence for every included fact', () => {
    const s = buildSnapshot(ctxOf(trustedSources()), [], NOW);
    expect(s.trust['identity.description']).toMatchObject({
      sourceType: 'onboarding',
      confidence: 'confirmed',
      freshness: 'fresh',
    });
    expect(s.trust['channels.connected']).toMatchObject({
      sourceType: 'connected_platform',
      confidence: 'high',
    });
    expect(s.trust['memory.insights']?.sourceType).toBe('marketing_memory');
  });

  it('caps lists so its size in a prompt is predictable', () => {
    const src = trustedSources();
    src.targeting = {
      outreach: {
        roleTitles: Array.from({ length: 20 }, (_, i) => `Role ${i}`),
        industries: [],
        companyStages: [],
        updatedAt: daysAgo(2),
      },
      discoveryProfiles: [],
    };
    const s = buildSnapshot(
      ctxOf(src),
      [chunk({ content: 'x '.repeat(500) })],
      NOW,
    );
    expect(s.audience?.roles.length).toBeLessThanOrEqual(6);
    expect(s.products?.highlights[0]?.excerpt.length).toBeLessThanOrEqual(280);
    expect(s.meta.estimatedTokens).toBeGreaterThan(0);
    expect(s.meta.estimatedTokens).toBeLessThan(1200);
  });
});

describe('only relevant, trusted information', () => {
  it('moves an unreviewed AI voice to assumptions, keeping the business’s own words', () => {
    const src = trustedSources();
    (src.company.preferences as { factMeta: Record<string, unknown> }).factMeta[
      'voice.profile'
    ] = meta('ai_derived', daysAgo(1));
    const s = buildSnapshot(ctxOf(src), [], NOW);
    expect(s.voice).toMatchObject({
      summary: null,
      tone: [],
      notes: 'Friendly, no jargon',
    });
    expect(s.assumptions).toContainEqual(
      expect.objectContaining({
        field: 'voice.summary',
        reason: 'suggested by AI, not confirmed',
      }),
    );
  });

  it('lists AI-guessed competitors as assumptions, not competitors', () => {
    const src = trustedSources();
    src.market!.trendEditedByUser = false;
    const s = buildSnapshot(ctxOf(src), [], NOW);
    expect(s.market?.competitors).toEqual(['Acme Coffee']);
    expect(s.market?.keywords).toEqual([]);
    expect(s.assumptions.map((a) => a.value)).toEqual(
      expect.arrayContaining(['Globex Beans', 'specialty coffee']),
    );
  });

  it('keeps a stale goal out of the facts and says why', () => {
    const src = trustedSources();
    (src.company.preferences as { factMeta: Record<string, unknown> }).factMeta[
      'objectives.goals'
    ] = meta('user_provided', daysAgo(120));
    const s = buildSnapshot(ctxOf(src), [], NOW);
    expect(s.goals).toBeNull();
    expect(s.assumptions).toContainEqual(
      expect.objectContaining({
        field: 'objectives.goals',
        reason: 'last updated 120 days ago',
      }),
    );
  });

  it('drops stale learning and marks thin learning tentative', () => {
    const src = trustedSources();
    src.memory = [
      {
        id: 'old',
        insightType: 'TOPIC',
        insight: 'Old pattern',
        confidence: 'HIGH',
        sampleSize: 40,
        supportingDataSummary: {},
        generatedAt: daysAgo(90),
      },
      {
        id: 'thin',
        insightType: 'TIMING',
        insight: 'Post at 7am',
        confidence: 'LOW',
        sampleSize: 6,
        supportingDataSummary: {},
        generatedAt: daysAgo(2),
      },
      {
        id: 'mine',
        insightType: 'HASHTAG',
        insight: 'One hashtag max',
        confidence: 'LOW',
        sampleSize: 5,
        supportingDataSummary: { editedByUser: true },
        generatedAt: daysAgo(2),
      },
    ];
    const s = buildSnapshot(ctxOf(src), [], NOW);
    expect(s.learning?.insights.map((i) => i.insight)).toEqual([
      'One hashtag max',
    ]);
    expect(s.omitted.some((o) => o.field === 'memory:old')).toBe(true);
    expect(s.assumptions).toContainEqual(
      expect.objectContaining({
        value: 'Post at 7am',
        reason: 'small sample (6)',
      }),
    );
  });

  it('quotes product evidence only from the business’s own uploads', () => {
    const s = buildSnapshot(
      ctxOf(trustedSources()),
      [
        chunk({ sourceType: 'WEBSITE', category: null }),
        chunk({ category: 'PAST_CAMPAIGN' }),
      ],
      NOW,
    );
    expect(s.products?.highlights).toEqual([]);
    expect(s.omitted.some((o) => o.field === 'products.highlights')).toBe(true);
  });

  it('names what is missing so a workflow does not invent it', () => {
    const s = buildSnapshot(
      ctxOf({ company: { ...trustedSources().company, preferences: {} } }),
      [],
      NOW,
    );
    expect(s.gaps.map((g) => g.field).sort()).toEqual([
      'audience.marketMode',
      'audience.stated',
      'identity.description',
    ]);
    expect(snapshotToPrompt(s)).toContain('NOT PROVIDED');
  });
});

describe('views for each workflow', () => {
  const full = () => {
    const src = trustedSources();
    src.market!.trendEditedByUser = false;
    return buildSnapshot(ctxOf(src), [], NOW);
  };

  it('gives content generation no market section', () => {
    const v = viewSnapshot(full(), 'content');
    expect(v.market).toBeNull();
    expect(v.voice).not.toBeNull();
    expect(v.assumptions.some((a) => a.field === 'market.competitors')).toBe(
      false,
    );
  });

  it('gives recommendation every section', () => {
    const v = viewSnapshot(full(), 'recommendation');
    expect(v.meta.sections).toEqual([...SNAPSHOT_VIEWS.recommendation]);
    expect(v.market).not.toBeNull();
  });

  it('keeps the persona out of outreach', () => {
    expect(viewSnapshot(full(), 'outreach').audience).toBeNull();
  });

  it('strict mode drops assumptions, recording each one as omitted', () => {
    const v = viewSnapshot(full(), 'recommendation', true);
    expect(v.assumptions).toEqual([]);
    expect(v.omitted.some((o) => o.reason.startsWith('Strict snapshot'))).toBe(
      true,
    );
    expect(snapshotToPrompt(v)).not.toContain('Globex Beans');
  });

  it('shares one fingerprint across views of the same state', () => {
    const f = full();
    expect(viewSnapshot(f, 'content').fingerprint).toBe(f.fingerprint);
  });
});

describe('optimised for AI consumption', () => {
  it('does not repeat the voice notes when the summary already says the same', () => {
    const src = trustedSources();
    src.company.brandVoiceNotes = 'Warm, specific, never salesy.';
    const s = buildSnapshot(ctxOf(src), [], NOW);
    expect(s.voice?.notes).toBeNull();
    expect(snapshotToPrompt(s).match(/never salesy/g)).toHaveLength(1);
  });

  it('separates confirmed facts from assumptions in the prompt', () => {
    const src = trustedSources();
    src.market!.trendEditedByUser = false;
    const prompt = snapshotToPrompt(buildSnapshot(ctxOf(src), [], NOW));
    const [facts, assumptions] = prompt.split('ASSUMPTIONS');
    expect(facts).toContain('confirmed, current facts');
    expect(facts).toContain('Competitors: Acme Coffee');
    expect(facts).not.toContain('Globex Beans');
    expect(assumptions).toContain('Globex Beans');
    expect(assumptions).toContain('never state them as facts');
  });

  it('fingerprints content, not build time', () => {
    const a = buildSnapshot(ctxOf(trustedSources()), [], NOW);
    const b = buildSnapshot(
      ctxOf(trustedSources()),
      [],
      new Date(NOW.getTime() + 60_000),
    );
    expect(b.fingerprint).toBe(a.fingerprint);
    const changed = trustedSources();
    (
      changed.company.preferences as {
        marketingProfile: Record<string, unknown>;
      }
    ).marketingProfile.goals = '300 subscribers';
    expect(buildSnapshot(ctxOf(changed), [], NOW).fingerprint).not.toBe(
      a.fingerprint,
    );
  });
});

// ---------------------------------------------------------------------------

describe('refresh behaviour', () => {
  const stored = (
    o: Partial<{
      version: number;
      sourceStamp: string;
      generatedAt: Date;
      invalidatedAt: Date | null;
    }> = {},
  ) => ({
    version: SNAPSHOT_VERSION,
    sourceStamp: 'stamp-a',
    generatedAt: daysAgo(0),
    invalidatedAt: null,
    ...o,
  });

  it('decides every refresh reason', () => {
    expect(refreshReason(stored(), 'stamp-a', NOW)).toBeNull();
    expect(refreshReason(null, 'stamp-a', NOW)).toBe('missing');
    expect(refreshReason(stored(), 'stamp-a', NOW, true)).toBe('forced');
    expect(refreshReason(stored({ version: 0 }), 'stamp-a', NOW)).toBe(
      'version',
    );
    expect(refreshReason(stored({ invalidatedAt: NOW }), 'stamp-a', NOW)).toBe(
      'invalidated',
    );
    expect(refreshReason(stored(), 'stamp-b', NOW)).toBe('sources_changed');
    expect(
      refreshReason(
        stored({ generatedAt: new Date(NOW.getTime() - SNAPSHOT_TTL_MS - 1) }),
        'stamp-a',
        NOW,
      ),
    ).toBe('expired');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    db.company.findUnique.mockResolvedValue({ updatedAt: daysAgo(1) });
    getBusinessContext.mockResolvedValue(ctxOf(trustedSources()));
  });

  it('builds and stores a snapshot on first request', async () => {
    db.businessContextSnapshot.findUnique.mockResolvedValue(null);
    const r = await getContextSnapshot('c1', { view: 'content', now: NOW });
    expect(r).toMatchObject({ status: 'rebuilt', reason: 'missing' });
    expect(r?.snapshot.view).toBe('content');
    expect(r?.prompt).toContain('BUSINESS CONTEXT');
    expect(db.businessContextSnapshot.upsert).toHaveBeenCalledTimes(1);
  });

  it('serves the stored snapshot while nothing has changed', async () => {
    const stamp = await computeSourceStamp('c1');
    const full = buildSnapshot(ctxOf(trustedSources()), [], NOW);
    db.businessContextSnapshot.findUnique.mockResolvedValue({
      version: SNAPSHOT_VERSION,
      sourceStamp: stamp,
      generatedAt: NOW,
      invalidatedAt: null,
      payload: full,
    });
    const r = await getContextSnapshot('c1', {
      view: 'recommendation',
      now: NOW,
    });
    expect(r?.status).toBe('current');
    expect(getBusinessContext).not.toHaveBeenCalled();
    expect(db.businessContextSnapshot.upsert).not.toHaveBeenCalled();
  });

  it('rebuilds after the context changes', async () => {
    const stamp = await computeSourceStamp('c1');
    db.businessContextSnapshot.findUnique.mockResolvedValue({
      version: SNAPSHOT_VERSION,
      sourceStamp: stamp,
      generatedAt: NOW,
      invalidatedAt: null,
      payload: buildSnapshot(ctxOf(trustedSources()), [], NOW),
    });
    // A business-context write bumps Company.updatedAt.
    db.company.findUnique.mockResolvedValue({ updatedAt: NOW });
    const r = await getContextSnapshot('c1', { now: NOW });
    expect(r).toMatchObject({ status: 'rebuilt', reason: 'sources_changed' });
    expect(db.businessContextSnapshot.upsert).toHaveBeenCalledTimes(1);
  });

  it('notices a deleted competitor through the row count', async () => {
    const before = await computeSourceStamp('c1');
    db.competitorProfile.aggregate.mockResolvedValueOnce({
      _max: { updatedAt: null },
      _count: { _all: 2 },
    });
    expect(await computeSourceStamp('c1')).not.toBe(before);
  });

  it('rebuilds a stored snapshot it cannot parse instead of serving it', async () => {
    const stamp = await computeSourceStamp('c1');
    db.businessContextSnapshot.findUnique.mockResolvedValue({
      version: SNAPSHOT_VERSION,
      sourceStamp: stamp,
      generatedAt: NOW,
      invalidatedAt: null,
      payload: { nope: true },
    });
    const r = await getContextSnapshot('c1', { now: NOW });
    expect(r).toMatchObject({ status: 'rebuilt', reason: 'version' });
  });

  it('returns null for an unknown workspace', async () => {
    db.company.findUnique.mockResolvedValue(null);
    db.businessContextSnapshot.findUnique.mockResolvedValue(null);
    expect(await getContextSnapshot('nope')).toBeNull();
  });

  it('invalidation is best-effort and never throws', async () => {
    db.businessContextSnapshot.updateMany.mockRejectedValueOnce(
      new Error('db down'),
    );
    await expect(invalidateContextSnapshot('c1')).resolves.toBeUndefined();
  });
});
