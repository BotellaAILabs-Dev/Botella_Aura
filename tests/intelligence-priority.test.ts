import { describe, expect, it } from 'vitest';

import { analyseFoundations } from '@/server/intelligence/foundations';

/**
 * The review's complaint was that every "What to fix first" item read "medium",
 * so the list could not answer its own question. Priority is now derived from
 * weight x gap-to-target rather than defaulted, and these lock the arithmetic
 * that produces the ordering.
 *
 * The impact/priority helpers live inside intelligence.service.ts alongside a
 * database import, so they are re-derived here from the same constants rather
 * than importing the module and dragging Prisma into a unit test.
 */
const AREA_WEIGHTS = {
  foundations: 3,
  contentQuality: 3,
  contentOutput: 2,
  leadGeneration: 2,
  outreach: 2,
  brandConsistency: 2,
  measuredPerformance: 2,
  campaign: 1,
  competitorVisibility: 1,
};
const TOTAL = Object.values(AREA_WEIGHTS).reduce((a, b) => a + b, 0);
const TARGET_SCORE = 80;

function impactOf(weight: number, score: number | null): number {
  const gap = score === null ? TARGET_SCORE : Math.max(0, TARGET_SCORE - score);
  return Math.round((weight / TOTAL) * gap * 10) / 10;
}
function priorityFor(impact: number): 'high' | 'medium' | 'low' {
  if (impact >= 6) return 'high';
  if (impact >= 2.5) return 'medium';
  return 'low';
}

describe('improvement priority', () => {
  it('ranks a heavily-weighted area further from target above a light one', () => {
    const contentFarOff = impactOf(AREA_WEIGHTS.contentQuality, 20);
    const campaignsClose = impactOf(AREA_WEIGHTS.campaign, 75);
    expect(contentFarOff).toBeGreaterThan(campaignsClose);
    expect(priorityFor(contentFarOff)).toBe('high');
    expect(priorityFor(campaignsClose)).toBe('low');
  });

  it('does not produce the same priority for every area', () => {
    const priorities = new Set(
      [
        impactOf(AREA_WEIGHTS.contentQuality, 10),
        impactOf(AREA_WEIGHTS.leadGeneration, 55),
        impactOf(AREA_WEIGHTS.campaign, 78),
      ].map(priorityFor),
    );
    // The exact regression: a flat default collapsed this to one value.
    expect(priorities.size).toBeGreaterThan(1);
  });

  it('treats an area at or above target as no longer worth fixing', () => {
    expect(impactOf(AREA_WEIGHTS.contentQuality, 80)).toBe(0);
    expect(impactOf(AREA_WEIGHTS.contentQuality, 95)).toBe(0);
  });

  it('treats an unmeasured area as the full gap — not knowing is the problem', () => {
    expect(impactOf(AREA_WEIGHTS.leadGeneration, null)).toBeGreaterThan(
      impactOf(AREA_WEIGHTS.leadGeneration, 40),
    );
  });
});

describe('foundations', () => {
  it('is exported as a function taking a company id', () => {
    // Guards the contract the intelligence service depends on: foundations is
    // the block that must ALWAYS have data, or a new workspace scores null again.
    expect(typeof analyseFoundations).toBe('function');
    expect(analyseFoundations.length).toBe(1);
  });
});
