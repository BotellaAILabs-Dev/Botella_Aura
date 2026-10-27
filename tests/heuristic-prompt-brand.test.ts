import { describe, expect, it } from 'vitest';

import { heuristicPrompt } from '@/server/media/image-prompt.service';
import { PLATFORM_PHOTO_DIRECTION } from '@/lib/photo-realism';
import { STYLE_DIRECTION } from '@/server/media/types';

/**
 * What survives the 1,500-character prompt budget when the art director is
 * down and the deterministic composer takes over.
 *
 * The budget drops whole parts that do not fit, and the parts it drops are the
 * optional ones — which is where the brand's palette, the things it will not
 * show, and the product live. Nothing errors when one goes: the prompt reads
 * perfectly well without it, and the image comes back in the wrong colours.
 *
 * The realism direction in the required block has grown before and will grow
 * again, so these assert the brand's own instructions still reach the model
 * rather than asserting a character count.
 */
const BRIEF = {
  version: 1,
  need: 'required',
  why: 'x',
  count: { min: 1, max: 1 },
  subject: {
    value: 'Compete on value and outcome, not on matching their price',
    source: 'recommendation',
  },
  product: { value: 'single-origin filter coffee', source: 'business' },
  audience: null,
  setting: 'A real cafe counter in morning light.',
  brand: {
    palette: ['#6b3e26', '#d9c3a5'],
    mood: ['warm'],
    avoid: ['stock-looking handshakes'],
    hasLogo: false,
  },
  format: {
    aspectRatio: '1:1',
    width: 1080,
    height: 1080,
    channel: null,
    artDirection: null,
  },
  rules: ['No identifiable public figures.'],
  missing: [],
} as unknown as Parameters<typeof heuristicPrompt>[4];

const POST =
  'Compete on value and outcome, not on matching their price. Here is how we think about it.';

describe('the heuristic photo prompt keeps the brand in frame', () => {
  it('carries the palette', () => {
    const r = heuristicPrompt(
      POST,
      PLATFORM_PHOTO_DIRECTION.INSTAGRAM,
      STYLE_DIRECTION.professional,
      undefined,
      BRIEF,
    );

    expect(r.prompt.toLowerCase()).toContain('#6b3e26');
    expect(r.source).toBe('heuristic');
  });

  it('takes its subject from the brief, not the post', () => {
    const r = heuristicPrompt(
      'An unrelated opening line that is not the brief.',
      PLATFORM_PHOTO_DIRECTION.INSTAGRAM,
      STYLE_DIRECTION.professional,
      undefined,
      BRIEF,
    );

    expect(r.subject).toBe(
      'Compete on value and outcome, not on matching their price',
    );
  });

  it('carries what the brand will not show, and the product', () => {
    const r = heuristicPrompt(
      POST,
      PLATFORM_PHOTO_DIRECTION.INSTAGRAM,
      STYLE_DIRECTION.professional,
      undefined,
      BRIEF,
    );

    expect(r.prompt).toMatch(/stock-looking handshakes/);
    expect(r.prompt).toMatch(/single-origin filter coffee/);
  });

  /**
   * The person's own direction outranks everything optional, so a long one is
   * allowed to crowd the palette out — but the hard rules never go, and the
   * prompt must still fit what the schema accepts.
   */
  it('stays inside the budget with a long direction, keeping the hard rules', () => {
    const r = heuristicPrompt(
      POST,
      PLATFORM_PHOTO_DIRECTION.INSTAGRAM,
      STYLE_DIRECTION.professional,
      'x'.repeat(900),
      BRIEF,
    );

    expect(r.prompt.length).toBeLessThanOrEqual(1500);
    expect(r.prompt).toMatch(/No lettering, words, logos or watermarks/);
  });

  it('keeps every platform under the budget with the brand present', () => {
    for (const [platform, direction] of Object.entries(
      PLATFORM_PHOTO_DIRECTION,
    )) {
      const r = heuristicPrompt(
        POST,
        direction,
        STYLE_DIRECTION.professional,
        undefined,
        BRIEF,
      );
      expect(r.prompt.length, platform).toBeLessThanOrEqual(1500);
      expect(r.prompt.toLowerCase(), platform).toContain('#6b3e26');
    }
  });
});
