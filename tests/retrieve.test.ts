import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Knowledge retrieval test with the DB mocked — verifies keyword relevance
 * ranking, the source-weight boost, and the "fall back to recent" behavior when
 * nothing matches the query.
 */
const findMany = vi.fn();
vi.mock('@/lib/db', () => ({
  db: { knowledgeChunk: { findMany: () => findMany() } },
}));

import { retrieve } from '@/server/knowledge/retrieve';

const NOW = Date.parse('2026-07-23T12:00:00Z');

function chunk(over: Partial<{ id: string; content: string; sourceType: string; title: string | null; createdAt: Date }>) {
  return {
    id: over.id ?? 'c',
    companyId: 'co',
    sourceType: over.sourceType ?? 'WEBSITE',
    sourceUrl: null,
    title: over.title ?? null,
    content: over.content ?? '',
    tokenCount: 10,
    createdAt: over.createdAt ?? new Date(NOW),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('retrieve', () => {
  it('ranks chunks that match the query above those that do not', async () => {
    findMany.mockResolvedValue([
      chunk({ id: 'match', content: 'Our pricing model is usage-based and fair for SaaS teams.' }),
      chunk({ id: 'nomatch', content: 'A recipe for sourdough bread.' }),
    ]);
    const results = await retrieve('co', 'usage-based pricing for saas', {
      now: NOW,
      limit: 5,
    });
    expect(results[0]!.id).toBe('match');
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it('boosts past posts over website chunks at equal relevance', async () => {
    findMany.mockResolvedValue([
      chunk({ id: 'web', sourceType: 'WEBSITE', content: 'pricing pricing' }),
      chunk({ id: 'post', sourceType: 'PAST_POST', content: 'pricing pricing' }),
    ]);
    const results = await retrieve('co', 'pricing', { now: NOW, limit: 5 });
    expect(results[0]!.id).toBe('post');
  });

  it('falls back to recent chunks when nothing matches the query', async () => {
    findMany.mockResolvedValue([
      chunk({ id: 'a', content: 'unrelated content one' }),
      chunk({ id: 'b', content: 'unrelated content two' }),
    ]);
    const results = await retrieve('co', 'zzz nonexistent term qqq', {
      now: NOW,
      limit: 5,
    });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.score === 0)).toBe(true);
  });

  it('returns nothing for an empty knowledge base', async () => {
    findMany.mockResolvedValue([]);
    expect(await retrieve('co', 'anything', { now: NOW })).toEqual([]);
  });
});
