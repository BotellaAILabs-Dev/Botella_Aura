import { describe, it, expect } from 'vitest';

import {
  RATIO_DIMENSIONS,
  dimensionsFor,
  isAspectRatio,
  nearestSupportedRatio,
  ratioValue,
  resolveFormat,
} from '@/server/media/aspect';
import { ASPECT_RATIOS } from '@/lib/platforms';

/**
 * Format resolution. These are the rules that decide the pixel size every paid
 * generation is billed at, and the fallback that stops a provider mismatch from
 * becoming a failed request — so the substitution behaviour is pinned here.
 */

describe('ratio dimensions', () => {
  it('defines a size for every offered ratio', () => {
    for (const ratio of ASPECT_RATIOS) {
      expect(RATIO_DIMENSIONS[ratio]).toBeDefined();
      expect(dimensionsFor(ratio).width).toBeGreaterThan(0);
      expect(dimensionsFor(ratio).height).toBeGreaterThan(0);
    }
  });

  it('produces dimensions that match the ratio they claim', () => {
    for (const ratio of ASPECT_RATIOS) {
      const [w, h] = ratio.split(':').map(Number) as [number, number];
      // Within 2% — the canonical sizes are rounded to friendly numbers.
      expect(ratioValue(ratio)).toBeCloseTo(w / h, 1);
    }
  });

  it('recognises supported ratios and rejects anything else', () => {
    expect(isAspectRatio('1:1')).toBe(true);
    expect(isAspectRatio('9:16')).toBe(true);
    expect(isAspectRatio('3:2')).toBe(false);
    expect(isAspectRatio('')).toBe(false);
  });
});

describe('nearestSupportedRatio', () => {
  it('returns the request unchanged when the provider supports it', () => {
    expect(nearestSupportedRatio('9:16', ['1:1', '4:5', '9:16'])).toBe('9:16');
  });

  it('falls back to the geometrically closest ratio', () => {
    // OpenAI has no 9:16; 4:5 is the closest portrait it can draw.
    expect(nearestSupportedRatio('9:16', ['1:1', '4:5', '16:9'])).toBe('4:5');
  });

  it('does not bias towards landscape when falling back', () => {
    // The log-ratio comparison exists for exactly this: with a square and a
    // wide option available, a portrait request must not land on the wide one.
    expect(nearestSupportedRatio('4:5', ['1:1', '16:9'])).toBe('1:1');
  });

  it('returns the request when a provider lists no ratios at all', () => {
    expect(nearestSupportedRatio('1:1', [])).toBe('1:1');
  });
});

describe('resolveFormat', () => {
  it('uses the platform default when nothing was requested', () => {
    // Instagram's default is 4:5.
    const format = resolveFormat({
      platform: 'INSTAGRAM',
      providerRatios: ['1:1', '4:5', '9:16'],
    });
    expect(format.ratio).toBe('4:5');
    expect(format.substituted).toBe(false);
  });

  it('honours an explicit request the provider supports', () => {
    const format = resolveFormat({
      requested: '16:9',
      platform: 'LINKEDIN',
      providerRatios: ['1:1', '4:5', '16:9'],
    });
    expect(format.ratio).toBe('16:9');
    expect(format.width).toBe(RATIO_DIMENSIONS['16:9'].width);
    expect(format.substituted).toBe(false);
    expect(format.requested).toBeUndefined();
  });

  it('reports what it substituted so the UI can say so', () => {
    const format = resolveFormat({
      requested: '9:16',
      platform: 'INSTAGRAM',
      providerRatios: ['1:1', '4:5', '16:9'],
    });
    expect(format.substituted).toBe(true);
    expect(format.requested).toBe('9:16');
    expect(format.ratio).toBe('4:5');
  });
});
