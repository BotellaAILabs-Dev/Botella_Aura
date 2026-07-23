import { describe, it, expect } from 'vitest';
import {
  linkedInPostSchema,
  carouselSchema,
  threadSchema,
  blogSchema,
  bodySchemaFor,
} from '@/lib/validations/content';

/**
 * Structured-output schema tests — these are the contracts Claude generation is
 * validated against (NON-NEGOTIABLE #4). If these drift, malformed content
 * could slip through, so the constraints are pinned here.
 */

describe('linkedInPostSchema', () => {
  it('accepts a valid post (3-5 paragraphs)', () => {
    const r = linkedInPostSchema.safeParse({
      hook: 'Stop guessing at pricing.',
      paragraphs: ['First.', 'Second.', 'Third.'],
      hashtags: ['SaaS', 'pricing'],
    });
    expect(r.success).toBe(true);
  });
  it('rejects fewer than 3 paragraphs', () => {
    expect(
      linkedInPostSchema.safeParse({ hook: 'x', paragraphs: ['one', 'two'] }).success,
    ).toBe(false);
  });
  it('rejects more than 5 paragraphs', () => {
    expect(
      linkedInPostSchema.safeParse({
        hook: 'x',
        paragraphs: ['1', '2', '3', '4', '5', '6'],
      }).success,
    ).toBe(false);
  });
  it('defaults hashtags to an empty array', () => {
    const r = linkedInPostSchema.parse({ hook: 'x', paragraphs: ['a', 'b', 'c'] });
    expect(r.hashtags).toEqual([]);
  });
});

describe('carouselSchema', () => {
  const slides = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ headline: `H${i}`, body: 'b' }));
  it('accepts 5-8 slides', () => {
    expect(carouselSchema.safeParse({ title: 'T', slides: slides(5) }).success).toBe(true);
    expect(carouselSchema.safeParse({ title: 'T', slides: slides(8) }).success).toBe(true);
  });
  it('rejects fewer than 5 or more than 8 slides', () => {
    expect(carouselSchema.safeParse({ title: 'T', slides: slides(4) }).success).toBe(false);
    expect(carouselSchema.safeParse({ title: 'T', slides: slides(9) }).success).toBe(false);
  });
});

describe('threadSchema', () => {
  it('rejects a tweet over 280 chars', () => {
    expect(threadSchema.safeParse({ tweets: ['a'.repeat(281), 'ok'] }).success).toBe(false);
  });
  it('accepts a 2-12 tweet thread', () => {
    expect(threadSchema.safeParse({ tweets: ['hook', 'point'] }).success).toBe(true);
  });
});

describe('blogSchema', () => {
  it('requires at least 2 sections', () => {
    expect(
      blogSchema.safeParse({ headline: 'H', sections: [{ heading: 'A', body: 'x' }] }).success,
    ).toBe(false);
    expect(
      blogSchema.safeParse({
        headline: 'H',
        sections: [
          { heading: 'A', body: 'x' },
          { heading: 'B', body: 'y' },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('bodySchemaFor', () => {
  it('maps each content type to its schema', () => {
    expect(bodySchemaFor('LINKEDIN_POST')).toBe(linkedInPostSchema);
    expect(bodySchemaFor('CAROUSEL')).toBe(carouselSchema);
    expect(bodySchemaFor('TWEET_THREAD')).toBe(threadSchema);
    expect(bodySchemaFor('BLOG')).toBe(blogSchema);
  });
});
