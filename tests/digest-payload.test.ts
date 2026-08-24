import { describe, expect, it } from 'vitest';

import { normalizeDigestPayload } from '@/server/trends/digest.service';

/**
 * Trend digests are stored as JSON, so rows written by older builds are missing
 * fields the current page reads. Reading `.length` on one of those threw during
 * render and took the whole AI Trend Insights page down with a bare error
 * screen. Normalizing must turn every historical shape into something
 * renderable.
 */
describe('normalizeDigestPayload', () => {
  it('fills in every array field for a payload from an older build', () => {
    const legacy = {
      items: [{ id: 'a', title: 'A' }],
      generatedAt: '2026-01-01T00:00:00.000Z',
      model: 'claude',
      sourceCounts: { reddit: 3 },
      // skippedSources / summary / hashtags / seasonal / competitorMentions absent
    };
    const p = normalizeDigestPayload(legacy);

    expect(p.skippedSources).toEqual([]);
    expect(p.recommendations).toEqual([]);
    expect(p.hashtags).toEqual([]);
    expect(p.seasonal).toEqual([]);
    expect(p.competitorMentions).toEqual([]);
    expect(p.items).toHaveLength(1);
    expect(p.model).toBe('claude');
  });

  it('survives null and undefined payloads', () => {
    for (const input of [null, undefined]) {
      const p = normalizeDigestPayload(input);
      expect(p.items).toEqual([]);
      expect(p.skippedSources).toEqual([]);
      expect(p.model).toBe('fallback');
    }
  });

  it('replaces non-array fields rather than trusting them', () => {
    const corrupt = {
      items: 'not-an-array',
      skippedSources: { reddit: true },
      hashtags: 42,
      generatedAt: 12345,
    };
    const p = normalizeDigestPayload(corrupt);

    expect(Array.isArray(p.items)).toBe(true);
    expect(p.items).toEqual([]);
    expect(p.skippedSources).toEqual([]);
    expect(p.hashtags).toEqual([]);
    // A non-string timestamp must still parse as a Date without throwing.
    expect(Number.isNaN(new Date(p.generatedAt).getTime())).toBe(false);
  });

  it('passes through a complete modern payload unchanged in substance', () => {
    const modern = {
      items: [{ id: 'x', title: 'X' }],
      generatedAt: '2026-08-01T00:00:00.000Z',
      model: 'claude-opus-4-8',
      sourceCounts: { reddit: 2, hackernews: 1 },
      skippedSources: ['twitter'],
      summary: 'A summary.',
      recommendations: ['Do a thing.'],
      hashtags: ['Marketing'],
      seasonal: [{ date: '2026-11-27', name: 'Black Friday', daysUntil: 10, angle: 'x' }],
      competitorMentions: [
        { competitor: 'Rival', itemId: 'x', title: 'X', url: 'u', sourceLabel: 's' },
      ],
    };
    const p = normalizeDigestPayload(modern);

    expect(p.skippedSources).toEqual(['twitter']);
    expect(p.summary).toBe('A summary.');
    expect(p.recommendations).toEqual(['Do a thing.']);
    expect(p.seasonal).toHaveLength(1);
    expect(p.competitorMentions).toHaveLength(1);
  });
});
