import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/server/memory/performance.service', () => ({
  getContentPerformance: vi.fn().mockResolvedValue([]),
}));

import { learnTiming, nextOccurrence, recommendSlot } from '@/server/publishing/schedule.service';
import type { ContentPerf } from '@/server/memory/performance.service';
import { toLocalInput } from '@/lib/timezone';

/**
 * Suggested posting times are on the business's own clock. "Tuesday 09:00"
 * used to mean 09:00 UTC, which is 14:30 in India.
 */

const post = (publishedAt: string, engagement: number): ContentPerf => ({
  draftId: Math.random().toString(36).slice(2),
  title: 't',
  type: 'LINKEDIN_POST',
  snippet: 's',
  publishedAt,
  wordCount: 100,
  engagement,
  metrics: {},
});

const weekly = (iso: string, weeks: number, engagement: number) =>
  Array.from({ length: weeks }, (_, i) =>
    post(new Date(new Date(iso).getTime() + i * 7 * 86_400_000).toISOString(), engagement),
  );

describe('posting times in the workspace timezone', () => {
  it('learns the day and hour on the local clock', () => {
    // 20:00 UTC on a Monday is 01:30 Tuesday in India.
    const perf = [...weekly('2026-01-05T20:00:00Z', 5, 300), ...weekly('2026-01-08T04:00:00Z', 5, 40)];
    expect(learnTiming(perf)).toMatchObject({ weekday: 1, hour: 20 });
    expect(learnTiming(perf, 'Asia/Kolkata')).toMatchObject({ weekday: 2, hour: 1 });
  });

  it('puts the next Tuesday 09:00 at 09:00 in India, not 09:00 UTC', () => {
    const at = nextOccurrence(new Date('2026-11-02T00:00:00Z'), 2, 9, 'Asia/Kolkata');
    expect(at.toISOString()).toBe('2026-11-03T03:30:00.000Z');
    expect(toLocalInput(at, 'Asia/Kolkata')).toBe('2026-11-03T09:00');
  });

  it('goes to next week when this week’s slot has passed', () => {
    const at = nextOccurrence(new Date('2026-11-03T04:00:00Z'), 2, 9, 'Asia/Kolkata');
    expect(toLocalInput(at, 'Asia/Kolkata')).toBe('2026-11-10T09:00');
  });

  it('keeps the local hour across a clock change', () => {
    // UK clocks go back on Sunday 25 October 2026.
    const at = nextOccurrence(new Date('2026-10-23T12:00:00Z'), 2, 9, 'Europe/London');
    expect(toLocalInput(at, 'Europe/London')).toBe('2026-10-27T09:00');
    expect(at.toISOString()).toBe('2026-10-27T09:00:00.000Z');
  });

  it('spreads a batch out by local day, at the same local hour', async () => {
    const first = await recommendSlot({
      companyId: 'co1',
      platform: 'LINKEDIN',
      after: new Date('2026-11-02T00:00:00Z'),
      timeZone: 'Asia/Kolkata',
    });
    const second = await recommendSlot({
      companyId: 'co1',
      platform: 'LINKEDIN',
      after: new Date('2026-11-02T00:00:00Z'),
      taken: [first.at],
      timeZone: 'Asia/Kolkata',
    });
    expect(toLocalInput(first.at, 'Asia/Kolkata')).toBe('2026-11-03T09:00');
    expect(toLocalInput(second.at, 'Asia/Kolkata')).toBe('2026-11-04T09:00');
    expect(first.confidence).toBe('default');
  });
});
