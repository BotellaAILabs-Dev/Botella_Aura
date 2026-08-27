import { describe, expect, it } from 'vitest';

import { deterministicScore } from '@/server/leads/discovery/scoring';
import type { DiscoveryCriteria } from '@/server/leads/discovery/types';
import type { DiscoveredLead } from '@/server/leads/discovery/types';

/**
 * The reported symptom was a whole page of leads scoring exactly 35/100 with
 * the same unhelpful note. That was the zero-match floor of the old formula
 * (`35 + hits * 15`), so these tests pin the two properties that actually
 * matter: different leads must get different scores, and a score must come
 * with the criteria behind it.
 */
function criteria(over: Partial<DiscoveryCriteria> = {}): DiscoveryCriteria {
  return {
    industries: [],
    companyStages: [],
    roleTitles: [],
    geographies: [],
    keywords: [],
    ...over,
  };
}

function lead(over: Partial<DiscoveredLead> = {}): DiscoveredLead {
  return { companyName: 'Acme Ltd', via: 'test', ...over };
}

describe('deterministicScore', () => {
  it('separates a full match from a partial one from no match at all', () => {
    const c = criteria({ industries: ['distillery'], roleTitles: ['marketing'] });

    const full = deterministicScore(
      c,
      lead({ companyName: 'Highland Distillery', title: 'Head of Marketing' }),
    );
    const partial = deterministicScore(
      c,
      lead({ companyName: 'Highland Distillery', title: 'Head of Finance' }),
    );
    const none = deterministicScore(c, lead({ companyName: 'Generic Corp' }));

    expect(full.fitScore).toBeGreaterThan(partial.fitScore);
    expect(partial.fitScore).toBeGreaterThan(none.fitScore);
    // The specific regression: no-match leads must not land on a shared floor.
    expect(none.fitScore).toBeLessThan(35);
  });

  it('reports which criteria matched and which did not', () => {
    const result = deterministicScore(
      criteria({ industries: ['distillery'], geographies: ['scotland'] }),
      lead({ companyName: 'Highland Distillery', evidence: 'Craft spirits' }),
    );

    expect(result.matched).toContain('distillery');
    expect(result.missed.join(' ')).toContain('scotland');
    expect(result.fitRationale).toContain('distillery');
  });

  it('weights a stated criterion by how much of it the lead matches', () => {
    const c = criteria({ industries: ['distillery', 'brewery', 'winery'] });
    const one = deterministicScore(c, lead({ companyName: 'A Distillery' }));
    const two = deterministicScore(
      c,
      lead({ companyName: 'A Distillery and Brewery' }),
    );
    expect(two.fitScore).toBeGreaterThan(one.fitScore);
  });

  it('says so rather than inventing a number when no criteria are set', () => {
    const result = deterministicScore(criteria(), lead());
    expect(result.fitScore).toBe(50);
    expect(result.fitRationale).toMatch(/no criteria/i);
    expect(result.matched).toEqual([]);
  });

  it('never leaves the 0-100 range', () => {
    const result = deterministicScore(
      criteria({
        industries: ['a'],
        roleTitles: ['b'],
        keywords: ['c'],
        companyStages: ['d'],
        geographies: ['e'],
      }),
      lead({ companyName: 'a b c d e', evidence: 'a b c d e' }),
    );
    expect(result.fitScore).toBeGreaterThanOrEqual(0);
    expect(result.fitScore).toBeLessThanOrEqual(100);
  });
});
