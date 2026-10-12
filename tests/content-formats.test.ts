import { describe, it, expect } from 'vitest';

import {
  CONTENT_TYPES,
  bodySchemaFor,
  imagePostSchema,
  type ContentTypeKey,
} from '@/lib/validations/content';
import { CONTENT_TYPE_LABELS } from '@/lib/content-ui';
import {
  contentFormatsSchema,
  recommendedFormatsFor,
  resolveEnabledFormats,
} from '@/lib/validations/profile';
import {
  defaultPlatformFor,
  platformsForType,
  platformSpec,
  resolvePlatform,
} from '@/lib/platforms';
import { renderForManual } from '@/server/content/render';

/**
 * The single-image post, and the per-workspace format list that decides which
 * formats are offered at all.
 */

describe('IMAGE_POST — the single-image format', () => {
  it('is a real content type with a schema, a label and a platform', () => {
    expect(CONTENT_TYPES).toContain('IMAGE_POST');
    expect(CONTENT_TYPE_LABELS.IMAGE_POST).toBe('Single image post');
    expect(bodySchemaFor('IMAGE_POST')).toBe(imagePostSchema);
    expect(defaultPlatformFor('IMAGE_POST')).toBe('INSTAGRAM');
  });

  it('accepts a caption-only body and defaults the rest', () => {
    const parsed = imagePostSchema.parse({ caption: 'One bottle, one story.' });
    expect(parsed.caption).toBe('One bottle, one story.');
    expect(parsed.hashtags).toEqual([]);
    expect(parsed.altText).toBe('');
  });

  it('is offered on every network, which is the point of the format', () => {
    const platforms = platformsForType('IMAGE_POST');
    expect(platforms).toEqual(
      expect.arrayContaining(['INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'X']),
    );
  });

  it('renders to caption plus hashtags for manual posting', () => {
    const text = renderForManual({
      type: 'IMAGE_POST',
      body: { caption: 'Late harvest, early release.', hashtags: ['bourbon'], altText: '' },
      // The renderer only reads type and body.
    } as never);
    expect(text).toContain('Late harvest, early release.');
    expect(text).toContain('#bourbon');
  });

  it('every platform it offers can actually draw the ratio it defaults to', () => {
    for (const platform of platformsForType('IMAGE_POST')) {
      const spec = platformSpec(platform);
      expect(spec.ratios).toContain(spec.defaultRatio);
    }
  });
});

describe('every content type stays wired end to end', () => {
  it.each(CONTENT_TYPES)('%s has a schema, label and platform list', (type) => {
    expect(bodySchemaFor(type as ContentTypeKey)).toBeDefined();
    expect(CONTENT_TYPE_LABELS[type as ContentTypeKey]).toBeTruthy();
    const platforms = platformsForType(type as ContentTypeKey);
    // Email, campaign copy and promotional copy are never aimed at a network
    // (copied out to another tool); every other type is.
    if (['EMAIL', 'CAMPAIGN_COPY', 'PROMO'].includes(type)) {
      expect(platforms).toEqual([]);
      return;
    }
    expect(platforms.length).toBeGreaterThan(0);
    // The default must be one of the offered destinations, or the composer
    // would open on a platform the user cannot then re-select.
    expect(platforms).toContain(defaultPlatformFor(type as ContentTypeKey));
    expect(resolvePlatform(type as ContentTypeKey, null)).toBe(
      defaultPlatformFor(type as ContentTypeKey),
    );
  });
});

describe('workspace format preferences', () => {
  it('treats an empty list as "all formats", so existing workspaces are unchanged', () => {
    expect(resolveEnabledFormats(null)).toEqual([...CONTENT_TYPES]);
    expect(resolveEnabledFormats({ enabled: [] })).toEqual([...CONTENT_TYPES]);
  });

  it('honours an explicit narrowing', () => {
    expect(resolveEnabledFormats({ enabled: ['IMAGE_POST', 'CAROUSEL'] })).toEqual([
      'IMAGE_POST',
      'CAROUSEL',
    ]);
  });

  it('recommends visual formats for B2C and written ones for B2B', () => {
    const b2c = recommendedFormatsFor('B2C');
    const b2b = recommendedFormatsFor('B2B');

    // The client's actual point: a blog draft is not a B2C format.
    expect(b2c).not.toContain('BLOG');
    expect(b2c).not.toContain('LINKEDIN_POST');
    expect(b2c).toContain('IMAGE_POST');

    expect(b2b).toContain('BLOG');
    expect(b2b).toContain('LINKEDIN_POST');
  });

  it('recommends everything when no market has been chosen', () => {
    expect(recommendedFormatsFor(undefined)).toEqual([...CONTENT_TYPES]);
  });

  it('rejects a format that is not a real content type', () => {
    const parsed = contentFormatsSchema.safeParse({ enabled: ['PODCAST'] });
    expect(parsed.success).toBe(false);
  });

  it('every recommendation is a real, offerable format', () => {
    for (const mode of ['B2C', 'B2B', undefined] as const) {
      for (const type of recommendedFormatsFor(mode)) {
        expect(CONTENT_TYPES).toContain(type);
      }
    }
  });
});
