import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import {
  businessContextSchema,
  CONFIDENCE_LEVELS,
  freshnessOf,
  FRESHNESS_RULES,
  SOURCE_TYPE_INFO,
  SOURCE_TYPES,
  CONTEXT_FIELDS,
} from '@/lib/business-context';
import { businessContextPatchSchema } from '@/lib/validations/business-context';
import {
  buildBusinessContext,
  type BusinessContextSources,
} from '@/server/business-context/build';
import {
  businessContextToPrompt,
  contextCaveats,
  WORKFLOW_PRESETS,
} from '@/server/business-context/business-context.service';
import {
  EMPTY_STORED_CONTEXT,
  planBusinessContextWrite,
  type StoredBusinessContext,
} from '@/server/business-context/update';
import { BusinessContextUpdateError } from '@/lib/validations/business-context';

/**
 * Source, confidence and freshness on every business fact.
 *
 * Pins the four acceptance criteria: Aura can tell where a fact came from; it
 * can tell trusted information from AI-derived; it can find stale and
 * conflicting information; and it never presents an unsupported assumption
 * to a model as a verified fact.
 */

const NOW = new Date('2026-09-30T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const VOICE = {
  toneDescriptors: ['warm'],
  sentenceLength: 'short',
  vocabulary: [],
  commonPhrases: [],
  topicsToAvoid: [],
  formatting: { emojiUsage: 'none', hashtagStyle: 'none', notes: '' },
  summary: 'Warm and plain-spoken.',
};

function company(
  preferences: Record<string, unknown>,
  overrides: Partial<BusinessContextSources['company']> = {},
): BusinessContextSources['company'] {
  return {
    id: 'c1',
    name: 'Verdant Roastery',
    website: 'https://verdant.coffee',
    industry: 'Food & beverage',
    brandVoiceNotes: null,
    brandVoiceProfile: null,
    preferences,
    updatedAt: NOW,
    ...overrides,
  };
}

const PROFILE = {
  business: { description: 'We roast single-origin coffee in small batches.' },
  marketingProfile: {
    marketMode: 'B2C',
    audience: 'People who already own a grinder.',
    goals: '200 new subscribers this quarter',
  },
};

/** Stored capture metadata, as the write service records it. */
const meta = (sourceType: string, at: Date, confirmedAt?: Date) => ({
  sourceType,
  capturedAt: at.toISOString(),
  ...(confirmedAt ? { confirmedAt: confirmedAt.toISOString() } : {}),
});

const build = (
  src: Partial<BusinessContextSources> & {
    company: BusinessContextSources['company'];
  },
) => buildBusinessContext(src, NOW);

// ---------------------------------------------------------------------------

describe('vocabulary', () => {
  it('defines every source type the ticket lists, and five confidence levels', () => {
    expect([...SOURCE_TYPES].sort()).toEqual(
      [
        'ai_derived',
        'connected_platform',
        'knowledge_base',
        'marketing_memory',
        'onboarding',
        'system_generated',
        'uploaded_document',
        'user_provided',
      ].sort(),
    );
    expect(CONFIDENCE_LEVELS).toEqual([
      'confirmed',
      'high',
      'medium',
      'low',
      'unverified',
    ]);
  });

  it('never trusts AI-derived information', () => {
    expect(SOURCE_TYPE_INFO.ai_derived).toMatchObject({
      trusted: false,
      confidence: 'unverified',
    });
  });

  it('has a freshness rule for every field', () => {
    for (const f of CONTEXT_FIELDS)
      expect(FRESHNESS_RULES[f.path], f.path).toBeDefined();
  });

  it('grades freshness as fresh, aging, stale or unknown', () => {
    expect(freshnessOf(10, 90)).toBe('fresh');
    expect(freshnessOf(70, 90)).toBe('aging');
    expect(freshnessOf(90, 90)).toBe('stale');
    expect(freshnessOf(null, 90)).toBe('unknown');
    expect(freshnessOf(null, null)).toBe('fresh');
  });
});

describe('where a fact came from', () => {
  it('records onboarding answers as onboarding, confirmed and trusted, with a date', () => {
    const ctx = build({
      company: company({
        ...PROFILE,
        factMeta: { 'identity.description': meta('onboarding', daysAgo(5)) },
      }),
    });
    expect(ctx.meta.facts['identity.description']).toMatchObject({
      source: 'workspace_profile',
      sourceType: 'onboarding',
      confidence: 'confirmed',
      trusted: true,
      capturedAt: daysAgo(5).toISOString(),
      ageDays: 5,
      freshness: 'fresh',
    });
  });

  it('marks values saved before capture dates as user-provided with unknown age', () => {
    const ctx = build({ company: company(PROFILE) });
    expect(ctx.meta.facts['audience.stated']).toMatchObject({
      sourceType: 'user_provided',
      capturedAt: null,
      freshness: 'unknown',
      note: 'Saved before capture dates were recorded.',
    });
  });

  it('records connected accounts as a connected platform', () => {
    const ctx = build({
      company: company(PROFILE),
      connections: {
        connectorIds: ['mailchimp'],
        linkedInConnected: false,
        lastSyncedAt: daysAgo(2),
      },
    });
    expect(ctx.meta.facts['channels.connected']).toMatchObject({
      sourceType: 'connected_platform',
      confidence: 'high',
      trusted: true,
    });
  });

  it('tells an uploaded document apart from a crawled website', () => {
    const uploaded = build({
      company: company(PROFILE),
      knowledge: {
        chunkCounts: [
          {
            category: 'PITCH_DECK',
            chunks: 3,
            sourceType: 'UPLOAD',
            newestAt: daysAgo(10),
          },
        ],
        websiteUrls: [],
      },
    });
    expect(uploaded.meta.facts['knowledge.coverage']).toMatchObject({
      sourceType: 'uploaded_document',
      trusted: true,
    });

    const crawled = build({
      company: company(PROFILE),
      knowledge: {
        chunkCounts: [
          {
            category: null,
            chunks: 9,
            sourceType: 'WEBSITE',
            newestAt: daysAgo(10),
          },
        ],
        websiteUrls: [],
      },
    });
    expect(crawled.meta.facts['knowledge.coverage']).toMatchObject({
      sourceType: 'knowledge_base',
      confidence: 'medium',
      trusted: false,
    });
  });

  it('takes memory confidence from its strongest insight', () => {
    const ctx = build({
      company: company(PROFILE),
      memory: [
        {
          id: 'm1',
          insightType: 'TIMING',
          insight: 'Tuesday mornings win',
          confidence: 'MEDIUM',
          sampleSize: 20,
          supportingDataSummary: {},
          generatedAt: daysAgo(3),
        },
      ],
    });
    expect(ctx.meta.facts['memory.insights']).toMatchObject({
      sourceType: 'marketing_memory',
      confidence: 'medium',
      trusted: false,
    });
  });
});

describe('trusted vs AI-derived', () => {
  it('treats an unreviewed voice profile as an AI draft', () => {
    const ctx = build({
      company: company(
        {
          ...PROFILE,
          factMeta: { 'voice.profile': meta('ai_derived', daysAgo(1)) },
        },
        { brandVoiceProfile: VOICE },
      ),
    });
    expect(ctx.meta.facts['voice.summary']).toMatchObject({
      sourceType: 'ai_derived',
      confidence: 'unverified',
      trusted: false,
    });
    expect(
      ctx.meta.issues.some(
        (i) => i.field === 'voice.summary' && i.kind === 'unverified',
      ),
    ).toBe(true);
  });

  it('trusts the same profile once a person has confirmed it', () => {
    const ctx = build({
      company: company(
        {
          ...PROFILE,
          factMeta: {
            'voice.profile': meta('user_provided', daysAgo(30), daysAgo(1)),
          },
        },
        { brandVoiceProfile: VOICE },
      ),
    });
    expect(ctx.meta.facts['voice.summary']).toMatchObject({
      trusted: true,
      confidence: 'confirmed',
      ageDays: 1,
    });
  });

  it('treats AI-seeded trend settings as AI-derived until a person saves them', () => {
    const market = (edited: boolean): BusinessContextSources['market'] => ({
      competitors: [],
      trendConfig: {
        keywords: ['specialty coffee'],
        competitorNames: ['Globex Beans'],
        geoCountry: null,
        geoRegion: null,
        geoCity: null,
        language: 'en',
        defaultsSeeded: true,
        updatedAt: daysAgo(5),
      },
      trendEditedByUser: edited,
    });
    const seeded = build({ company: company(PROFILE), market: market(false) });
    expect(seeded.meta.facts['market.keywords']?.sourceType).toBe('ai_derived');
    expect(seeded.market.competitors[0]).toMatchObject({
      sourceType: 'ai_derived',
      confidence: 'unverified',
    });

    const edited = build({ company: company(PROFILE), market: market(true) });
    expect(edited.meta.facts['market.keywords']).toMatchObject({
      sourceType: 'user_provided',
      trusted: true,
    });
  });

  it('caps a fallback value at medium and does not trust it', () => {
    const ctx = build({
      company: company({ marketingProfile: { marketMode: 'B2B' } }),
      plan: {
        inputs: { audience: 'Ops leads at logistics firms' },
        month: new Date('2026-09-01'),
        updatedAt: daysAgo(10),
      },
    });
    expect(ctx.meta.facts['audience.stated']).toMatchObject({
      source: 'marketing_plan',
      inferred: true,
      confidence: 'medium',
      trusted: false,
    });
  });
});

describe('stale and conflicting information', () => {
  it('flags a goal older than a quarter as stale', () => {
    const ctx = build({
      company: company({
        ...PROFILE,
        factMeta: { 'objectives.goals': meta('user_provided', daysAgo(100)) },
      }),
    });
    expect(ctx.meta.facts['objectives.goals']).toMatchObject({
      freshness: 'stale',
      ageDays: 100,
    });
    const issue = ctx.meta.issues.find(
      (i) => i.field === 'objectives.goals' && i.kind === 'stale',
    );
    expect(issue?.message).toContain('100 days ago');
  });

  it('marks a value from a past month’s plan stale whatever its age', () => {
    const ctx = build({
      company: company({ marketingProfile: { marketMode: 'B2B' } }),
      plan: {
        inputs: { audience: 'Ops leads at logistics firms' },
        month: new Date('2026-07-01'),
        updatedAt: daysAgo(2),
      },
    });
    expect(ctx.meta.facts['audience.stated']?.freshness).toBe('stale');
  });

  it('flags a connection that has not synced for over a month', () => {
    const ctx = build({
      company: company(PROFILE),
      connections: {
        connectorIds: ['mailchimp'],
        linkedInConnected: false,
        lastSyncedAt: daysAgo(40),
      },
    });
    expect(ctx.meta.facts['channels.connected']?.freshness).toBe('stale');
  });

  it('marks a fact whose sources disagree as conflicted', () => {
    const ctx = build({
      company: company(PROFILE),
      plan: {
        inputs: { audience: 'Cafe owners buying wholesale' },
        month: new Date('2026-09-01'),
        updatedAt: daysAgo(1),
      },
    });
    expect(ctx.meta.facts['audience.stated']).toMatchObject({
      source: 'workspace_profile',
      conflicted: true,
    });
  });

  it('says so when a stale value wins a conflict', () => {
    const ctx = build({
      company: company({
        ...PROFILE,
        factMeta: { 'audience.stated': meta('user_provided', daysAgo(200)) },
      }),
      plan: {
        inputs: { audience: 'Cafe owners buying wholesale' },
        month: new Date('2026-09-01'),
        updatedAt: daysAgo(1),
      },
    });
    const issue = ctx.meta.issues.find(
      (i) => i.field === 'audience.stated' && i.kind === 'stale',
    );
    expect(issue?.message).toContain('Another source has a different value');
    expect(issue?.severity).toBe('warning');
  });

  it('still validates against the published schema', () => {
    const ctx = build({
      company: company({
        ...PROFILE,
        factMeta: { 'objectives.goals': meta('user_provided', daysAgo(100)) },
      }),
      plan: {
        inputs: { audience: 'x y z w' },
        month: new Date('2026-07-01'),
        updatedAt: daysAgo(90),
      },
      connections: {
        connectorIds: [],
        linkedInConnected: true,
        lastSyncedAt: daysAgo(1),
      },
    });
    expect(businessContextSchema.safeParse(ctx).success).toBe(true);
  });
});

describe('assumptions are never presented as verified facts', () => {
  const ai = () =>
    build({
      company: company(
        {
          ...PROFILE,
          factMeta: { 'voice.profile': meta('ai_derived', daysAgo(1)) },
        },
        { brandVoiceProfile: VOICE, brandVoiceNotes: 'Friendly, no jargon' },
      ),
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
        trendEditedByUser: false,
      },
      memory: [
        {
          id: 'old',
          insightType: 'TOPIC',
          insight: 'Origin stories win',
          confidence: 'HIGH',
          sampleSize: 40,
          supportingDataSummary: {},
          generatedAt: daysAgo(120),
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
      ],
    });

  it('labels an unreviewed AI voice and keeps the company’s own words beside it', () => {
    const out = businessContextToPrompt(ai(), 'content');
    expect(out).toContain('drafted by AI');
    expect(out).not.toContain('write exactly in this voice');
    expect(out).toContain("In the company's own words: Friendly, no jargon");
  });

  it('separates confirmed competitors from AI guesses', () => {
    const out = businessContextToPrompt(ai(), 'planning');
    expect(out).toContain('Competitors: Acme Coffee.');
    expect(out).toContain(
      'Possibly competitors (suggested by AI, never confirmed by the company): Globex Beans',
    );
    expect(out).toContain('never name them as competitors');
    expect(out).toContain('suggested by AI, unconfirmed): specialty coffee');
  });

  it('drops stale learned patterns and marks thin ones tentative', () => {
    const out = businessContextToPrompt(ai(), 'planning');
    expect(out).not.toContain('Origin stories win');
    expect(out).toContain('Post at 7am (confidence: LOW, tentative');
  });

  it('adds reliability notes for fallback and stale facts it renders', () => {
    const ctx = build({
      company: company({
        marketingProfile: { marketMode: 'B2B', goals: 'Book 15 demos' },
        business: {
          description: 'We sell payroll software to small startups.',
        },
        factMeta: { 'objectives.goals': meta('user_provided', daysAgo(100)) },
      }),
      plan: {
        inputs: { audience: 'Ops leads at logistics firms' },
        month: new Date('2026-09-01'),
        updatedAt: daysAgo(2),
      },
    });
    const out = businessContextToPrompt(ctx, 'content');
    expect(out).toContain('RELIABILITY NOTES:');
    expect(out).toContain(
      "Who the buyer is: Taken from this month's plan because settings are empty.",
    );
    expect(out).toContain(
      'Business goals: last updated 100 days ago and may be out of date',
    );
    expect(out).toContain('never state them as verified facts');
    expect(
      contextCaveats(ctx, WORKFLOW_PRESETS.content)
        .map((c) => c.field)
        .sort(),
    ).toEqual(['audience.stated', 'objectives.goals']);
  });

  it('adds no notes when everything is confirmed and current', () => {
    const ctx = build({
      company: company({
        ...PROFILE,
        factMeta: {
          'identity.description': meta('onboarding', daysAgo(5)),
          'audience.stated': meta('onboarding', daysAgo(5)),
          'objectives.goals': meta('onboarding', daysAgo(5)),
        },
      }),
    });
    expect(businessContextToPrompt(ctx, 'content')).not.toContain(
      'RELIABILITY NOTES',
    );
  });
});

// ---------------------------------------------------------------------------

describe('capture metadata on write', () => {
  const stored = (
    prefs: Record<string, unknown> = PROFILE,
    over: Partial<StoredBusinessContext> = {},
  ) => ({
    ...EMPTY_STORED_CONTEXT,
    name: 'Verdant Roastery',
    preferences: prefs,
    ...over,
  });
  const write = (
    current: StoredBusinessContext,
    patch: unknown,
    origin: 'onboarding' | 'settings' | 'ai',
    confirm?: string[],
  ) =>
    planBusinessContextWrite(
      current,
      businessContextPatchSchema.parse(patch),
      origin,
      {},
      { confirm, now: NOW },
    );

  it('stamps each written field with its source type and date', () => {
    const p = write(
      stored(),
      { objectives: { goals: 'Book 20 demos' } },
      'settings',
    );
    expect(
      (p.data.preferences?.factMeta as Record<string, unknown>)[
        'objectives.goals'
      ],
    ).toEqual({
      sourceType: 'user_provided',
      capturedAt: NOW.toISOString(),
    });
  });

  it('records onboarding and AI writes as such', () => {
    const onboarded = planBusinessContextWrite(
      EMPTY_STORED_CONTEXT,
      businessContextPatchSchema.parse({
        identity: {
          name: 'Acme',
          description: 'We sell payroll software to small startups.',
        },
        audience: { marketMode: 'B2B', stated: 'Founders at small startups' },
      }),
      'onboarding',
      {},
      { now: NOW },
    );
    const fm = onboarded.data.preferences?.factMeta as Record<
      string,
      { sourceType: string }
    >;
    expect(fm['identity.description']?.sourceType).toBe('onboarding');

    const drafted = write(stored(), { voice: { profile: VOICE } }, 'ai');
    expect(
      (
        drafted.data.preferences?.factMeta as Record<
          string,
          { sourceType: string }
        >
      )['voice.profile']?.sourceType,
    ).toBe('ai_derived');
  });

  it('forgets the metadata of a cleared field', () => {
    const p = write(
      stored({
        ...PROFILE,
        business: { ...PROFILE.business, offerings: 'Beans' },
        factMeta: { 'identity.offerings': meta('onboarding', daysAgo(9)) },
      }),
      { identity: { offerings: null } },
      'settings',
    );
    expect(
      (p.data.preferences?.factMeta as Record<string, unknown>)[
        'identity.offerings'
      ],
    ).toBeUndefined();
  });

  it('confirms an AI draft without changing it, making it the business’s own', () => {
    const p = write(
      stored(
        {
          ...PROFILE,
          factMeta: { 'voice.profile': meta('ai_derived', daysAgo(40)) },
        },
        { brandVoiceProfile: VOICE },
      ),
      {},
      'settings',
      ['voice.profile'],
    );
    expect(p.changed).toEqual([]);
    expect(p.confirmed).toEqual(['voice.profile']);
    expect(
      (p.data.preferences?.factMeta as Record<string, unknown>)[
        'voice.profile'
      ],
    ).toEqual({
      sourceType: 'user_provided',
      capturedAt: daysAgo(40).toISOString(),
      confirmedAt: NOW.toISOString(),
    });
  });

  it('keeps a trusted source type when a person re-confirms it', () => {
    const p = write(
      stored({
        ...PROFILE,
        factMeta: { 'audience.stated': meta('onboarding', daysAgo(200)) },
      }),
      {},
      'settings',
      ['audience.stated'],
    );
    expect(
      (p.data.preferences?.factMeta as Record<string, { sourceType: string }>)[
        'audience.stated'
      ]?.sourceType,
    ).toBe('onboarding');
  });

  it('refuses confirmations an AI makes, of empty fields, or of fields owned elsewhere', () => {
    const refusal = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e as BusinessContextUpdateError;
      }
      throw new Error('expected refusal');
    };
    expect(
      refusal(() => write(stored(), {}, 'ai', ['audience.stated'])).message,
    ).toContain('Only a person');
    expect(
      refusal(() => write(stored(), {}, 'settings', ['identity.offerings']))
        .message,
    ).toContain('no value to confirm');
    expect(
      refusal(() => write(stored(), {}, 'settings', ['market.keywords']))
        .message,
    ).toContain('cannot be confirmed');
  });
});
