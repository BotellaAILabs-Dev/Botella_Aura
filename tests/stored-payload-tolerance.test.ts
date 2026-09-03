import { describe, it, expect } from 'vitest';

import { readChangesSummary } from '@/server/competitors/types';

/**
 * Stored JSON is data, not a type.
 *
 * Two pages crashed with a 500 because a JSON column was CAST to an interface
 * and then trusted: `changesSummary as ChangesSummary` followed by
 * `summary.skipped.length`, on rows written before `skipped` existed. The cast
 * compiles — it just is not true.
 *
 * These pin the normaliser that fixes it. The rule they encode: anything read
 * out of a JSON column must survive being older, newer, partial or garbage,
 * because every one of those really happens.
 */
describe('readChangesSummary', () => {
  it('fills in arrays that a stored snapshot never had', () => {
    // Exactly the shape found in the database — no `skipped`, no `capturedAt`.
    const summary = readChangesSummary({
      news: [],
      model: 'claude-opus-4-8',
      homepage: 'Added an "AI Assistant" section to the homepage.',
      hasChanges: true,
    });
    expect(summary.skipped).toEqual([]);
    expect(summary.news).toEqual([]);
    expect(summary.homepage).toContain('AI Assistant');
    expect(summary.hasChanges).toBe(true);
  });

  it('makes .length safe on both arrays, which is what crashed the page', () => {
    const summary = readChangesSummary({});
    expect(() => summary.skipped.length).not.toThrow();
    expect(() => summary.news.length).not.toThrow();
    expect(summary.skipped.length).toBe(0);
  });

  it('never throws, whatever is in the column', () => {
    for (const raw of [null, undefined, 'text', 42, [], { news: 'not-an-array' }]) {
      expect(() => readChangesSummary(raw)).not.toThrow();
      expect(readChangesSummary(raw).news).toEqual([]);
    }
  });

  it('preserves real values rather than flattening everything to defaults', () => {
    const summary = readChangesSummary({
      hasChanges: true,
      homepage: 'changed',
      pricing: 'new tier',
      news: [{ title: 'Launch', url: 'https://example.com' }],
      skipped: ['github: no org configured'],
      model: 'claude-opus-4-8',
      capturedAt: '2026-09-01T00:00:00.000Z',
      isBaseline: true,
      baseline: { homepage: 'first capture' },
    });
    expect(summary.news).toHaveLength(1);
    expect(summary.skipped[0]).toContain('github');
    expect(summary.isBaseline).toBe(true);
    expect(summary.baseline?.homepage).toBe('first capture');
    expect(summary.capturedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('treats a missing hasChanges as false rather than truthy', () => {
    expect(readChangesSummary({}).hasChanges).toBe(false);
    expect(readChangesSummary({ hasChanges: 'yes' }).hasChanges).toBe(false);
  });

  it('defaults model to none so the UI never renders "undefined"', () => {
    expect(readChangesSummary({}).model).toBe('none');
  });
});
