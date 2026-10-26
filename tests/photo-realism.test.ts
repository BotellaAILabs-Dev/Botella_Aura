import { describe, it, expect, vi } from 'vitest';

// image-prompt.service reaches the database on the AI path only.
vi.mock('@/lib/db', () => ({ db: {} }));

import {
  AI_LOOK_NEGATIVE,
  NEGATIVE_MAX,
  PEOPLE_DIRECTION,
  PLATFORM_PHOTO_DIRECTION,
  REALISM_DIRECTION,
  asksForNonPhoto,
  isPhotographic,
  mergeNegative,
  photoNegativeFor,
  shotKindOf,
  withPhotoRealism,
} from '@/lib/photo-realism';
import {
  heuristicPrompt,
  PHOTO_NEGATIVE,
} from '@/server/media/image-prompt.service';
import { STYLE_DIRECTION } from '@/server/media/types';
import {
  buildPhotoPrompt,
  PHOTO_NEGATIVE as CREATIVE_NEGATIVE,
} from '@/lib/creative/photo-prompt';
import { VISUAL_RULES } from '@/lib/visual-brief';
import { SOCIAL_PLATFORMS } from '@/lib/platforms';

/**
 * Content Studio's images should read as real marketing photographs — natural
 * light, real textures, authentic people and products — not as AI art. These
 * pin the photographic brief on every image path.
 */

describe('styles', () => {
  it('the default style is a photograph, with no graphic overlays', () => {
    expect(isPhotographic('professional')).toBe(true);
    expect(isPhotographic('photo')).toBe(true);
    expect(isPhotographic('cinematic')).toBe(true);
    expect(isPhotographic('illustration')).toBe(false);
    expect(isPhotographic('3d')).toBe(false);
    // "clean vector accents" on a photo is what made results look generated.
    expect(STYLE_DIRECTION.professional).not.toMatch(/vector accents/);
    expect(STYLE_DIRECTION.professional).toMatch(/photograph/i);
  });

  it('every network has a photographic register', () => {
    for (const p of SOCIAL_PLATFORMS) {
      expect(PLATFORM_PHOTO_DIRECTION[p]).toMatch(/photograph/i);
    }
  });

  it('people are allowed — anonymous, never identifiable', () => {
    expect(VISUAL_RULES.join(' ')).not.toMatch(/No real people/);
    expect(VISUAL_RULES.join(' ')).toMatch(/identifiable public figures/);
    expect(PEOPLE_DIRECTION).toMatch(/candid/);
  });
});

describe('Graphic Studio prompt without an AI provider', () => {
  const instagram = PLATFORM_PHOTO_DIRECTION.INSTAGRAM;

  it('briefs a real photograph of a real moment, not a metaphor', () => {
    const r = heuristicPrompt(
      'Our new single-origin espresso is here.',
      instagram,
      STYLE_DIRECTION.professional,
    );
    expect(r.prompt).toMatch(/real, professional marketing photograph/);
    expect(r.prompt).toMatch(/not a metaphor/);
    expect(r.prompt).toContain(REALISM_DIRECTION);
    expect(r.prompt).toContain(instagram);
    expect(r.prompt).toMatch(/Shot on a full-frame camera/);
    expect(r.negativePrompt).toMatch(/AI-generated look/);
    expect(r.negativePrompt).toMatch(/plastic or waxy skin/);
    expect(r.negativePrompt.length).toBeLessThanOrEqual(400);
  });

  it('keeps the no-text rule even when the direction is very long', () => {
    const r = heuristicPrompt(
      'A post.',
      instagram,
      STYLE_DIRECTION.photo,
      'a barista at the counter, '.repeat(60),
    );
    expect(r.prompt.length).toBeLessThanOrEqual(1500);
    expect(r.prompt.toLowerCase()).toContain('no lettering');
  });

  it('a non-photographic style keeps the graphic brief', () => {
    const r = heuristicPrompt(
      'A post about pricing.',
      'Linkedin direction.',
      STYLE_DIRECTION.illustration,
      undefined,
      undefined,
      { photographic: false },
    );
    expect(r.prompt).toMatch(/premium social-media graphic/);
    expect(r.negativePrompt).not.toMatch(/AI-generated look/);
  });

  // This replaces a test that asserted the OLD order — the full no-text list
  // first, then whatever fitted. It passed while the terms that actually
  // matter were being dropped: the list is capped at NEGATIVE_MAX, the text
  // terms filled it, and "distorted hands", "extra fingers", "deformed faces"
  // and "posed stock smiles" never reached a single image model. That is why
  // photographs without people looked real and photographs with people did
  // not. "name badges" is no longer asserted because it is now what gets
  // dropped instead — a correct trade, and the one the old test prevented.
  it('the photo negative prompt keeps the terms that matter for the shot', () => {
    const people = photoNegativeFor('people');
    expect(people.startsWith('text, letters')).toBe(true);
    expect(people).toMatch(/AI-generated look/);
    for (const term of [
      'distorted hands',
      'extra fingers',
      'deformed faces',
      'posed stock smiles',
      'plastic or waxy skin',
    ]) {
      expect(people).toContain(term);
    }

    // A product shot spends the same budget on its own failures instead.
    const product = photoNegativeFor('product');
    expect(product).toContain('warped products');
    expect(product).toContain('impossible reflections');
  });

  it('every shot kind fits the stored limit', () => {
    for (const kind of ['people', 'product', 'place', 'event'] as const) {
      const n = photoNegativeFor(kind);
      expect(n.length).toBeLessThanOrEqual(NEGATIVE_MAX);
      // Whole terms only — never a fragment cut mid-word.
      expect(n.endsWith(',')).toBe(false);
      expect(n.split(', ').pop()!.length).toBeGreaterThan(2);
    }
  });

  it('briefs the people failures only when there are people in frame', () => {
    expect(withPhotoRealism('two colleagues reviewing a plan').prompt).toContain(
      'Real photographed people',
    );
    expect(
      withPhotoRealism('a bottle on a styled surface').prompt,
    ).not.toContain('Real photographed people');
  });
});

describe('marketing creative photo', () => {
  const base = {
    type: 'promotion' as const,
    layout: 'hero' as const,
    aspectRatio: '1:1',
    mood: 'natural' as const,
    business: {
      name: 'Nova',
      industry: 'cafe',
      offerings: 'coffee',
      description: null,
    },
    scene: null,
    direction: null,
    consumer: true,
  };

  it('carries the realism and people direction', () => {
    const p = buildPhotoPrompt(base);
    expect(p.prompt).toContain(REALISM_DIRECTION);
    expect(p.prompt).toContain(PEOPLE_DIRECTION);
    expect(p.negativePrompt).toMatch(/AI-generated look/);
  });

  it('a long scene never pushes out where the text goes or the no-text rule', () => {
    const p = buildPhotoPrompt({
      ...base,
      direction: 'a busy cafe counter. '.repeat(80),
    });
    expect(p.prompt.length).toBeLessThanOrEqual(1500);
    expect(p.prompt).toMatch(/lower 40% of the frame visually calm/);
    expect(p.prompt).toMatch(/Absolutely no text, letters, logos/);
  });
});

describe('free-text image generator', () => {
  it('keeps the person’s words first and makes it photographic', () => {
    const r = withPhotoRealism('A barista pouring latte art in a small cafe');
    expect(
      r.prompt.startsWith('A barista pouring latte art in a small cafe.'),
    ).toBe(true);
    expect(r.prompt).toContain(REALISM_DIRECTION);
    expect(r.prompt).toMatch(/50mm lens/);
    expect(r.negativePrompt).toMatch(/AI-generated look/);
  });

  it('leaves a prompt that asks for another style exactly as written', () => {
    for (const p of [
      'A flat vector illustration of a coffee cup',
      'Cartoon mascot waving',
      'Isometric 3D render of an office',
    ]) {
      expect(asksForNonPhoto(p)).toBe(true);
      expect(withPhotoRealism(p)).toEqual({ prompt: p, negativePrompt: null });
    }
  });

  it('picks the lens for the shot', () => {
    expect(shotKindOf('a hero shot of the bottle on a marble shelf')).toBe(
      'product',
    );
    expect(shotKindOf('the summit stage with an audience')).toBe('event');
    expect(shotKindOf('our storefront at dusk')).toBe('place');
    expect(shotKindOf('two colleagues reviewing a plan')).toBe('people');
  });
});

describe('negative prompts', () => {
  it('every one fits what the image pipeline stores, in whole terms', () => {
    const whole = new Set(
      `${AI_LOOK_NEGATIVE},text,letters,drawing,name badges`
        .split(',')
        .map((t) => t.trim()),
    );
    for (const n of [
      PHOTO_NEGATIVE,
      CREATIVE_NEGATIVE,
      withPhotoRealism('a cafe').negativePrompt!,
    ]) {
      expect(n.length).toBeLessThanOrEqual(NEGATIVE_MAX);
      expect(n).toMatch(/^text, letters/);
      // The last term is a complete one, not a cut-off fragment.
      const last = n.split(', ').pop()!;
      expect(n.includes(last) && last.length > 2).toBe(true);
    }
    expect(whole.size).toBeGreaterThan(5);
  });

  it('merging keeps order, drops repeats, and skips what does not fit', () => {
    expect(mergeNegative('a, b', 'B, c')).toBe('a, b, c');
    const long = 'x'.repeat(390);
    expect(mergeNegative(long, 'too long a term', 'ok')).toBe(`${long}, ok`);
  });
});

describe('long prompts', () => {
  it('Graphic Studio: whole sentences only, realism and people always kept', () => {
    const r = heuristicPrompt(
      'We built our AI to stop before it acts. On purpose.',
      PLATFORM_PHOTO_DIRECTION.LINKEDIN,
      STYLE_DIRECTION.professional,
      'a small marketing team reviewing a draft on a laptop, '.repeat(20),
    );
    expect(r.prompt.length).toBeLessThanOrEqual(1500);
    expect(r.prompt).not.toMatch(/\.\./);
    expect(r.prompt).toContain(REALISM_DIRECTION);
    expect(r.prompt).toContain(PEOPLE_DIRECTION);
    expect(r.prompt).toMatch(/One coherent photograph, not a collage\.$/);
    // The person's direction is kept, clipped.
    expect(r.prompt).toMatch(/Additional direction: a small marketing team/);
  });

  it('creative: a long scene is clipped, the rest kept whole', () => {
    const p = buildPhotoPrompt({
      type: 'promotion',
      layout: 'hero',
      aspectRatio: '1:1',
      mood: 'natural',
      business: {
        name: 'Nova',
        industry: 'cafe',
        offerings: null,
        description: null,
      },
      scene: null,
      direction: 'a busy cafe counter with regulars chatting. '.repeat(40),
      consumer: true,
    });
    expect(p.prompt.length).toBeLessThanOrEqual(1500);
    expect(p.prompt).toContain(REALISM_DIRECTION);
    expect(p.prompt).toMatch(
      /Absolutely no text, letters, logos, signage or watermarks anywhere in the image\.$/,
    );
  });
});

describe('subject punctuation', () => {
  it('drops a trailing full stop once, and keeps a trailing letter s', () => {
    const r = heuristicPrompt(
      'Fresh pastries every morning for our regulars',
      PLATFORM_PHOTO_DIRECTION.FACEBOOK,
      STYLE_DIRECTION.photo,
    );
    expect(r.prompt).toContain(
      'post about: Fresh pastries every morning for our regulars. Show',
    );
    const s = heuristicPrompt(
      'Big news.',
      PLATFORM_PHOTO_DIRECTION.X,
      STYLE_DIRECTION.photo,
    );
    expect(s.prompt).not.toMatch(/\.\./);
  });
});

describe('briefs saved before people were allowed', () => {
  it('use the rules in force now', async () => {
    const { visualBriefToPrompt } = await import('@/lib/visual-brief');
    const old = {
      version: 1,
      need: 'required',
      why: 'x',
      count: { min: 1, max: 1 },
      subject: { value: 'Fresh beans', source: 'post' },
      product: null,
      audience: null,
      setting: 'A real setting.',
      brand: { palette: [], mood: [], avoid: [], hasLogo: false },
      format: {
        aspectRatio: '1:1',
        width: 1080,
        height: 1080,
        channel: null,
        artDirection: null,
      },
      rules: ['No real people, recognisable faces or other brands’ marks.'],
      missing: [],
    } as unknown as Parameters<typeof visualBriefToPrompt>[0];
    const p = visualBriefToPrompt(old);
    expect(p).not.toMatch(/No real people/);
    expect(p).toMatch(/identifiable public figures/);
  });
});
