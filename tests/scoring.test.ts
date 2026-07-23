import { describe, it, expect } from 'vitest';
import { scoreItem, scoreAndRank, dedupe } from '@/server/trends/scoring';
import type { TrendFetchContext, TrendItem } from '@/server/trends/types';

const NOW = Date.parse('2026-07-23T12:00:00Z');

const ctx: TrendFetchContext = {
  keywords: ['ai', 'saas', 'marketing'],
  subreddits: [],
  rssFeeds: [],
  competitorNames: ['Acme'],
};

function item(overrides: Partial<TrendItem>): TrendItem {
  return {
    id: overrides.id ?? `hackernews:${Math.random()}`,
    source: 'hackernews',
    sourceLabel: 'Hacker News',
    title: 'A story about AI',
    url: 'https://example.com',
    publishedAt: new Date(NOW - 60 * 60 * 1000).toISOString(), // 1h old
    engagement: {},
    matchedKeywords: ['ai'],
    ...overrides,
  };
}

describe('scoreItem', () => {
  it('returns a 0–100 score with a per-signal breakdown', () => {
    const scored = scoreItem(item({}), ctx, NOW);
    expect(scored.score).toBeGreaterThan(0);
    expect(scored.score).toBeLessThanOrEqual(100);
    expect(scored.scoreBreakdown).toHaveProperty('recency');
    expect(scored.scoreBreakdown).toHaveProperty('engagement');
    expect(scored.scoreBreakdown).toHaveProperty('relevance');
  });

  it('ranks a fresher item above an identical older one', () => {
    const fresh = scoreItem(
      item({ publishedAt: new Date(NOW - 60 * 60 * 1000).toISOString() }),
      ctx,
      NOW,
    );
    const old = scoreItem(
      item({ publishedAt: new Date(NOW - 72 * 60 * 60 * 1000).toISOString() }),
      ctx,
      NOW,
    );
    expect(fresh.score).toBeGreaterThan(old.score);
  });

  it('ranks a high-engagement item above a low-engagement one', () => {
    const hot = scoreItem(item({ engagement: { points: 400, comments: 120 } }), ctx, NOW);
    const cold = scoreItem(item({ engagement: { points: 1 } }), ctx, NOW);
    expect(hot.score).toBeGreaterThan(cold.score);
  });

  it('boosts relevance for more keyword matches', () => {
    const many = scoreItem(item({ matchedKeywords: ['ai', 'saas', 'marketing'] }), ctx, NOW);
    const few = scoreItem(item({ matchedKeywords: ['ai'] }), ctx, NOW);
    expect(many.scoreBreakdown.relevance).toBeGreaterThan(
      few.scoreBreakdown.relevance,
    );
  });

  it('boosts items that mention a tracked competitor', () => {
    const withComp = scoreItem(
      item({ title: 'Acme launches a new AI tool', matchedKeywords: ['ai'] }),
      ctx,
      NOW,
    );
    const without = scoreItem(
      item({ title: 'Some AI tool launches', matchedKeywords: ['ai'] }),
      ctx,
      NOW,
    );
    expect(withComp.scoreBreakdown.relevance).toBeGreaterThan(
      without.scoreBreakdown.relevance,
    );
  });
});

describe('dedupe', () => {
  it('removes items with duplicate ids and duplicate titles', () => {
    const items = [
      item({ id: 'a', title: 'Same Title' }),
      item({ id: 'a', title: 'Same Title' }), // dup id
      item({ id: 'b', title: 'same title' }), // dup title (case-insensitive)
      item({ id: 'c', title: 'Different' }),
    ];
    expect(dedupe(items)).toHaveLength(2);
  });
});

describe('scoreAndRank', () => {
  it('returns items sorted by descending score, limited to `limit`', () => {
    const items = [
      item({ id: 'old', title: 'Old AI news', publishedAt: new Date(NOW - 96 * 3600_000).toISOString() }),
      item({ id: 'hot', title: 'Hot AI news', engagement: { points: 500, comments: 200 } }),
      item({ id: 'mid', title: 'Mid AI news', engagement: { points: 20 } }),
    ];
    const ranked = scoreAndRank(items, ctx, { limit: 2, now: NOW });
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(ranked[1]!.score);
    expect(ranked[0]!.id).toBe('hot');
  });
});
