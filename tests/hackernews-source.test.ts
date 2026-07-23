import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Hacker News connector test with the HTTP layer mocked (no network). Verifies
 * keyword filtering, normalization to TrendItem, and the item-id shape.
 */
vi.mock('@/lib/http', () => ({ getJson: vi.fn() }));

import { getJson } from '@/lib/http';
import { HackerNewsSource } from '@/server/trends/sources/hackernews';
import type { TrendFetchContext } from '@/server/trends/types';

const mockGetJson = vi.mocked(getJson);

const ctx: TrendFetchContext = {
  keywords: ['ai', 'saas', 'marketing'],
  subreddits: [],
  rssFeeds: [],
  competitorNames: [],
};

const STORIES: Record<number, { id: number; title: string; url?: string; score?: number; descendants?: number; by?: string; time?: number }> = {
  1: { id: 1, title: 'AI breakthrough for SaaS teams', url: 'https://a.com', score: 100, descendants: 20, by: 'alice', time: 1_760_000_000 },
  2: { id: 2, title: 'Best sourdough recipes', score: 50, time: 1_760_000_000 },
  3: { id: 3, title: 'Marketing automation tips', url: 'https://c.com', score: 75, descendants: 10, by: 'carol', time: 1_760_000_000 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetJson.mockImplementation(async (url: string) => {
    if (url.includes('topstories.json')) return [1, 2, 3] as unknown as never;
    const m = url.match(/item\/(\d+)\.json/);
    if (m) return STORIES[Number(m[1])] as unknown as never;
    throw new Error(`unexpected url ${url}`);
  });
});

describe('HackerNewsSource', () => {
  it('is always configured (keyless public API)', () => {
    expect(new HackerNewsSource().isConfigured()).toBe(true);
  });

  it('keeps only stories matching a configured keyword', async () => {
    const items = await new HackerNewsSource().fetchTrendItems(ctx);
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(['hackernews:1', 'hackernews:3']);
    expect(items.find((i) => i.title.includes('sourdough'))).toBeUndefined();
  });

  it('normalizes fields into the TrendItem shape', async () => {
    const items = await new HackerNewsSource().fetchTrendItems(ctx);
    const item = items.find((i) => i.id === 'hackernews:1')!;
    expect(item.source).toBe('hackernews');
    expect(item.url).toBe('https://a.com');
    expect(item.engagement).toEqual({ points: 100, comments: 20 });
    expect(item.matchedKeywords).toEqual(expect.arrayContaining(['ai', 'saas']));
    expect(typeof item.publishedAt).toBe('string');
  });

  it('returns nothing when no keywords are configured', async () => {
    const items = await new HackerNewsSource().fetchTrendItems({
      ...ctx,
      keywords: [],
    });
    expect(items).toEqual([]);
  });
});
