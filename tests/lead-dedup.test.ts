import { describe, it, expect } from 'vitest';
import {
  normalize,
  jaccard,
  sameCompany,
  namesMatch,
  isSameLead,
  dedupeWithin,
  findExistingMatch,
} from '@/server/leads/discovery/dedup';
import { fitScoreSchema } from '@/lib/validations/discovery';
import { deterministicScore } from '@/server/leads/discovery/scoring';
import type { DiscoveredLead } from '@/server/leads/discovery/types';

function lead(p: Partial<DiscoveredLead>): DiscoveredLead {
  return { companyName: 'Acme', via: 'test', ...p };
}

describe('lead dedup — normalize/jaccard', () => {
  it('strips legal suffixes and punctuation', () => {
    expect(normalize('Acme, Inc.')).toBe('acme');
    expect(normalize('Foo-Bar LLC')).toBe('foo bar');
  });
  it('jaccard rewards token overlap', () => {
    expect(jaccard('Jane Doe', 'Jane Doe')).toBe(1);
    expect(jaccard('Jane Q Doe', 'Jane Doe')).toBeGreaterThan(0.5);
    expect(jaccard('Jane Doe', 'Bob Smith')).toBe(0);
  });
});

describe('lead dedup — matching', () => {
  it('sameCompany handles suffix + fuzzy variants', () => {
    expect(sameCompany('Acme Inc.', 'Acme')).toBe(true);
    expect(sameCompany('Acme Labs', 'Acme Labs Inc')).toBe(true);
    expect(sameCompany('Acme', 'Globex')).toBe(false);
  });
  it('namesMatch tolerates middle initials', () => {
    expect(namesMatch('Jane Q. Doe', 'Jane Doe')).toBe(true);
    expect(namesMatch('Jane Doe', 'John Doe')).toBe(false);
  });
});

describe('lead dedup — isSameLead', () => {
  it('two company-level leads at the same company are the same', () => {
    expect(isSameLead(lead({ companyName: 'Acme Inc' }), lead({ companyName: 'Acme' }))).toBe(true);
  });
  it('the same person at the same company is the same', () => {
    expect(
      isSameLead(lead({ name: 'Jane Doe', companyName: 'Acme' }), lead({ name: 'Jane Q Doe', companyName: 'Acme Inc' })),
    ).toBe(true);
  });
  it('different people at the same company are distinct', () => {
    expect(
      isSameLead(lead({ name: 'Jane Doe', companyName: 'Acme' }), lead({ name: 'Bob Smith', companyName: 'Acme' })),
    ).toBe(false);
  });
  it('a company-level lead and a named person are distinct (both kept)', () => {
    expect(isSameLead(lead({ companyName: 'Acme' }), lead({ name: 'Jane Doe', companyName: 'Acme' }))).toBe(false);
  });
  it('different companies never match', () => {
    expect(isSameLead(lead({ companyName: 'Acme' }), lead({ companyName: 'Globex' }))).toBe(false);
  });
});

describe('lead dedup — batch + existing', () => {
  it('collapses duplicates within a batch and prefers richer fields', () => {
    const out = dedupeWithin([
      lead({ name: 'Jane Doe', companyName: 'Acme' }),
      lead({ name: 'Jane Doe', companyName: 'Acme Inc', title: 'CTO' }),
      lead({ companyName: 'Globex' }),
    ]);
    expect(out).toHaveLength(2);
    const jane = out.find((l) => l.name === 'Jane Doe')!;
    expect(jane.title).toBe('CTO');
  });
  it('finds a matching existing lead (no duplicate row)', () => {
    const existing = [{ id: 'l1', name: 'Jane Doe', companyName: 'Acme Inc' }];
    const match = findExistingMatch(lead({ name: 'Jane Doe', companyName: 'Acme' }), existing);
    expect(match?.id).toBe('l1');
  });
});

describe('fit scoring', () => {
  it('validates the fit-score schema (0-100 + rationale)', () => {
    expect(fitScoreSchema.safeParse({ fitScore: 80, fitRationale: 'good' }).success).toBe(true);
    expect(fitScoreSchema.safeParse({ fitScore: 120, fitRationale: 'x' }).success).toBe(false);
    expect(fitScoreSchema.safeParse({ fitScore: 50 }).success).toBe(false);
  });
  it('deterministic score rewards criteria overlap and never fabricates', () => {
    const crit = { industries: ['devtools'], roleTitles: ['CTO'], companyStages: [], geographies: [], keywords: [] };
    const strong = deterministicScore(crit, lead({ name: 'Jane', title: 'CTO', companyName: 'DevTools Co' }));
    const weak = deterministicScore(crit, lead({ companyName: 'Unrelated Bakery' }));
    expect(strong.fitScore).toBeGreaterThan(weak.fitScore);
    // A no-match lead must name the criteria it failed, not emit a generic
    // "no explicit criteria match" that gives the reviewer nothing to act on.
    expect(weak.fitRationale).toMatch(/no stated criterion matched/i);
    expect(weak.fitRationale).toContain('devtools');
    expect(weak.missed.length).toBeGreaterThan(0);
  });
});
