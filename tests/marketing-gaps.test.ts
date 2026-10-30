import { describe, expect, it } from 'vitest';

import {
  findMarketingGaps,
  gapHref,
  sinceWords,
  type GapInput,
  type GapPost,
} from '@/lib/marketing-gaps';
import type { Product } from '@/lib/products';
import { postChannel } from '@/server/intelligence/marketing-gaps.service';

/**
 * Marketing gaps a business owner can act on: named in their own products and
 * channels, each with the evidence behind it and the post that closes it.
 */

const NOW = new Date('2026-10-30T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const product = (over: Partial<Product>): Product => ({
  id: 'p1',
  name: 'Gift box',
  description: null,
  audience: null,
  benefit: null,
  price: null,
  url: null,
  featured: false,
  ...over,
});

let n = 0;
const post = (over: Partial<GapPost> = {}): GapPost => ({
  id: `d${++n}`,
  title: 'A post',
  text: 'Something about coffee.',
  type: 'LINKEDIN_POST',
  channel: 'LinkedIn',
  publishedAt: daysAgo(3),
  engagement: null,
  ...over,
});

const input = (over: Partial<GapInput> = {}): GapInput => ({
  now: NOW,
  products: [],
  preferredChannels: [],
  enabledFormats: [],
  posts: [post()],
  ...over,
});

const kinds = (i: GapInput) => findMarketingGaps(i).map((g) => g.kind);

describe('marketing gaps', () => {
  it('says plainly when nothing has been published, and suggests the first post', () => {
    const [gap] = findMarketingGaps(input({ posts: [], products: [product({ audience: 'coffee lovers' })] }));
    expect(gap!.kind).toBe('no_posts');
    expect(gap!.action.brief).toBe('An introduction to Gift box for coffee lovers');
  });

  it('names a product that has not been posted about for months', () => {
    const gaps = findMarketingGaps(
      input({
        products: [product({ featured: true })],
        posts: [post({ title: 'Diwali gifts', text: 'Our Gift box is back.', publishedAt: daysAgo(125) }), post()],
      }),
    );
    const gap = gaps.find((g) => g.kind === 'product_silent')!;
    expect(gap.title).toBe("You haven't posted about Gift box in 4 months.");
    expect(gap.severity).toBe('high');
    expect(gap.evidence).toMatch(/Diwali gifts/);
  });

  it('names a product never posted about', () => {
    const gaps = findMarketingGaps(input({ products: [product({ benefit: 'ships wrapped' })] }));
    expect(gaps[0]!.title).toBe("You haven't posted about Gift box yet.");
    expect(gaps[0]!.action.brief).toBe('A post about Gift box — why people choose it: ships wrapped');
  });

  it('does not flag a product posted about recently', () => {
    expect(kinds(input({ products: [product({})], posts: [post({ text: 'New gift box!' })] }))).toEqual([]);
  });

  it('flags a channel the business publishes on that has gone quiet', () => {
    const gaps = findMarketingGaps(
      input({
        preferredChannels: ['LinkedIn', 'Instagram'],
        posts: [post(), post({ channel: 'Instagram', type: 'IMAGE_POST', publishedAt: daysAgo(45) })],
      }),
    );
    expect(gaps.map((g) => g.title)).toEqual(['Nothing on Instagram in 6 weeks.']);
    expect(gaps[0]!.action.type).toBe('IMAGE_POST');
  });

  it('flags a channel never published to', () => {
    const [gap] = findMarketingGaps(input({ preferredChannels: ['Blog'] }));
    expect(gap!.title).toMatch(/You publish on Blog, but nothing has gone out there/);
  });

  it('does not suggest a format the business has switched off', () => {
    const [gap] = findMarketingGaps(input({ preferredChannels: ['Blog'], enabledFormats: ['LINKEDIN_POST'] }));
    expect(gap!.action.type).toBeNull();
  });

  it('notices posting has slowed to half or less', () => {
    const prior = Array.from({ length: 6 }, (_, i) => post({ publishedAt: daysAgo(35 + i) }));
    const gap = findMarketingGaps(input({ posts: [post(), ...prior] })).find((g) => g.kind === 'cadence_drop')!;
    expect(gap.title).toBe('You posted 1 time in the last 30 days, down from 6.');
  });

  it('ignores a slow-down from a handful of posts', () => {
    const prior = Array.from({ length: 3 }, (_, i) => post({ publishedAt: daysAgo(35 + i) }));
    expect(kinds(input({ posts: prior }))).not.toContain('cadence_drop');
  });

  it('spots being stuck in one format, and suggests another that is enabled', () => {
    const posts = Array.from({ length: 10 }, (_, i) => post({ publishedAt: daysAgo(i) }));
    const gap = findMarketingGaps(input({ posts, enabledFormats: ['LINKEDIN_POST', 'IMAGE_POST'] })).find(
      (g) => g.kind === 'format_rut',
    )!;
    expect(gap.title).toBe('10 of your last 10 posts were LinkedIn posts.');
    expect(gap.action.type).toBe('IMAGE_POST');
  });

  it('finds a format that performs better but is rarely used', () => {
    const posts = [
      ...Array.from({ length: 8 }, (_, i) => post({ engagement: 10, publishedAt: daysAgo(i) })),
      post({ type: 'CAROUSEL', engagement: 40, publishedAt: daysAgo(9) }),
      post({ type: 'CAROUSEL', engagement: 30, publishedAt: daysAgo(10) }),
    ];
    const gap = findMarketingGaps(input({ posts })).find((g) => g.kind === 'format_underused')!;
    expect(gap.title).toBe('Carousels get 3.5× the engagement of your other posts, but are only 20% of what you publish.');
  });

  it('does not judge performance on too few measured posts', () => {
    const posts = [post({ engagement: 1 }), post({ type: 'CAROUSEL', engagement: 50 }), post({ type: 'CAROUSEL', engagement: 50 })];
    expect(kinds(input({ posts }))).not.toContain('format_underused');
  });

  it('puts what to fix first at the top, and opens Content Studio with the brief', () => {
    const gaps = findMarketingGaps(
      input({
        preferredChannels: ['Blog'],
        products: [product({ id: 'a', name: 'Office plan', featured: true })],
      }),
    );
    expect(gaps[0]!.severity).toBe('high');
    expect(gapHref(gaps[1]!)).toBe('/dashboard/content/new?brief=A+Blog+post+on+what%27s+new+with+us+this+month&type=BLOG');
  });
});

describe('helpers', () => {
  it('says durations the way a person would', () => {
    expect(sinceWords(1)).toBe('1 day');
    expect(sinceWords(21)).toBe('3 weeks');
    expect(sinceWords(125)).toBe('4 months');
    expect(sinceWords(400)).toBe('over a year');
  });

  it('works out where a post went', () => {
    expect(postChannel('INSTAGRAM', 'IMAGE_POST')).toBe('Instagram');
    expect(postChannel(null, 'BLOG')).toBe('Blog');
    expect(postChannel('FACEBOOK', 'IMAGE_POST')).toBeNull();
    expect(postChannel(null, 'AD')).toBeNull();
  });
});
