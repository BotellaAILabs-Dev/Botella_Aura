import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  brandPalette,
  chooseFontPair,
  chooseLayout,
  contrast,
  CREATIVE_FORMATS,
  creativeInputSchema,
  deepen,
  detailBacked,
  detectCreativeType,
  figuresBacked,
  PAPER,
  textOn,
  TYPE_LAYOUTS,
  type CreativeSpec,
} from '@/lib/creative/spec';
import {
  fitText,
  measure,
  wrap,
  type FontMetrics,
} from '@/lib/creative/text-fit';
import { buildPhotoPrompt, PHOTO_NEGATIVE } from '@/lib/creative/photo-prompt';

/**
 * Marketing creatives: the design is chosen for the content, the brand's
 * colours stay readable, details are never invented, and the type is fitted
 * exactly — then rendered to a real PNG.
 */

const metrics = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'assets', 'fonts', 'metrics.json'),
    'utf8',
  ),
) as FontMetrics;

describe('the design is chosen for the content', () => {
  it('reads the kind of creative from the words', () => {
    expect(
      detectCreativeType(
        'Join us for our Annual Business Summit on November 15',
        false,
      ),
    ).toBe('event');
    expect(detectCreativeType('20% off every bottle this weekend', false)).toBe(
      'offer',
    );
    expect(
      detectCreativeType('Introducing our new single-origin range', false),
    ).toBe('product_launch');
    expect(detectCreativeType('Happy Diwali from all of us', false)).toBe(
      'greeting',
    );
    expect(
      detectCreativeType('5 tips for brewing better coffee at home', false),
    ).toBe('educational');
    expect(detectCreativeType('We help teams ship faster', true)).toBe('b2b');
    expect(detectCreativeType('We help teams ship faster', false)).toBe(
      'brand_awareness',
    );
  });

  it('varies the layout, and only uses the offer badge when there is an offer', () => {
    const picks = new Set(
      [0, 1, 2, 3].map((v) =>
        chooseLayout('promotion', { hasOffer: true, variant: v }),
      ),
    );
    expect(picks.size).toBeGreaterThan(2);
    expect(
      [0, 1, 2].map((v) =>
        chooseLayout('offer', { hasOffer: false, variant: v }),
      ),
    ).not.toContain('offer');
    for (const layouts of Object.values(TYPE_LAYOUTS))
      expect(layouts.length).toBeGreaterThan(1);
  });

  it('matches the typography to the brand’s tone', () => {
    expect(chooseFontPair('event', ['elegant', 'refined'])).toBe('elegant');
    expect(chooseFontPair('promotion', ['bold', 'playful'])).toBe('impact');
    expect(chooseFontPair('b2b', [])).toBe('clean');
    expect(chooseFontPair('event', [])).toBe('modern');
  });

  it('offers the social formats at their real pixel sizes', () => {
    expect(CREATIVE_FORMATS['1:1']).toMatchObject({
      width: 1080,
      height: 1080,
    });
    expect(CREATIVE_FORMATS['4:5']).toMatchObject({
      width: 1080,
      height: 1350,
    });
    expect(CREATIVE_FORMATS['9:16']).toMatchObject({
      width: 1080,
      height: 1920,
    });
    expect(CREATIVE_FORMATS['16:9']).toMatchObject({
      width: 1920,
      height: 1080,
    });
  });
});

describe('the brand’s colours, kept readable', () => {
  it('completes a palette and fills in missing colours', () => {
    const p = brandPalette({ primary: '0e3b43', accent: null });
    expect(p.primary).toBe('#0E3B43');
    expect(p.accent).toMatch(/^#[0-9A-F]{6}$/);
    expect(contrast(p.accent, p.primary)).toBeGreaterThanOrEqual(1.6);
    expect(brandPalette({}).primary).toBe('#14213D');
  });

  it('picks the readable text colour, and deepens a light brand colour until white text passes', () => {
    expect(textOn('#FFFFFF')).not.toBe(PAPER);
    expect(textOn('#0E3B43')).toBe(PAPER);
    expect(contrast(deepen('#7FD3FF'), PAPER)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('details are never invented', () => {
  const request =
    "Create a professional Instagram poster for our company's Annual Business Summit 2026 on November 15.";

  it('a date is kept only as the person gave it', () => {
    expect(detailBacked('November 15', request)).toBe(true);
    expect(detailBacked('November 15, 2026', request)).toBe(true);
    expect(detailBacked('December 3', request)).toBe(false);
    expect(detailBacked('November 16', request)).toBe(false);
  });

  it('a venue or price that was not given is rejected', () => {
    expect(detailBacked('Grand Hyatt, Mumbai', request)).toBe(false);
    expect(detailBacked('Early bird ₹999', request)).toBe(false);
    expect(detailBacked('Annual Business Summit 2026', request)).toBe(true);
  });

  it('a headline may only carry figures the sources contain', () => {
    expect(figuresBacked('Summit 2026', request)).toBe(true);
    expect(figuresBacked('Save 30% today', request)).toBe(false);
    expect(figuresBacked('Meet the team', request)).toBe(true);
  });
});

describe('type is fitted exactly — never cropped', () => {
  const fonts = ['montserrat-800.woff', 'inter-ext-800.woff'];

  it('wraps to the box and reports the size used', () => {
    const f = fitText(metrics, 'ANNUAL BUSINESS SUMMIT 2026', {
      fonts,
      maxWidth: 940,
      maxHeight: 400,
      maxSize: 120,
      minSize: 40,
      lineHeight: 1.04,
    })!;
    expect(f.lines.length).toBeGreaterThan(1);
    for (const l of f.lines)
      expect(measure(metrics, fonts, l, f.size)).toBeLessThanOrEqual(940);
    expect(f.lines.join(' ')).toBe('ANNUAL BUSINESS SUMMIT 2026');
    expect(f.height).toBeLessThanOrEqual(400);
  });

  it('shrinks a long headline rather than overflow, and refuses what cannot fit', () => {
    const long =
      'A considerably longer headline that has to shrink to stay inside its box';
    const big = fitText(metrics, 'Short', {
      fonts,
      maxWidth: 900,
      maxHeight: 300,
      maxSize: 120,
      minSize: 40,
      lineHeight: 1.04,
    })!;
    const small = fitText(metrics, long, {
      fonts,
      maxWidth: 900,
      maxHeight: 300,
      maxSize: 120,
      minSize: 30,
      lineHeight: 1.04,
    })!;
    expect(small.size).toBeLessThan(big.size);
    expect(
      fitText(metrics, 'Supercalifragilisticexpialidociousness', {
        fonts,
        maxWidth: 300,
        maxHeight: 100,
        maxSize: 80,
        minSize: 40,
        lineHeight: 1,
      }),
    ).toBeNull();
    expect(wrap(metrics, fonts, 'one two', 40, 10)).toBeNull();
  });

  it('measures the rupee sign from the extended font', () => {
    expect(
      measure(metrics, ['bebas-neue-400.woff', 'inter-ext-800.woff'], '₹', 100),
    ).toBeLessThan(80);
  });
});

describe('the photograph’s brief', () => {
  const base = {
    type: 'event' as const,
    layout: 'hero' as const,
    aspectRatio: '1:1',
    mood: 'natural' as const,
    business: {
      name: 'Nova',
      industry: 'consulting',
      offerings: null,
      description: null,
    },
    scene: null,
    direction: null,
    consumer: false,
  };

  it('asks for commercial photography, with room for the text and no text in the image', () => {
    const p = buildPhotoPrompt(base);
    expect(p.prompt).toMatch(
      /Professional commercial photograph for Nova, a consulting business/,
    );
    expect(p.prompt).toMatch(/Photorealistic/);
    expect(p.prompt).toMatch(/lower 40% of the frame visually calm/);
    expect(p.prompt).toMatch(/no text, letters, logos/);
    expect(p.negativePrompt).toBe(PHOTO_NEGATIVE);
    expect(PHOTO_NEGATIVE).toMatch(/cartoon/);
  });

  it('a landscape keeps its left half calm; the person’s direction wins', () => {
    expect(buildPhotoPrompt({ ...base, aspectRatio: '16:9' }).prompt).toMatch(
      /left half of the frame calm/,
    );
    const p = buildPhotoPrompt({
      ...base,
      scene: 'a stage.',
      direction: 'a barista pouring latte art.',
    });
    expect(p.prompt).toMatch(/: a barista pouring latte art\. Lighting/);
  });
});

describe('the person’s settings', () => {
  it('defaults to a square creative with a new photo and the logo', () => {
    const i = creativeInputSchema.parse({});
    expect(i).toMatchObject({
      aspectRatio: '1:1',
      photo: 'new',
      showLogo: true,
      colors: {},
    });
    expect(
      creativeInputSchema.parse({ colors: { primary: '0e3b43' } }).colors
        .primary,
    ).toBe('#0E3B43');
    expect(
      creativeInputSchema.safeParse({ colors: { primary: 'blue' } }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rendering (real satori + resvg)
// ---------------------------------------------------------------------------

describe('rendered to a real image', async () => {
  const { renderCreative, CreativeFitError } =
    await import('@/server/media/creative/render');
  const { readImageDimensions } = await import('@/server/media/validate');
  const spec = (over: Partial<CreativeSpec> = {}): CreativeSpec => ({
    version: 1,
    type: 'event',
    layout: 'hero',
    aspectRatio: '1:1',
    fontPair: 'modern',
    mood: 'natural',
    text: {
      eyebrow: null,
      headline: 'Annual Business Summit 2026',
      subheadline: 'Innovate. Connect. Grow.',
      date: 'November 15, 2026',
      time: null,
      venue: null,
      offer: null,
      cta: 'Register now',
      website: null,
    },
    sources: {},
    brand: {
      name: 'Nova',
      colors: brandPalette({ primary: '#0E3B43', accent: '#F2B134' }),
      logoAssetId: null,
      logoUrl: null,
      showLogo: true,
    },
    photo: {
      assetId: null,
      prompt: null,
      direction: null,
      fallback: true,
      fallbackReason: 'test',
    },
    ...over,
  });

  it.each([
    ['hero', '1:1'],
    ['split', '4:5'],
    ['editorial', '9:16'],
    ['spotlight', '16:9'],
  ] as const)(
    '%s at %s is a PNG of exactly that size',
    async (layout, aspectRatio) => {
      const r = await renderCreative(
        spec({
          layout,
          aspectRatio,
          fontPair: layout === 'spotlight' ? 'elegant' : 'clean',
        }),
        { photo: null, logo: null },
      );
      expect(r.png.subarray(1, 4).toString()).toBe('PNG');
      expect(readImageDimensions(r.png, 'image/png')).toEqual({
        width: CREATIVE_FORMATS[aspectRatio].width,
        height: CREATIVE_FORMATS[aspectRatio].height,
      });
    },
    20_000,
  );

  it('a headline that cannot fit is refused with a reason, never cropped', async () => {
    await expect(
      renderCreative(
        spec({
          text: {
            ...spec().text,
            headline: 'Unbelievablyextraordinarilyoverlongsingleword'.repeat(2),
          },
        }),
        { photo: null, logo: null },
      ),
    ).rejects.toBeInstanceOf(CreativeFitError);
  }, 20_000);

  it('the offer layout without an offer becomes the hero layout, and says so', async () => {
    const r = await renderCreative(spec({ layout: 'offer' }), {
      photo: null,
      logo: null,
    });
    expect(r.warnings.join(' ')).toMatch(/offer layout was swapped/);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Copy: what the person gave is used exactly; nothing is invented
// ---------------------------------------------------------------------------

const completeStructured = vi.fn();
let aiConfigured = true;
vi.mock('@/server/ai/claude', () => ({
  completeStructured: (...a: unknown[]) => completeStructured(...a),
  isClaudeConfigured: () => aiConfigured,
  getModel: () => 'test',
}));

describe('the creative’s words', async () => {
  const { writeCopy } =
    await import('@/server/media/creative/creative.service');
  const brand = {
    name: 'Nova Consulting',
    industry: 'consulting',
    description: 'Strategy for mid-sized companies.',
    offerings: null,
    website: null,
    colors: { primary: null, secondary: null, accent: null },
    logoAssetId: null,
    logoUrl: null,
    tone: [],
    consumer: false,
    audience: null,
  };
  const draft = {
    id: 'd1',
    companyId: 'c1',
    type: 'IMAGE_POST',
    platform: 'INSTAGRAM',
    body: {
      caption:
        'Our Annual Business Summit 2026 brings leaders together. Join us on November 15.',
      cta: 'Register today.',
      hashtags: [],
      altText: '',
    },
    aiMetadata: {
      source: {
        brief:
          "Create a poster for our company's Annual Business Summit 2026 on November 15.",
      },
    },
  } as never;

  beforeEach(() => {
    completeStructured.mockReset();
    aiConfigured = true;
  });

  it('an event’s own name leads, the date is the person’s, and invented details are dropped', async () => {
    completeStructured.mockResolvedValue({
      type: 'event',
      eventName: 'Annual Business Summit 2026',
      headline: 'Innovate. Connect. Grow.',
      subheadline: 'A day of strategy.',
      cta: 'Register now',
      date: 'November 15',
      time: '9:00 AM',
      venue: 'Grand Hyatt, Mumbai',
      offer: '50% OFF',
      photoScene: 'a conference hall',
    });
    const r = await writeCopy({
      draft,
      input: creativeInputSchema.parse({}),
      brand,
    });
    expect(r.text.headline).toBe('Annual Business Summit 2026');
    expect(r.sources.headline).toBe('your request');
    expect(r.text.subheadline).toBe('Innovate. Connect. Grow.');
    expect(r.text.date).toBe('November 15');
    expect(r.sources.date).toBe('your request');
    expect(r.text.time).toBeNull();
    expect(r.text.venue).toBeNull();
    expect(r.text.offer).toBeNull();
    expect(r.removed.join(' ')).toMatch(
      /time.*9:00 AM.*venue.*Grand Hyatt.*offer.*50% OFF|venue/,
    );
    expect(r.removed).toHaveLength(3);
  });

  it('a headline with a figure nobody gave is replaced; what the person typed is used exactly', async () => {
    completeStructured.mockResolvedValue({
      type: 'promotion',
      headline: 'Save 40% this week',
      cta: 'Shop now',
    });
    const r = await writeCopy({
      draft,
      input: creativeInputSchema.parse({
        offer: '20% OFF',
        venue: 'Our Bandra studio',
        cta: 'Book a seat',
      }),
      brand,
    });
    expect(r.text.headline).not.toMatch(/40%/);
    expect(r.removed.join(' ')).toMatch(
      /headline with a figure you did not give/,
    );
    expect(r.text).toMatchObject({
      offer: '20% OFF',
      venue: 'Our Bandra studio',
      cta: 'Book a seat',
    });
    expect(r.sources).toMatchObject({ offer: 'you', venue: 'you', cta: 'you' });
  });

  it('when the copy model is unavailable, the words come from the post — still nothing invented', async () => {
    aiConfigured = false;
    const r = await writeCopy({
      draft,
      input: creativeInputSchema.parse({}),
      brand,
    });
    expect(r.ai).toBe(false);
    expect(r.text.headline).toBe(
      'Our Annual Business Summit 2026 brings leaders together',
    );
    expect(r.text.date).toBeNull();
    expect(r.text.cta).toBe('Register now');
  });
});
