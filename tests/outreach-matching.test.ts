import { describe, it, expect } from 'vitest';
import {
  signalMatches,
  filterSignals,
  dedupeSignals,
  criteriaTerms,
} from '@/server/outreach/matching';
import {
  outreachConfigSchema,
  createLeadSchema,
} from '@/lib/validations/outreach';
import type { RawSignal, OutreachCriteria } from '@/server/outreach/types';

const criteria: OutreachCriteria = {
  industries: ['DevTools', 'fintech'],
  roleTitles: ['Head of Marketing'],
  companyStages: ['seed'],
  enabledSources: { crunchbase: false, github: true, jobs: true, news: true },
};

function sig(partial: Partial<RawSignal>): RawSignal {
  return {
    signalType: 'NEWS',
    companyName: 'Acme',
    description: '',
    matchedTerms: [],
    ...partial,
  };
}

describe('outreach matching — criteriaTerms', () => {
  it('flattens and lowercases all targeting terms', () => {
    expect(criteriaTerms(criteria)).toEqual([
      'devtools',
      'fintech',
      'head of marketing',
      'seed',
    ]);
  });
});

describe('outreach matching — signalMatches', () => {
  it('matches when a term appears in the description (case-insensitive)', () => {
    const r = signalMatches(
      sig({ description: 'A new DEVTOOLS platform raised seed funding' }),
      criteria,
    );
    expect(r.matched).toBe(true);
    expect(r.terms).toEqual(expect.arrayContaining(['devtools', 'seed']));
  });

  it('does not match when no term is present', () => {
    expect(signalMatches(sig({ description: 'a bakery opened' }), criteria).matched).toBe(false);
  });

  it('matches everything when no criteria are configured', () => {
    const empty: OutreachCriteria = {
      industries: [],
      roleTitles: [],
      companyStages: [],
      enabledSources: criteria.enabledSources,
    };
    expect(signalMatches(sig({ description: 'anything' }), empty).matched).toBe(true);
  });
});

describe('outreach matching — dedupeSignals', () => {
  it('dedupes by signalType + company (case-insensitive)', () => {
    const out = dedupeSignals([
      sig({ companyName: 'Acme', signalType: 'FUNDING' }),
      sig({ companyName: 'acme', signalType: 'FUNDING' }),
      sig({ companyName: 'Acme', signalType: 'HIRING' }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('outreach matching — filterSignals', () => {
  it('keeps only matching signals, annotates terms, and dedupes', () => {
    const out = filterSignals(
      [
        sig({ companyName: 'DevCo', description: 'devtools launch', signalType: 'NEWS' }),
        sig({ companyName: 'DevCo', description: 'devtools launch', signalType: 'NEWS' }),
        sig({ companyName: 'Bakery', description: 'bread', signalType: 'NEWS' }),
      ],
      criteria,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.matchedTerms).toContain('devtools');
  });
});

describe('outreach schemas', () => {
  it('dedupes list fields in the config schema', () => {
    const parsed = outreachConfigSchema.parse({
      industries: ['devtools', 'devtools', 'fintech'],
      roleTitles: [],
      companyStages: [],
    });
    expect(parsed.industries).toEqual(['devtools', 'fintech']);
    // enabledSources defaults are applied.
    expect(parsed.enabledSources.github).toBe(true);
  });

  it('requires a company name on a lead and normalizes the LinkedIn URL', () => {
    expect(createLeadSchema.safeParse({ companyName: '' }).success).toBe(false);
    const parsed = createLeadSchema.parse({
      companyName: 'Acme',
      linkedInProfileUrl: 'linkedin.com/in/jane',
    });
    expect(parsed.linkedInProfileUrl).toBe('https://linkedin.com/in/jane');
  });
});
