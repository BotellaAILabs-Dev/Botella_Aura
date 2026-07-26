import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  normalizeText,
  hashText,
  diffTexts,
  deterministicSummary,
} from '@/server/competitors/diff';
import { startOfIsoWeekUTC } from '@/server/competitors/report.service';

// crypto.sha256 needs a real key? No — lib/crypto.sha256 uses node:crypto hash.
// (encrypt/decrypt need ENCRYPTION_KEY, but hashText only uses sha256.)

describe('competitor diff — normalizeText', () => {
  it('collapses whitespace and drops empty lines', () => {
    expect(normalizeText('  Hello   world \n\n\n  Foo  ')).toBe('Hello world\nFoo');
  });

  it('treats cosmetic whitespace differences as identical', () => {
    expect(normalizeText('Price:   $10')).toBe(normalizeText('Price: $10'));
  });
});

describe('competitor diff — hashText', () => {
  it('is stable for equivalent normalized content', () => {
    expect(hashText('Plan A\nPlan B')).toBe(hashText('Plan A\n\n  Plan B  '));
  });
  it('changes when content changes', () => {
    expect(hashText('Plan A')).not.toBe(hashText('Plan B'));
  });
  it('matches a raw sha256 of the normalized text', () => {
    const norm = normalizeText('Hello  world');
    const expected = crypto.createHash('sha256').update(norm).digest('hex');
    expect(hashText('Hello  world')).toBe(expected);
  });
});

describe('competitor diff — diffTexts', () => {
  it('reports no change on the first capture (no previous)', () => {
    const d = diffTexts(null, 'Anything here');
    expect(d.changed).toBe(false);
    expect(d.added).toEqual([]);
  });

  it('reports no change for identical (whitespace-normalized) content', () => {
    const d = diffTexts('Free plan\nPro plan', 'Free plan\n\n  Pro plan');
    expect(d.changed).toBe(false);
  });

  it('detects added and removed lines', () => {
    const prev = 'Free plan\nPro $20/mo\nContact us';
    const next = 'Free plan\nPro $29/mo\nContact us\nNew: Enterprise plan';
    const d = diffTexts(prev, next);
    expect(d.changed).toBe(true);
    expect(d.added).toContain('Pro $29/mo');
    expect(d.added).toContain('New: Enterprise plan');
    expect(d.removed).toContain('Pro $20/mo');
  });

  it('bounds the sample size', () => {
    const prev = '';
    const next = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const d = diffTexts(prev, next, 10);
    expect(d.added.length).toBeLessThanOrEqual(10);
  });
});

describe('competitor diff — deterministicSummary', () => {
  it('summarizes counts and previews a changed line', () => {
    const summary = deterministicSummary('pricing page', {
      changed: true,
      added: ['Pro $29/mo'],
      removed: ['Pro $20/mo'],
    });
    expect(summary).toContain('pricing page');
    expect(summary).toContain('1 new line');
    expect(summary).toContain('1 line(s) removed');
    expect(summary).toContain('Pro $29/mo');
  });
});

describe('competitor report — startOfIsoWeekUTC', () => {
  it('returns the Monday 00:00 UTC of the containing week', () => {
    // 2026-07-22 is a Wednesday → week starts Monday 2026-07-20.
    const wed = new Date('2026-07-22T15:30:00.000Z');
    expect(startOfIsoWeekUTC(wed).toISOString()).toBe('2026-07-20T00:00:00.000Z');
  });

  it('handles Sunday as the last day of the ISO week', () => {
    // 2026-07-26 is a Sunday → week still starts Monday 2026-07-20.
    const sun = new Date('2026-07-26T09:00:00.000Z');
    expect(startOfIsoWeekUTC(sun).toISOString()).toBe('2026-07-20T00:00:00.000Z');
  });
});
