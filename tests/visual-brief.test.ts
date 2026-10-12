import { describe, it, expect } from 'vitest';

import {
  buildContentBrief,
  contentBriefSchema,
  type BriefOpportunity,
} from '@/lib/content-brief';
import { RATIO_DIMENSIONS } from '@/lib/platforms';
import {
  buildContextHandoff,
  type HandoffInput,
} from '@/lib/recommendation-context-handoff';
import {
  buildVisualBrief,
  visualBriefToPrompt,
  type VisualBriefInput,
} from '@/lib/visual-brief';
import type { ContentTypeKey } from '@/lib/validations/content';
import type { SocialPlatformKey } from '@/lib/platforms';
import { heuristicPrompt } from '@/server/media/image-prompt.service';

/**
 * The visual brief: what image generation needs, derived from the
 * recommendation — when an image is required, its subject and product, the
 * brand's palette and mood, the channel's shape — with gaps identified.
 */

const OPP: BriefOpportunity = {
  id: 'opp1',
  title: 'Coffee prices are rising',
  type: 'TRENDING_TOPIC',
  typeLabel: 'Trending topic',
  summary: '',
  angle: null,
};

function handoff(b: Partial<HandoffInput['business']> = {}) {
  return buildContextHandoff({
    recommendation: {
      id: 'rec1',
      opportunityId: 'opp1',
      status: 'ACCEPTED',
      type: 'CONTENT',
      title: 'Explain the coffee price rise',
      action: 'Tell subscribers why prices rose.',
      steps: [],
      rationale: 'Prices are rising.',
      expectedOutcome: 'Subscribers understand.',
      outcomeMetric: null,
      channel: 'Instagram',
      contentType: 'IMAGE_POST',
      audience: null,
      details: { angle: 'Honest about where the money goes' },
      confidence: 'HIGH',
      confidenceReason: null,
      executable: true,
      blockers: [],
      evidence: [],
    },
    business: {
      name: 'Roastery',
      description: 'Small-batch roaster.',
      offerings: 'Single-origin coffee subscriptions',
      industry: 'Coffee',
      website: 'https://roastery.example',
      goals: 'Grow subscriptions',
      audience: 'Home brewers',
      campaigns: [],
      connected: ['Instagram'],
      voice: {
        summary: 'Warm.',
        tone: ['warm', 'honest'],
        phrases: [],
        avoid: ['caffeine health claims'],
        formatting: null,
      },
      memory: [],
      ...b,
    },
  });
}

const brief = (
  type: ContentTypeKey,
  platform?: SocialPlatformKey,
  extra: Partial<Parameters<typeof buildContentBrief>[0]> = {},
) =>
  buildContentBrief({
    handoff: handoff(),
    opportunity: OPP,
    choice: { type, ...(platform ? { platform } : {}) },
    brand: { colors: ['#6B3E26', '#F2E3C6'], hasLogo: true },
    marketMode: 'B2C',
    ...extra,
  });

describe('visual requirements come from the recommendation', () => {
  const v = brief('IMAGE_POST', 'INSTAGRAM').visual!;

  it('an image post needs an image, and says so', () => {
    expect(v.need).toBe('required');
    expect(v.why).toMatch(/cannot go out without an image/);
    expect(v.count).toEqual({ min: 1, max: 1 });
  });

  it('subject, product, audience and setting', () => {
    expect(v.subject).toEqual({
      value: 'Honest about where the money goes',
      source: 'recommendation',
    });
    expect(v.product).toEqual({
      value: 'Single-origin coffee subscriptions',
      source: 'business_profile',
    });
    expect(v.audience).toBe('Home brewers');
    expect(v.setting).toMatch(/^Consumer imagery/);
  });

  it('brand guidance: palette, mood, never-show, logo kept out of the image', () => {
    expect(v.brand).toEqual({
      palette: ['#6B3E26', '#F2E3C6'],
      mood: ['warm', 'honest'],
      avoid: ['caffeine health claims'],
      logoOnFile: true,
    });
    expect(v.rules.join(' ')).toMatch(
      /a logo is added by the business, not drawn/,
    );
    expect(v.rules.join(' ')).toMatch(/Do not depict an offer, price/);
  });

  it('nothing missing → ready', () => {
    expect(v.missing).toEqual([]);
    expect(v.readiness).toBe('ready');
  });
});

describe('dimensions and aspect ratio by channel', () => {
  it.each([
    ['IMAGE_POST', 'INSTAGRAM', '4:5'],
    ['IMAGE_POST', 'LINKEDIN', '1:1'],
    ['CAROUSEL', 'INSTAGRAM', '4:5'],
    ['EMAIL', undefined, '16:9'],
    ['BLOG', undefined, '16:9'],
  ] as const)(
    '%s on %s → %s, at the generator’s size',
    (type, platform, ratio) => {
      const v = brief(type, platform).visual!;
      expect(v.format.aspectRatio).toBe(ratio);
      expect({ width: v.format.width, height: v.format.height }).toEqual(
        RATIO_DIMENSIONS[ratio],
      );
    },
  );

  it('carries the channel’s file limits and art direction', () => {
    const f = brief('IMAGE_POST', 'INSTAGRAM').visual!.format;
    expect(f.channel).toBe('Instagram');
    expect(f.ratios.length).toBeGreaterThan(0);
    expect(f.maxFileSizeMb).toBeGreaterThan(0);
    expect(f.artDirection).toBeTruthy();
  });

  it('a carousel needs 3–10 images; campaign copy takes none', () => {
    expect(brief('CAROUSEL', 'INSTAGRAM').visual!.count).toEqual({
      min: 3,
      max: 10,
    });
    const none = brief('CAMPAIGN_COPY').visual!;
    expect(none).toMatchObject({
      need: 'none',
      readiness: 'not_needed',
      missing: [],
    });
  });
});

describe('missing visual information is identified', () => {
  it('no brand colours, product, audience or voice — each flagged with where to add it', () => {
    const v = buildContentBrief({
      handoff: handoff({
        offerings: null,
        description: 'Roaster.',
        audience: null,
        voice: null,
      }),
      opportunity: OPP,
      choice: { type: 'IMAGE_POST', platform: 'INSTAGRAM' },
      brand: { colors: [], hasLogo: false },
    }).visual!;
    expect(v.missing.map((m) => m.field).sort()).toEqual([
      'audience',
      'mood',
      'palette',
    ]);
    expect(v.missing.find((m) => m.field === 'palette')?.fix?.href).toBe(
      '/dashboard/settings',
    );
    expect(v.readiness).toBe('ready_with_gaps');
    // What the business does stands in for an unknown product.
    expect(v.product?.value).toBe('Roaster.');
  });

  it('no product and no description: flagged, not invented', () => {
    const input: VisualBriefInput = {
      need: 'required',
      count: { min: 1, max: 1 },
      formatLabel: 'Single image post',
      aspectRatio: null,
      platform: 'INSTAGRAM',
      channel: 'Instagram',
      keyMessage: { value: 'Fresh beans', source: 'post' },
      offerings: null,
      description: null,
      audience: 'Home brewers',
      marketMode: null,
      brand: { colors: ['#000000'], hasLogo: false },
      voice: { tone: ['warm'], avoid: [] },
    };
    const v = buildVisualBrief(input);
    expect(v.product).toBeNull();
    expect(v.missing.map((m) => m.field)).toEqual(['product']);
  });

  it('no subject at all: blocked — there is nothing to picture', () => {
    const v = buildVisualBrief({
      need: 'required',
      count: { min: 1, max: 1 },
      formatLabel: 'Single image post',
      aspectRatio: null,
      platform: 'INSTAGRAM',
      channel: null,
      keyMessage: null,
      offerings: 'Coffee',
      description: null,
      audience: 'x',
      marketMode: 'B2C',
      brand: { colors: ['#000000'], hasLogo: false },
      voice: { tone: ['warm'], avoid: [] },
    });
    expect(v.readiness).toBe('blocked');
  });
});

describe('image generation receives structured context', () => {
  const v = brief('IMAGE_POST', 'INSTAGRAM').visual!;

  it('the art director’s brief: idea, product, audience, setting, palette, mood, never-show, shape, rules', () => {
    const p = visualBriefToPrompt(v);
    expect(p).toMatch(/The idea to carry: Honest about where the money goes/);
    expect(p).toMatch(
      /What the business offers.*Single-origin coffee subscriptions/,
    );
    expect(p).toMatch(/Who will see it: Home brewers/);
    expect(p).toMatch(/Setting: Consumer imagery/);
    expect(p).toMatch(/Brand palette: build the image around #6B3E26, #F2E3C6/);
    expect(p).toMatch(/Mood \(from the brand voice\): warm, honest/);
    expect(p).toMatch(/Never depict: caffeine health claims/);
    expect(p).toMatch(/Format: 4:5 \(1024×1280\) for Instagram/);
    expect(p).toMatch(/Hard rules: No lettering/);
  });

  it('gaps are passed on as "do not invent"', () => {
    const gappy = buildContentBrief({
      handoff: handoff({ audience: null }),
      opportunity: OPP,
      choice: { type: 'IMAGE_POST' },
    }).visual!;
    expect(visualBriefToPrompt(gappy)).toMatch(
      /Not provided — do not invent: .*palette/,
    );
  });

  it('without an AI provider, the fallback prompt uses the brief’s subject — not the post’s first line', () => {
    const r = heuristicPrompt(
      'Big news!!! Read this.\nMore text here.',
      'Instagram direction.',
      'Polished.',
      undefined,
      v,
    );
    expect(r.subject).toBe('Honest about where the money goes');
    expect(r.prompt).toMatch(
      /Where it fits, show: Single-origin coffee subscriptions/,
    );
    expect(r.prompt).toMatch(/built around #6B3E26, #F2E3C6/);
    expect(r.prompt).toMatch(/Never depict: caffeine health claims/);
  });

  it('briefs saved before the visual brief existed still validate', () => {
    const b = brief('IMAGE_POST');
    const { visual: _v, ...old } = b;
    expect(contentBriefSchema.safeParse(old).success).toBe(true);
  });
});
