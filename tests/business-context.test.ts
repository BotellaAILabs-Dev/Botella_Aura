import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import {
  businessContextSchema,
  CONTEXT_FIELDS,
  REQUIRED_FIELDS,
} from '@/lib/business-context';
import {
  buildBusinessContext,
  readPlanDuplicates,
  type BusinessContextSources,
} from '@/server/business-context/build';
import {
  businessContextToPrompt,
  toAudienceProfile,
} from '@/server/business-context/business-context.service';
import { composeAudienceProfile } from '@/server/content/audience';

/**
 * The Business Context: one structure every AI workflow reads the business
 * from. These tests pin the mapping of each existing source into it, the rule
 * for each duplicated fact, and the required/optional contract.
 */

const NOW = new Date('2026-09-29T12:00:00Z');

function company(
  overrides: Partial<BusinessContextSources['company']> = {},
): BusinessContextSources['company'] {
  return {
    id: 'c1',
    name: 'Verdant Roastery',
    website: 'https://verdant.coffee',
    industry: 'Food & beverage',
    brandVoiceNotes: null,
    brandVoiceProfile: null,
    preferences: {
      business: {
        description: 'We roast single-origin coffee in small batches.',
        offerings: 'Whole bean subscriptions',
      },
      marketingProfile: {
        marketMode: 'B2C',
        audience: 'People who already own a grinder.',
        goals: '200 new subscribers this quarter',
        channels: ['Instagram', 'Newsletter'],
      },
    },
    ...overrides,
  };
}

function build(src: Partial<BusinessContextSources> = {}) {
  return buildBusinessContext({ company: company(), ...src }, NOW);
}

const EMPTY_WORKSPACE = company({
  website: null,
  industry: null,
  preferences: {},
});

describe('schema', () => {
  it('every built context validates against the published schema', () => {
    const ctx = build({
      targeting: { outreach: null, discoveryProfiles: [] },
      market: { competitors: [], trendConfig: null },
      plan: null,
      connections: { connectorIds: [], linkedInConnected: false },
      knowledge: { chunkCounts: [], websiteUrls: [] },
      memory: [],
    });
    expect(businessContextSchema.safeParse(ctx).success).toBe(true);
    expect(
      businessContextSchema.safeParse(
        buildBusinessContext({ company: EMPTY_WORKSPACE }, NOW),
      ).success,
    ).toBe(true);
  });

  it('marks exactly the fields onboarding refuses to skip as required', () => {
    expect([...REQUIRED_FIELDS].sort()).toEqual(
      [
        'audience.marketMode',
        'audience.stated',
        'identity.description',
        'identity.name',
      ].sort(),
    );
  });

  it('gives every field at least one source and one consuming module', () => {
    for (const f of CONTEXT_FIELDS) {
      expect(f.sources.length, f.path).toBeGreaterThan(0);
      expect(f.consumers.length, f.path).toBeGreaterThan(0);
    }
  });
});

describe('onboarding mapping', () => {
  it('maps the wizard answers into identity, audience, objectives and channels', () => {
    const ctx = build();
    expect(ctx.identity).toMatchObject({
      name: 'Verdant Roastery',
      description: 'We roast single-origin coffee in small batches.',
      offerings: 'Whole bean subscriptions',
      industry: 'Food & beverage',
      website: 'https://verdant.coffee',
    });
    expect(ctx.audience.marketMode).toBe('B2C');
    expect(ctx.audience.stated).toBe('People who already own a grinder.');
    expect(ctx.objectives.goals).toBe('200 new subscribers this quarter');
    expect(ctx.channels.preferred).toEqual(['Instagram', 'Newsletter']);
    expect(ctx.meta.provenance['identity.description']).toEqual({
      sources: ['workspace_profile'],
      inferred: false,
    });
  });

  it('is complete once the required fields are present', () => {
    const ctx = build();
    expect(ctx.meta.completeness.complete).toBe(true);
    expect(ctx.meta.completeness.missingRequired).toEqual([]);
  });

  it('reports every missing required field for an empty workspace', () => {
    const ctx = buildBusinessContext({ company: EMPTY_WORKSPACE }, NOW);
    expect(ctx.meta.completeness.complete).toBe(false);
    expect(ctx.meta.completeness.missingRequired.sort()).toEqual(
      ['audience.marketMode', 'audience.stated', 'identity.description'].sort(),
    );
  });

  it('treats a field in an unloaded section as unknown, not missing', () => {
    const withoutKnowledge = build();
    expect(withoutKnowledge.meta.completeness.missingRecommended).not.toContain(
      'knowledge.coverage',
    );
    const emptyKnowledge = build({
      knowledge: { chunkCounts: [], websiteUrls: [] },
    });
    expect(emptyKnowledge.meta.completeness.missingRecommended).toContain(
      'knowledge.coverage',
    );
  });

  it('survives a corrupt preferences bag', () => {
    const ctx = buildBusinessContext(
      {
        company: company({
          preferences: { business: 'nope', marketingProfile: [1] },
        }),
      },
      NOW,
    );
    expect(ctx.identity.description).toBeNull();
    expect(ctx.audience.stated).toBeNull();
  });
});

describe('conflict resolution: settings vs the latest marketing plan', () => {
  it('uses settings and reports the plan value it overrode', () => {
    const ctx = build({
      plan: {
        inputs: {
          audience: 'Cafe owners buying wholesale',
          businessGoals: '200 new subscribers this quarter',
        },
      },
    });
    expect(ctx.audience.stated).toBe('People who already own a grinder.');
    const conflict = ctx.meta.issues.find((i) => i.field === 'audience.stated');
    expect(conflict).toMatchObject({
      kind: 'value_conflict',
      chosen: { source: 'workspace_profile' },
      overridden: [
        { source: 'marketing_plan', value: 'Cafe owners buying wholesale' },
      ],
    });
    // Identical goals are not a conflict.
    expect(
      ctx.meta.issues.find((i) => i.field === 'objectives.goals'),
    ).toBeUndefined();
  });

  it('ignores case, spacing and trailing punctuation when comparing', () => {
    const ctx = build({
      plan: { inputs: { audience: 'people who  already own a GRINDER' } },
    });
    expect(
      ctx.meta.issues.find((i) => i.field === 'audience.stated'),
    ).toBeUndefined();
  });

  it('falls back to the plan when settings are empty, marked as inferred', () => {
    const ctx = buildBusinessContext(
      {
        company: company({
          preferences: { marketingProfile: { marketMode: 'B2B' } },
        }),
        plan: {
          inputs: {
            audience: 'Ops leads at logistics firms',
            channels: ['LinkedIn'],
          },
        },
      },
      NOW,
    );
    expect(ctx.audience.stated).toBe('Ops leads at logistics firms');
    expect(ctx.channels.preferred).toEqual(['LinkedIn']);
    expect(ctx.meta.provenance['audience.stated']).toEqual({
      sources: ['marketing_plan'],
      inferred: true,
    });
  });

  it('reads what it can from a malformed plan', () => {
    expect(
      readPlanDuplicates({
        channels: ['LinkedIn', 'Fax'],
        audience: 42,
        businessGoals: ' Grow ',
      }),
    ).toEqual({
      audience: undefined,
      goals: 'Grow',
      channels: ['LinkedIn'],
      brandGuidelines: undefined,
    });
    expect(readPlanDuplicates(null)).toEqual({});
  });
});

describe('conflict resolution: website', () => {
  it('flags a knowledge-base site on a different domain', () => {
    const ctx = build({
      knowledge: { chunkCounts: [], websiteUrls: ['https://old-brand.com'] },
    });
    expect(ctx.identity.website).toBe('https://verdant.coffee');
    expect(ctx.meta.issues.some((i) => i.field === 'identity.website')).toBe(
      true,
    );
  });

  it('treats www and paths on the same domain as the same site', () => {
    const ctx = build({
      knowledge: {
        chunkCounts: [],
        websiteUrls: ['https://www.verdant.coffee/about'],
      },
    });
    expect(ctx.meta.issues.some((i) => i.field === 'identity.website')).toBe(
      false,
    );
  });

  it('borrows a single synced site when settings have none', () => {
    const ctx = buildBusinessContext(
      {
        company: company({ website: null }),
        knowledge: { chunkCounts: [], websiteUrls: ['https://verdant.coffee'] },
      },
      NOW,
    );
    expect(ctx.identity.website).toBe('https://verdant.coffee');
    expect(ctx.meta.provenance['identity.website']?.inferred).toBe(true);
  });
});

describe('brand voice mapping', () => {
  const profile = {
    toneDescriptors: ['warm'],
    sentenceLength: 'short',
    vocabulary: [],
    commonPhrases: [],
    topicsToAvoid: ['price wars'],
    formatting: { emojiUsage: 'none', hashtagStyle: 'none', notes: '' },
    summary: 'Warm, specific, never salesy.',
  };

  it('prefers the profile over the notes it was generated from, without a conflict', () => {
    const ctx = buildBusinessContext(
      {
        company: company({
          brandVoiceProfile: profile,
          brandVoiceNotes: 'friendly',
        }),
      },
      NOW,
    );
    expect(ctx.voice.summary).toBe('Warm, specific, never salesy.');
    expect(ctx.voice.notes).toBe('friendly');
    // Layered, so the profile and notes are not a value conflict…
    expect(
      ctx.meta.issues.filter(
        (i) => i.field === 'voice.summary' && i.kind === 'value_conflict',
      ),
    ).toEqual([]);
    // …but a profile nobody has reviewed is still an AI draft.
    expect(ctx.meta.facts['voice.summary']).toMatchObject({
      sourceType: 'ai_derived',
      trusted: false,
    });
  });

  it('falls back to notes and says a profile has not been generated', () => {
    const ctx = buildBusinessContext(
      { company: company({ brandVoiceNotes: 'Friendly and plain-spoken' }) },
      NOW,
    );
    expect(ctx.voice.profile).toBeNull();
    expect(ctx.voice.summary).toBe('Friendly and plain-spoken');
    expect(ctx.meta.issues.find((i) => i.field === 'voice.summary')?.kind).toBe(
      'consistency',
    );
  });

  it('drops an unparseable stored profile rather than throwing', () => {
    const ctx = buildBusinessContext(
      {
        company: company({ brandVoiceProfile: { sentenceLength: 'enormous' } }),
      },
      NOW,
    );
    expect(ctx.voice.profile).toBeNull();
  });
});

describe('audience targeting', () => {
  it('merges outreach and discovery tags without case duplicates', () => {
    const ctx = build({
      targeting: {
        outreach: {
          roleTitles: ['Head of Ops'],
          industries: ['Logistics'],
          companyStages: [],
        },
        discoveryProfiles: [
          {
            criteria: {
              roleTitles: ['head of ops', 'CTO'],
              keywords: ['logistics'],
            },
          },
        ],
      },
    });
    expect(ctx.audience.roleTitles).toEqual(['Head of Ops', 'CTO']);
    expect(ctx.meta.provenance['audience.roleTitles']?.sources).toEqual([
      'outreach_targeting',
      'discovery_profiles',
    ]);
  });

  it('notes a consumer brand whose outreach targets business roles', () => {
    const ctx = build({
      targeting: {
        outreach: {
          roleTitles: ['Bar manager'],
          industries: [],
          companyStages: [],
        },
        discoveryProfiles: [],
      },
    });
    expect(
      ctx.meta.issues.find((i) => i.field === 'audience.marketMode')?.kind,
    ).toBe('consistency');
  });

  it('describes the same buyer as getAudienceProfile', () => {
    const targeting = {
      outreach: {
        roleTitles: ['Head of Ops'],
        industries: ['Logistics'],
        companyStages: ['50-200'],
      },
      discoveryProfiles: [{ criteria: { roleTitles: ['CTO'] } }],
    };
    const marketing = {
      marketMode: 'B2C' as const,
      audience: 'People who already own a grinder.',
      goals: '200 new subscribers this quarter',
    };
    const legacy = composeAudienceProfile({
      marketing,
      outreach: targeting.outreach,
      profiles: targeting.discoveryProfiles,
    });
    const unified = toAudienceProfile(build({ targeting }));
    expect({ ...unified, sources: [] }).toEqual({ ...legacy, sources: [] });
    expect(new Set(unified?.sources)).toEqual(new Set(legacy?.sources));
  });
});

describe('market mapping', () => {
  it('merges tracked competitors with the trend watch list', () => {
    const ctx = build({
      market: {
        competitors: [
          {
            name: 'Acme Coffee',
            url: 'https://acme.co',
            trackingEnabled: true,
          },
        ],
        trendConfig: {
          keywords: ['specialty coffee'],
          competitorNames: ['acme coffee', 'Globex Beans'],
          geoCountry: 'US',
          geoRegion: null,
          geoCity: null,
          language: 'en',
        },
      },
    });
    expect(ctx.market.competitors).toEqual([
      {
        name: 'Acme Coffee',
        url: 'https://acme.co',
        tracked: true,
        source: 'competitor_profiles',
        sourceType: 'user_provided',
        confidence: 'confirmed',
        capturedAt: null,
      },
      {
        name: 'Globex Beans',
        url: null,
        tracked: false,
        source: 'trend_config',
        sourceType: 'user_provided',
        confidence: 'confirmed',
        capturedAt: null,
      },
    ]);
    const note = ctx.meta.issues.find((i) => i.field === 'market.competitors');
    expect(note?.message).toContain('Globex Beans');
    expect(note?.message).not.toContain('Acme');
    expect(ctx.market.geo.country).toBe('US');
  });
});

describe('channels', () => {
  it('derives connected channels and notes preferred ones that are not connected', () => {
    const ctx = build({
      connections: { connectorIds: ['mailchimp'], linkedInConnected: false },
    });
    expect(ctx.channels.connected).toEqual(['Newsletter']);
    expect(
      ctx.meta.issues.find((i) => i.field === 'channels.connected')?.message,
    ).toContain('Instagram');
  });

  it('counts the dedicated LinkedIn connection', () => {
    const ctx = build({
      connections: { connectorIds: [], linkedInConnected: true },
    });
    expect(ctx.channels.connected).toEqual(['LinkedIn']);
  });
});

describe('knowledge base mapping', () => {
  it('summarises what material exists and what is missing', () => {
    const ctx = build({
      knowledge: {
        chunkCounts: [
          { category: 'DIFFERENTIATORS', chunks: 4 },
          { category: null, chunks: 10 },
        ],
        websiteUrls: [],
      },
    });
    expect(ctx.knowledge.totalChunks).toBe(14);
    expect(ctx.knowledge.covered).toEqual(['DIFFERENTIATORS']);
    expect(ctx.knowledge.missing).toContain('BRAND_GUIDELINES');
    expect(ctx.knowledge.missing).not.toContain('OTHER');
    expect(ctx.knowledge.uncategorisedChunks).toBe(10);
  });
});

describe('marketing memory mapping', () => {
  const row = (
    o: Partial<NonNullable<BusinessContextSources['memory']>[number]>,
  ) => ({
    id: 'm',
    insightType: 'CONTENT_FORMAT',
    insight: 'Carousels win',
    confidence: 'LOW',
    sampleSize: 10,
    supportingDataSummary: {},
    ...o,
  });

  it('drops the insufficient-data note, ranks user edits first, and de-duplicates', () => {
    const ctx = build({
      memory: [
        row({ id: 'a', confidence: 'HIGH', sampleSize: 40 }),
        row({
          id: 'b',
          insight: 'Post on Tuesdays',
          insightType: 'TIMING',
          supportingDataSummary: { editedByUser: true },
        }),
        row({ id: 'c', insight: 'carousels win.', confidence: 'MEDIUM' }),
        row({
          id: 'd',
          insight: 'Not enough data',
          supportingDataSummary: { status: 'insufficient' },
        }),
      ],
    });
    expect(ctx.memory.insights.map((m) => m.id)).toEqual(['b', 'a']);
    expect(ctx.memory.insights[0]?.editedByUser).toBe(true);
  });
});

describe('businessContextToPrompt', () => {
  const full = () =>
    build({
      targeting: {
        outreach: {
          roleTitles: ['Bar manager'],
          industries: [],
          companyStages: [],
        },
        discoveryProfiles: [],
      },
      memory: [
        {
          id: 'm1',
          insightType: 'OUTREACH_APPROACH',
          insight: 'Mention their menu',
          confidence: 'MEDIUM',
          sampleSize: 12,
          supportingDataSummary: {},
        },
        {
          id: 'm2',
          insightType: 'CONTENT_FORMAT',
          insight: 'Carousels win',
          confidence: 'HIGH',
          sampleSize: 30,
          supportingDataSummary: {},
        },
      ],
    });

  it('gives content generation identity, reader, rules and content memory', () => {
    const out = businessContextToPrompt(full(), 'content');
    expect(out).toContain('single-origin coffee');
    expect(out).toContain('already own a grinder');
    expect(out).toContain('HOW TO WRITE THIS');
    expect(out).toContain('Carousels win');
    expect(out).not.toContain('Mention their menu');
    expect(out).toContain('never override the brand voice');
  });

  it('keeps the workspace persona out of outreach', () => {
    const out = businessContextToPrompt(full(), 'outreach');
    expect(out).toContain('single-origin coffee');
    expect(out).not.toContain('WHO YOU ARE WRITING FOR');
    expect(out).toContain('Mention their menu');
    expect(out).not.toContain('Carousels win');
  });

  it('gives lead qualification buyer facts, not writing instructions', () => {
    const out = businessContextToPrompt(full(), 'qualification');
    expect(out).toContain('TARGET BUYER');
    expect(out).toContain('Sells to: consumers');
    expect(out).toContain('Bar manager');
    expect(out).not.toContain('Write TO');
  });

  it('asserts nothing about a workspace that has said nothing', () => {
    const out = businessContextToPrompt(
      buildBusinessContext({ company: EMPTY_WORKSPACE }, NOW),
      'planning',
    );
    expect(out).not.toContain('WHAT THIS COMPANY DOES');
    expect(out).not.toContain('MARKET:');
    expect(out).not.toContain('WHAT WE HAVE LEARNED');
    expect(out).toContain('has not described its buyers yet');
  });

  it('returns an empty string for a missing context', () => {
    expect(businessContextToPrompt(null, 'content')).toBe('');
  });
});
