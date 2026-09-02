import { describe, it, expect } from 'vitest';

import { buildMediaContent } from '@/server/media/publishers/linkedin-image';

/**
 * The post body LinkedIn receives when a graphic is attached.
 *
 * LinkedIn takes one image and several images through DIFFERENT keys, and
 * rejects an empty `content` object rather than treating it as "no media" — so
 * getting this shape wrong produces either a rejected post or, worse, a post
 * that publishes with the picture silently missing.
 */
describe('buildMediaContent', () => {
  it('returns undefined for a post with no media, so `content` is omitted', () => {
    // Not an empty object: LinkedIn rejects `content: {}`.
    expect(buildMediaContent([])).toBeUndefined();
  });

  it('uses the single-image `media` key for one graphic', () => {
    expect(buildMediaContent([{ urn: 'urn:li:image:A' }])).toEqual({
      media: { id: 'urn:li:image:A' },
    });
  });

  it('uses `multiImage` for several graphics, preserving order', () => {
    const content = buildMediaContent([
      { urn: 'urn:li:image:A' },
      { urn: 'urn:li:image:B' },
      { urn: 'urn:li:image:C' },
    ]) as { multiImage: { images: Array<{ id: string }> } };

    expect(content.multiImage.images.map((i) => i.id)).toEqual([
      'urn:li:image:A',
      'urn:li:image:B',
      'urn:li:image:C',
    ]);
  });

  it('passes alt text through when there is some', () => {
    expect(
      buildMediaContent([{ urn: 'urn:li:image:A', altText: 'A control room' }]),
    ).toEqual({
      media: { id: 'urn:li:image:A', altText: 'A control room' },
    });
  });

  it('omits alt text entirely rather than sending an empty string', () => {
    // LinkedIn treats an empty altText as a value, which is worse for screen
    // readers than having none at all.
    const content = buildMediaContent([
      { urn: 'urn:li:image:A', altText: null },
    ]) as { media: Record<string, unknown> };
    expect('altText' in content.media).toBe(false);
  });
});
