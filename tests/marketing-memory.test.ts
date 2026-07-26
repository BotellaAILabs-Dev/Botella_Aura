import { describe, it, expect } from 'vitest';
import {
  engagementScore,
  confidenceFromSample,
  hasEnoughData,
  MIN_SAMPLE_FOR_INSIGHTS,
} from '@/server/memory/metrics';
import { memoriesToPrompt } from '@/server/memory/memory.service';
import { analyzeDeterministic } from '@/server/memory/extraction.service';
import type { MarketingMemory } from '@prisma/client';
import type { ContentPerf } from '@/server/memory/performance.service';

const mem = (o: Partial<MarketingMemory>): MarketingMemory =>
  ({
    id: 'm',
    companyId: 'c',
    insightType: 'CONTENT_FORMAT',
    insight: 'Carousels win',
    confidence: 'HIGH',
    sampleSize: 20,
    supportingDataSummary: {},
    isActive: true,
    generatedAt: new Date(),
    createdAt: new Date(),
    ...o,
  }) as MarketingMemory;

const perf = (o: Partial<ContentPerf>): ContentPerf => ({
  draftId: 'd',
  title: 't',
  type: 'LINKEDIN_POST',
  snippet: 's',
  publishedAt: '2026-07-01T00:00:00.000Z',
  wordCount: 100,
  engagement: 10,
  metrics: {},
  ...o,
});

describe('memory metrics', () => {
  it('weights comments/reposts above likes', () => {
    expect(engagementScore({ likes: 10 })).toBe(10);
    expect(engagementScore({ comments: 10 })).toBe(30);
    expect(engagementScore({ reposts: 10 })).toBe(40);
  });
  it('derives confidence from sample size', () => {
    expect(confidenceFromSample(5)).toBe('LOW');
    expect(confidenceFromSample(20)).toBe('MEDIUM');
    expect(confidenceFromSample(40)).toBe('HIGH');
  });
  it('gates insight generation on enough data', () => {
    expect(hasEnoughData(MIN_SAMPLE_FOR_INSIGHTS - 1)).toBe(false);
    expect(hasEnoughData(MIN_SAMPLE_FOR_INSIGHTS)).toBe(true);
  });
});

describe('memoriesToPrompt (injection)', () => {
  it('returns empty string when there are no insights', () => {
    expect(memoriesToPrompt([])).toBe('');
  });
  it('skips the honest "insufficient data" note', () => {
    const insufficient = mem({ supportingDataSummary: { status: 'insufficient' } });
    expect(memoriesToPrompt([insufficient])).toBe('');
  });
  it('formats real insights with type + confidence', () => {
    const out = memoriesToPrompt([mem({})]);
    expect(out).toContain('[CONTENT_FORMAT]');
    expect(out).toContain('confidence: HIGH');
    expect(out).toContain('Carousels win');
  });
  it('filters by requested insight types', () => {
    const outreach = mem({ insightType: 'OUTREACH_APPROACH', insight: 'Short notes win' });
    expect(memoriesToPrompt([outreach], { types: ['CONTENT_FORMAT'] })).toBe('');
    expect(memoriesToPrompt([outreach], { types: ['OUTREACH_APPROACH'] })).toContain('Short notes win');
  });
});

describe('analyzeDeterministic (data-grounded, no fabrication)', () => {
  it('surfaces a format insight when one type clearly outperforms', () => {
    const data = [
      perf({ type: 'CAROUSEL', engagement: 100 }),
      perf({ type: 'CAROUSEL', engagement: 120 }),
      perf({ type: 'LINKEDIN_POST', engagement: 20 }),
      perf({ type: 'LINKEDIN_POST', engagement: 30 }),
    ];
    const insights = analyzeDeterministic(data);
    const fmt = insights.find((i) => i.insightType === 'CONTENT_FORMAT');
    expect(fmt).toBeDefined();
    expect(fmt!.insight).toMatch(/CAROUSEL/);
    expect(fmt!.basis).toMatch(/posts/);
  });
  it('emits NO format insight when engagement is flat (never guesses)', () => {
    const data = [
      perf({ type: 'CAROUSEL', engagement: 50 }),
      perf({ type: 'CAROUSEL', engagement: 50 }),
      perf({ type: 'LINKEDIN_POST', engagement: 50 }),
      perf({ type: 'LINKEDIN_POST', engagement: 50 }),
    ];
    const insights = analyzeDeterministic(data);
    expect(insights.find((i) => i.insightType === 'CONTENT_FORMAT')).toBeUndefined();
  });
  it('surfaces a length insight when short vs long differ clearly', () => {
    const data = [
      perf({ wordCount: 80, engagement: 100 }),
      perf({ wordCount: 90, engagement: 110 }),
      perf({ wordCount: 300, engagement: 20 }),
      perf({ wordCount: 320, engagement: 25 }),
    ];
    const insights = analyzeDeterministic(data);
    expect(insights.find((i) => i.insightType === 'CONTENT_LENGTH')).toBeDefined();
  });
});
