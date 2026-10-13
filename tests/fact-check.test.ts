import { describe, it, expect } from 'vitest';

import {
  checkFacts,
  claimsToReview,
  extractClaims,
  OUTDATED_AFTER_DAYS,
  type TrustedSource,
} from '@/lib/fact-check';

/**
 * Factual validation: every claim in a piece, checked against what Aura
 * trusts — supported, unverified, outdated, contradicted or unsupported.
 */

const NOW = new Date('2026-10-12T12:00:00Z');
const daysAgo = (d: number) =>
  new Date(NOW.getTime() - d * 86_400_000).toISOString();

const SOURCES: TrustedSource[] = [
  {
    label: 'your business profile',
    kind: 'business_profile',
    trusted: true,
    observedAt: null,
    stale: false,
    text: 'We roast single-origin coffee in small batches and sell coffee subscriptions online. A 250g bag of coffee costs $18.50.',
  },
  {
    label: 'evidence: Green coffee prices rose 30% this year',
    kind: 'evidence',
    trusted: true,
    observedAt: daysAgo(10),
    stale: false,
    text: 'Green coffee prices rose 30% this year as harvests shrank across the main origins.',
  },
  {
    label: 'evidence: Specialty coffee demand report',
    kind: 'evidence',
    trusted: true,
    observedAt: daysAgo(OUTDATED_AFTER_DAYS + 220),
    stale: false,
    text: 'Demand for specialty coffee grew 12% in 2023 among home brewers.',
  },
  {
    label: 'an unconfirmed detail (Shipping regions)',
    kind: 'assumption',
    trusted: false,
    observedAt: null,
    stale: false,
    text: 'We ship coffee subscriptions to Europe.',
  },
];

const POST = [
  'We roast single-origin coffee in small batches.',
  'Our 250g bag of coffee is still $18.50.',
  'Green coffee prices rose 15% this year as harvests shrank.',
  'Demand for specialty coffee grew 12% in 2023 among home brewers.',
  'We ship our coffee subscriptions to Europe.',
  'We are the only roaster in town with award-winning beans.',
  'Read the full story on our site.',
  'What would you pay for a fair cup?',
].join(' ');

const report = checkFacts({ text: POST, sources: SOURCES, now: NOW });
const claim = (start: string) =>
  report.claims.find((c) => c.text.startsWith(start))!;

describe('claims are extracted', () => {
  it('finds the checkable sentences, and leaves calls to action and questions alone', () => {
    const texts = extractClaims(POST).map((c) => c.text);
    expect(texts).toHaveLength(6);
    expect(texts.some((t) => t.startsWith('Read the full story'))).toBe(false);
    expect(texts.some((t) => t.endsWith('?'))).toBe(false);
  });

  it('knows what kind of claim each is', () => {
    expect(claim('Our 250g bag').kinds).toEqual(
      expect.arrayContaining(['number', 'business']),
    );
    expect(claim('Green coffee prices').kinds).toEqual(
      expect.arrayContaining(['number', 'market', 'date']),
    );
    expect(claim('We are the only').absolutes).toEqual(
      expect.arrayContaining(['only', 'award-winning']),
    );
  });
});

describe('each claim is checked against the trusted context', () => {
  it('supported by the business context', () => {
    expect(claim('We roast')).toMatchObject({
      status: 'supported',
      source: { kind: 'business_profile' },
    });
    expect(claim('Our 250g bag')).toMatchObject({ status: 'supported' });
  });

  it('a contradiction: 15% where the evidence says 30%', () => {
    expect(claim('Green coffee prices')).toMatchObject({
      status: 'contradicted',
      conflict: { claimed: '15%', source: '30%' },
    });
    expect(claim('Green coffee prices').reason).toMatch(
      /Says 15%, but evidence: .* says 30%/,
    );
  });

  it('possibly outdated: backed only by evidence seen long ago', () => {
    expect(claim('Demand for specialty coffee')).toMatchObject({
      status: 'outdated',
    });
    expect(claim('Demand for specialty coffee').reason).toMatch(
      /seen \d+ days ago/,
    );
  });

  it('unverified: only an unconfirmed detail backs it', () => {
    expect(claim('We ship')).toMatchObject({
      status: 'unverified',
      source: { kind: 'assumption' },
    });
  });

  it('unsupported: an absolute nothing backs', () => {
    expect(claim('We are the only')).toMatchObject({
      status: 'unsupported',
      source: null,
    });
    expect(claim('We are the only').reason).toMatch(
      /Nothing Aura trusts supports “(only|award-winning)”/,
    );
  });
});

describe('the report', () => {
  it('a contradiction makes the whole piece contradicted; counts add up', () => {
    expect(report.status).toBe('contradicted');
    expect(report.counts).toEqual({
      supported: 2,
      unverified: 1,
      outdated: 1,
      contradicted: 1,
      unsupported: 1,
    });
    expect(claimsToReview(report)).toHaveLength(4);
  });

  it('without the contradiction it needs review; with only supported claims it is verified', () => {
    const review = checkFacts({
      text: 'We ship our coffee subscriptions to Europe. We roast single-origin coffee in small batches.',
      sources: SOURCES,
      now: NOW,
    });
    expect(review.status).toBe('needs_review');
    const ok = checkFacts({
      text: 'We roast single-origin coffee in small batches. Our 250g bag of coffee is still $18.50.',
      sources: SOURCES,
      now: NOW,
    });
    expect(ok.status).toBe('verified');
  });

  it('nothing to check in copy with no claims', () => {
    expect(
      checkFacts({
        text: 'Pour yourself something good. Tell us your favourite brew!',
        sources: SOURCES,
        now: NOW,
      }).status,
    ).toBe('nothing_to_check');
  });

  it('a stale source never verifies a time-sensitive claim', () => {
    const stale = SOURCES.map((s) =>
      s.kind === 'evidence' ? { ...s, observedAt: daysAgo(5), stale: true } : s,
    );
    const r = checkFacts({
      text: 'Green coffee prices rose 30% this year as harvests shrank.',
      sources: stale,
      now: NOW,
    });
    expect(r.claims[0]).toMatchObject({ status: 'outdated' });
    expect(r.claims[0]!.reason).toMatch(/marked out of date/);
  });

  it('figures and absolutes nothing backs must be fixed; a plain statement can be vouched for', () => {
    expect(claim('Green coffee prices').mustFix).toBe(true); // contradiction
    expect(claim('We are the only').mustFix).toBe(true); // unsupported absolute
    expect(claim('We ship').mustFix).toBe(false); // unconfirmed statement
    expect(claim('Demand for specialty coffee').mustFix).toBe(false); // possibly outdated
    expect(report.mustFix).toBe(2);
    const plain = checkFacts({
      text: 'We deliver every Tuesday to local cafés.',
      sources: SOURCES,
      now: NOW,
    });
    expect(plain.claims[0]).toMatchObject({
      status: 'unsupported',
      mustFix: false,
    });
  });

  it('“first” is a claim only when it claims to be first', () => {
    const abs = (t: string) => extractClaims(t)[0]?.absolutes ?? [];
    expect(abs('We are the first roaster in town to sell subscriptions.')).toContain('first');
    expect(abs('We were first to ship compostable bags.')).toContain('first');
    expect(abs('We taste every batch first, then roast it.')).not.toContain('first');
    expect(abs('Our first batch of the season sold out.')).not.toContain('first');
  });

  it('says what it was checked against', () => {
    expect(report.checkedAgainst).toEqual(
      expect.arrayContaining([
        { kind: 'business_profile', count: 1 },
        { kind: 'evidence', count: 2 },
        { kind: 'assumption', count: 1 },
      ]),
    );
  });
});
